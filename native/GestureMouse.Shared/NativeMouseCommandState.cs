using System.Globalization;

namespace GestureMouse.Shared;

internal enum NativeCommandResult
{
    Accepted,
    Rejected,
    StorageUnavailable,
    NativeOperationFailed,
}

internal sealed class NativeMouseCommandState
{
    private readonly object _gate = new();
    private readonly Action<int, int> _move;
    private readonly Action<bool> _setLeftButton;
    private readonly Action<int> _scroll;
    private readonly INativeSessionGenerationStore _generationStore;
    // The boot identity is part of every session token, so a process restart fences old tokens
    // even if the durable generation write from the previous process failed.
    private string _bootId = NewBootId();
    private string? _clientId;
    private string? _sessionId;
    private long _latestGeneration;
    private long _activeGeneration;
    private long _lastSequence;
    private bool _leftButtonDown;
    private bool _acceptingCommands = true;
    private bool _storageAvailable;
    private string? _storageFailure;

    public NativeMouseCommandState(
        Action<int, int> move,
        Action<bool> setLeftButton,
        Action<int> scroll,
        INativeSessionGenerationStore generationStore)
    {
        _move = move;
        _setLeftButton = setLeftButton;
        _scroll = scroll;
        _generationStore = generationStore;
        try
        {
            _latestGeneration = generationStore.Load();
            _storageAvailable = _latestGeneration >= 0;
            if (!_storageAvailable)
            {
                _storageFailure = "The saved generation is negative.";
            }
        }
        catch (Exception error)
        {
            _storageFailure = error.Message;
        }

        try
        {
            _setLeftButton(false);
            _leftButtonDown = false;
        }
        catch (Exception error)
        {
            _storageAvailable = false;
            _storageFailure = $"Native mouse release failed during startup: {error.Message}";
        }
    }

    public NativeCommandResult TryGetActivationChallenge(
        string clientId,
        out string bootId,
        out string generation,
        out string? failure)
    {
        lock (_gate)
        {
            bootId = _bootId;
            generation = string.Empty;
            failure = null;
            if (!_acceptingCommands || string.IsNullOrWhiteSpace(clientId))
            {
                return NativeCommandResult.Rejected;
            }
            if (!_storageAvailable)
            {
                failure = _storageFailure ?? "Native session storage is unavailable.";
                return NativeCommandResult.StorageUnavailable;
            }
            if (_latestGeneration == long.MaxValue)
            {
                FailClosed("The native session generation is exhausted.");
                bootId = _bootId;
                failure = _storageFailure;
                return NativeCommandResult.StorageUnavailable;
            }

            // Activation only accepts the next native-allocated generation, never a caller-chosen jump.
            generation = (_latestGeneration + 1).ToString(CultureInfo.InvariantCulture);
            return NativeCommandResult.Accepted;
        }
    }

    public NativeCommandResult TryActivate(
        string clientId,
        string bootId,
        string generation,
        string sessionId,
        out string? failure)
    {
        lock (_gate)
        {
            failure = null;
            if (!_acceptingCommands
                || !_storageAvailable
                || string.IsNullOrWhiteSpace(clientId)
                || !string.Equals(bootId, _bootId, StringComparison.Ordinal)
                || !TryParseGeneration(generation, out var requestedGeneration)
                || _latestGeneration == long.MaxValue
                || requestedGeneration != _latestGeneration + 1
                || string.IsNullOrWhiteSpace(sessionId))
            {
                if (!_storageAvailable)
                {
                    failure = _storageFailure;
                }
                return _storageAvailable
                    ? NativeCommandResult.Rejected
                    : NativeCommandResult.StorageUnavailable;
            }

            InvalidateSession(releaseButton: true);
            try
            {
                _generationStore.Save(requestedGeneration);
            }
            catch (Exception error)
            {
                FailClosed(error.Message, releaseButton: false);
                failure = _storageFailure;
                return NativeCommandResult.StorageUnavailable;
            }

            _latestGeneration = requestedGeneration;
            _clientId = clientId;
            _sessionId = sessionId;
            _activeGeneration = requestedGeneration;
            _lastSequence = 0;
            return NativeCommandResult.Accepted;
        }
    }

    public bool TryValidate(string clientId, string bootId, string generation, string sessionId)
    {
        lock (_gate)
        {
            return _acceptingCommands
                && _storageAvailable
                && TryParseGeneration(generation, out var parsedGeneration)
                && parsedGeneration == _activeGeneration
                && string.Equals(bootId, _bootId, StringComparison.Ordinal)
                && string.Equals(clientId, _clientId, StringComparison.Ordinal)
                && string.Equals(sessionId, _sessionId, StringComparison.Ordinal)
                && !string.IsNullOrWhiteSpace(_sessionId);
        }
    }

    public NativeCommandResult TryMove(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        int x,
        int y) =>
        TryMove(bootId, generation, sessionId, sequence, x, y, out _);

    public NativeCommandResult TryMove(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        int x,
        int y,
        out string? failure) =>
        TryCommand(bootId, generation, sessionId, sequence, out failure, () => _move(x, y));

    public NativeCommandResult TrySetLeftButton(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        bool pressed) =>
        TrySetLeftButton(bootId, generation, sessionId, sequence, pressed, out _);

    public NativeCommandResult TrySetLeftButton(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        bool pressed,
        out string? failure) =>
        TryCommand(
            bootId,
            generation,
            sessionId,
            sequence,
            out failure,
            () => SetLeftButtonCore(pressed, forceRelease: !pressed));

    public NativeCommandResult TryScroll(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        int delta) =>
        TryScroll(bootId, generation, sessionId, sequence, delta, out _);

    public NativeCommandResult TryScroll(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        int delta,
        out string? failure) =>
        TryCommand(bootId, generation, sessionId, sequence, out failure, () => _scroll(delta));

    public NativeCommandResult TryStop(
        string clientId,
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        out string? failure)
    {
        lock (_gate)
        {
            failure = null;
            var matchesActiveSession = _sessionId is not null
                && string.Equals(clientId, _clientId, StringComparison.Ordinal)
                && string.Equals(sessionId, _sessionId, StringComparison.Ordinal)
                && TryParseGeneration(generation, out var requestedActiveGeneration)
                && requestedActiveGeneration == _activeGeneration
                && sequence > _lastSequence;
            var cancelsPendingActivation = (_sessionId is null
                    || !string.Equals(sessionId, _sessionId, StringComparison.Ordinal))
                && TryParseGeneration(generation, out var requestedNextGeneration)
                && _latestGeneration < long.MaxValue
                && requestedNextGeneration == _latestGeneration + 1;
            if (!_acceptingCommands
                || !_storageAvailable
                || string.IsNullOrWhiteSpace(clientId)
                || !string.Equals(bootId, _bootId, StringComparison.Ordinal)
                || string.IsNullOrWhiteSpace(sessionId)
                || sequence <= 0
                || (!matchesActiveSession && !cancelsPendingActivation))
            {
                if (!_storageAvailable)
                {
                    failure = _storageFailure;
                }
                return _storageAvailable
                    ? NativeCommandResult.Rejected
                    : NativeCommandResult.StorageUnavailable;
            }

            if (_latestGeneration == long.MaxValue)
            {
                FailClosed("The native session generation is exhausted.");
                failure = _storageFailure;
                return NativeCommandResult.StorageUnavailable;
            }

            var stoppedGeneration = _latestGeneration + 1;
            var releaseAttempted = matchesActiveSession || _sessionId is null;
            string? releaseFailure = null;
            if (releaseAttempted)
            {
                InvalidateSession(releaseButton: false);
                try
                {
                    SetLeftButtonCore(false, forceRelease: true);
                }
                catch (Exception error)
                {
                    releaseFailure = $"Native mouse release failed: {error.Message}";
                    _bootId = NewBootId();
                    _storageAvailable = false;
                    _storageFailure = releaseFailure;
                }
            }

            try
            {
                _generationStore.Save(stoppedGeneration);
            }
            catch (Exception error)
            {
                if (releaseFailure is not null)
                {
                    failure = $"{releaseFailure} Generation persistence also failed: {error.Message}";
                    _storageFailure = failure;
                    return NativeCommandResult.NativeOperationFailed;
                }

                FailClosed(error.Message, releaseButton: false);
                failure = _storageFailure;
                return NativeCommandResult.StorageUnavailable;
            }

            _latestGeneration = stoppedGeneration;
            if (releaseFailure is not null)
            {
                failure = releaseFailure;
                return NativeCommandResult.NativeOperationFailed;
            }

            if (_sessionId is null)
            {
                _lastSequence = sequence;
            }
            return NativeCommandResult.Accepted;
        }
    }

    public NativeCommandResult TryRecoverStorage(out string? failure)
    {
        lock (_gate)
        {
            failure = null;
            if (!_acceptingCommands)
            {
                failure = "The native command bridge is shutting down.";
                return NativeCommandResult.StorageUnavailable;
            }
            if (_storageAvailable)
            {
                return NativeCommandResult.Accepted;
            }

            try
            {
                InvalidateSession(releaseButton: true);
                _bootId = NewBootId();
                _storageAvailable = false;

                long recoveredGeneration;
                try
                {
                    recoveredGeneration = _generationStore.Load();
                }
                catch (InvalidDataException)
                {
                    _generationStore.ResetCorruptData();
                    recoveredGeneration = 0;
                }

                if (recoveredGeneration < 0 || recoveredGeneration == long.MaxValue)
                {
                    _generationStore.ResetCorruptData();
                    recoveredGeneration = 0;
                }

                _generationStore.Save(recoveredGeneration);
                _latestGeneration = recoveredGeneration;
                _storageFailure = null;
                _storageAvailable = true;
                return NativeCommandResult.Accepted;
            }
            catch (Exception error)
            {
                _bootId = NewBootId();
                _storageAvailable = false;
                _storageFailure = error.Message;
                failure = _storageFailure;
                return NativeCommandResult.StorageUnavailable;
            }
        }
    }

    public void StopAcceptingCommands()
    {
        lock (_gate)
        {
            _acceptingCommands = false;
            InvalidateSession(releaseButton: true);
        }
    }

    public void ReleaseButtons()
    {
        lock (_gate)
        {
            SetLeftButtonCore(false, forceRelease: true);
        }
    }

    private NativeCommandResult TryCommand(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        out string? failure,
        Action sideEffect)
    {
        lock (_gate)
        {
            failure = null;
            if (!_storageAvailable)
            {
                failure = _storageFailure;
                return NativeCommandResult.StorageUnavailable;
            }
            if (!_acceptingCommands
                || !string.Equals(bootId, _bootId, StringComparison.Ordinal)
                || !TryParseGeneration(generation, out var parsedGeneration)
                || parsedGeneration != _activeGeneration
                || string.IsNullOrWhiteSpace(_sessionId)
                || !string.Equals(sessionId, _sessionId, StringComparison.Ordinal)
                || sequence <= _lastSequence)
            {
                return NativeCommandResult.Rejected;
            }

            _lastSequence = sequence;
            try
            {
                sideEffect();
            }
            catch (Exception error)
            {
                failure = FailClosedAfterNativeFailure(error);
                return NativeCommandResult.NativeOperationFailed;
            }
            return NativeCommandResult.Accepted;
        }
    }

    private string FailClosedAfterNativeFailure(Exception operationError)
    {
        _clientId = null;
        _sessionId = null;
        _activeGeneration = 0;
        _lastSequence = 0;
        _bootId = NewBootId();
        _storageAvailable = false;
        var failure = $"Native mouse operation failed: {operationError.Message}";
        _storageFailure = failure;

        try
        {
            SetLeftButtonCore(false, forceRelease: true);
        }
        catch (Exception cleanupError)
        {
            _leftButtonDown = true;
            failure += $" Best-effort mouse-button release also failed: {cleanupError.Message}";
            _storageFailure = failure;
        }

        return failure;
    }

    private void InvalidateSession(bool releaseButton)
    {
        _clientId = null;
        _sessionId = null;
        _activeGeneration = 0;
        _lastSequence = 0;
        if (releaseButton)
        {
            try
            {
                SetLeftButtonCore(false, forceRelease: true);
            }
            catch (Exception error)
            {
                _bootId = NewBootId();
                _storageAvailable = false;
                _storageFailure = $"Native mouse release failed: {error.Message}";
                throw;
            }
        }
    }

    private void FailClosed(string failure, bool releaseButton = true)
    {
        InvalidateSession(releaseButton);
        _bootId = NewBootId();
        _storageAvailable = false;
        _storageFailure = failure;
    }

    private void SetLeftButtonCore(bool pressed, bool forceRelease = false)
    {
        if (_leftButtonDown == pressed && !(forceRelease && !pressed))
        {
            return;
        }

        if (pressed || forceRelease)
        {
            _leftButtonDown = true;
        }

        _setLeftButton(pressed);
        _leftButtonDown = pressed;
    }

    private static bool TryParseGeneration(string value, out long generation) =>
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out generation)
        && generation > 0
        && generation.ToString(CultureInfo.InvariantCulture) == value;

    private static string NewBootId() => Guid.NewGuid().ToString("N");
}
