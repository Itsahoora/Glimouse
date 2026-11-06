using System.Globalization;
using GestureMouse.Shared;

void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

void AssertResult(NativeCommandResult actual, NativeCommandResult expected, string message) =>
    Assert(actual == expected, $"{message} (expected {expected}, got {actual}).");

var actions = new List<string>();
var store = new TestGenerationStore();
var state = CreateState(store, actions);
var session = Activate(state, "client", "session-1");
Assert(state.TryMove(session.BootId, session.Generation, session.SessionId, 1, 10, 20)
       == NativeCommandResult.Accepted,
    "A current move must succeed.");
Assert(state.TrySetLeftButton(session.BootId, session.Generation, session.SessionId, 2, true)
       == NativeCommandResult.Accepted,
    "A current press must succeed.");
Assert(state.TrySetLeftButton(session.BootId, session.Generation, session.SessionId, 3, false)
       == NativeCommandResult.Accepted,
    "A current release must succeed.");
Assert(state.TryScroll(session.BootId, session.Generation, session.SessionId, 4, 120)
       == NativeCommandResult.Accepted,
    "A current scroll must succeed.");
Assert(state.TryMove(session.BootId, session.Generation, session.SessionId, 4, 11, 21)
       == NativeCommandResult.Rejected,
    "An out-of-order move must be rejected.");
Assert(state.TryMove(session.BootId, session.Generation, session.SessionId, 5, 12, 22)
       == NativeCommandResult.Accepted,
    "A newer move must succeed.");
Assert(state.TryScroll(session.BootId, session.Generation, session.SessionId, 4, 120)
       == NativeCommandResult.Rejected,
    "An out-of-order scroll must be rejected.");
Assert(state.TrySetLeftButton(session.BootId, session.Generation, session.SessionId, 2, true)
       == NativeCommandResult.Rejected,
    "A stale press must be rejected.");
AssertResult(
    state.TryStop("client", session.BootId, session.Generation, session.SessionId, 6, out _),
    NativeCommandResult.Accepted,
    "A current stop must succeed.");
Assert(state.TryMove(session.BootId, session.Generation, session.SessionId, 7, 30, 40)
       == NativeCommandResult.Rejected,
    "A delayed move after stop must be rejected.");
var second = Activate(state, "client", "session-2");
Assert(state.TryMove(second.BootId, second.Generation, second.SessionId, 1, 25, 35)
       == NativeCommandResult.Accepted,
    "A fresh generation must accept its first command.");
Assert(state.TryMove(session.BootId, session.Generation, session.SessionId, 6, 50, 60)
       == NativeCommandResult.Rejected,
    "A prior session must be rejected.");
Assert(state.TryActivate("client", session.BootId, session.Generation, "late-session", out _)
       == NativeCommandResult.Rejected,
    "A prior-process activation must not be accepted.");

var moveFailureOperations = new TestNativeOperations
{
    MoveFailure = new InvalidOperationException("cursor operation failed"),
};
var moveFailureState = CreateFaultState(new TestGenerationStore(), moveFailureOperations);
var moveFailureSession = Activate(moveFailureState, "client", "move-failure-session");
AssertResult(
    moveFailureState.TryMove(
        moveFailureSession.BootId,
        moveFailureSession.Generation,
        moveFailureSession.SessionId,
        1,
        10,
        20,
        out var moveFailure),
    NativeCommandResult.NativeOperationFailed,
    "A cursor operation exception must return a native-operation failure.");
Assert(moveFailure?.Contains("cursor operation failed", StringComparison.Ordinal) == true,
    "The cursor failure must be reported accurately.");
Assert(moveFailureOperations.Actions[^1] == "up",
    "Cursor failure cleanup must release the button before returning.");
Assert(!moveFailureState.TryValidate(
    "client", moveFailureSession.BootId, moveFailureSession.Generation, moveFailureSession.SessionId),
    "Cursor failure must invalidate the active session immediately.");
AssertResult(
    moveFailureState.TryMove(
        moveFailureSession.BootId,
        moveFailureSession.Generation,
        moveFailureSession.SessionId,
        2,
        11,
        21),
    NativeCommandResult.StorageUnavailable,
    "No later command may run after a cursor operation failure.");
AssertResult(
    moveFailureState.TryGetActivationChallenge("client", out _, out _, out _),
    NativeCommandResult.StorageUnavailable,
    "Native-operation failure must require explicit recovery.");
AssertResult(moveFailureState.TryRecoverStorage(out _), NativeCommandResult.Accepted,
    "The existing explicit recovery operation must restore availability.");
var recoveredMoveChallenge = Challenge(moveFailureState, "client");
Assert(recoveredMoveChallenge.BootId != moveFailureSession.BootId,
    "Recovery after a native-operation failure must rotate the boot identity.");
moveFailureOperations.MoveFailure = null;
AssertResult(
    moveFailureState.TryMove(
        moveFailureSession.BootId,
        moveFailureSession.Generation,
        moveFailureSession.SessionId,
        2,
        12,
        22),
    NativeCommandResult.Rejected,
    "Recovery must not revive the credentials from the failed session.");
var postRecoveryMoveSession = Activate(moveFailureState, "client", "post-recovery-session");
AssertResult(
    moveFailureState.TryMove(
        postRecoveryMoveSession.BootId,
        postRecoveryMoveSession.Generation,
        postRecoveryMoveSession.SessionId,
        1,
        12,
        22),
    NativeCommandResult.Accepted,
    "A newly activated session must operate after successful recovery.");

var scrollFailureOperations = new TestNativeOperations
{
    ScrollFailure = new InvalidOperationException("scroll operation failed"),
};
var scrollFailureState = CreateFaultState(new TestGenerationStore(), scrollFailureOperations);
var scrollFailureSession = Activate(scrollFailureState, "client", "scroll-failure-session");
AssertResult(
    scrollFailureState.TryScroll(
        scrollFailureSession.BootId,
        scrollFailureSession.Generation,
        scrollFailureSession.SessionId,
        1,
        120,
        out var scrollFailure),
    NativeCommandResult.NativeOperationFailed,
    "A scroll operation exception must fail closed.");
Assert(scrollFailure?.Contains("scroll operation failed", StringComparison.Ordinal) == true,
    "The scroll failure must be reported accurately.");
Assert(scrollFailureOperations.Actions[^1] == "up",
    "Scroll failure cleanup must be attempted before returning.");
AssertResult(
    scrollFailureState.TryScroll(
        scrollFailureSession.BootId,
        scrollFailureSession.Generation,
        scrollFailureSession.SessionId,
        2,
        120),
    NativeCommandResult.StorageUnavailable,
    "A failed scroll must not leave the old session usable.");

var pressFailureOperations = new TestNativeOperations
{
    PressFailure = new InvalidOperationException("press operation failed after side effect"),
};
var pressFailureState = CreateFaultState(new TestGenerationStore(), pressFailureOperations);
var pressFailureSession = Activate(pressFailureState, "client", "press-failure-session");
AssertResult(
    pressFailureState.TrySetLeftButton(
        pressFailureSession.BootId,
        pressFailureSession.Generation,
        pressFailureSession.SessionId,
        1,
        true,
        out var pressFailure),
    NativeCommandResult.NativeOperationFailed,
    "A partially successful press that throws must fail closed.");
Assert(pressFailure?.Contains("press operation failed after side effect", StringComparison.Ordinal) == true,
    "The partial press failure must be reported.");
Assert(pressFailureOperations.Actions.TakeLast(2).SequenceEqual(["down", "up"]),
    "The state machine must account for a partial press and immediately release it.");
Assert(!pressFailureOperations.ButtonDown,
    "Successful best-effort cleanup must leave the simulated button released.");
Assert(!pressFailureState.TryValidate(
    "client", pressFailureSession.BootId, pressFailureSession.Generation, pressFailureSession.SessionId),
    "A failed press must invalidate the session before returning.");

var releaseFailureOperations = new TestNativeOperations();
var releaseFailureState = CreateFaultState(new TestGenerationStore(), releaseFailureOperations);
var releaseFailureSession = Activate(releaseFailureState, "client", "release-failure-session");
AssertResult(
    releaseFailureState.TrySetLeftButton(
        releaseFailureSession.BootId,
        releaseFailureSession.Generation,
        releaseFailureSession.SessionId,
        1,
        true),
    NativeCommandResult.Accepted,
    "The release-failure scenario must first press successfully.");
releaseFailureOperations.ReleaseFailuresRemaining = 1;
AssertResult(
    releaseFailureState.TrySetLeftButton(
        releaseFailureSession.BootId,
        releaseFailureSession.Generation,
        releaseFailureSession.SessionId,
        2,
        false,
        out var releaseFailure),
    NativeCommandResult.NativeOperationFailed,
    "A failed release must be reported even if immediate cleanup succeeds.");
Assert(releaseFailure?.Contains("release operation failed", StringComparison.Ordinal) == true,
    "The original release failure must be reported accurately.");
Assert(releaseFailureOperations.Actions.TakeLast(2).SequenceEqual(["up", "up"]),
    "A failed release must be followed by immediate best-effort cleanup.");
Assert(!releaseFailureOperations.ButtonDown,
    "Successful cleanup after a failed release must release the simulated button.");
AssertResult(
    releaseFailureState.TryMove(
        releaseFailureSession.BootId,
        releaseFailureSession.Generation,
        releaseFailureSession.SessionId,
        3,
        5,
        6),
    NativeCommandResult.StorageUnavailable,
    "A failed release must leave the bridge unavailable.");

var cleanupFailureOperations = new TestNativeOperations
{
    PressFailure = new InvalidOperationException("partial press failed"),
};
var cleanupFailureState = CreateFaultState(new TestGenerationStore(), cleanupFailureOperations);
var cleanupFailureSession = Activate(cleanupFailureState, "client", "cleanup-failure-session");
cleanupFailureOperations.AlwaysFailRelease = true;
AssertResult(
    cleanupFailureState.TrySetLeftButton(
        cleanupFailureSession.BootId,
        cleanupFailureSession.Generation,
        cleanupFailureSession.SessionId,
        1,
        true,
        out var cleanupFailure),
    NativeCommandResult.NativeOperationFailed,
    "A failed cleanup release must not escape the state machine.");
Assert(cleanupFailure?.Contains("partial press failed", StringComparison.Ordinal) == true
       && cleanupFailure.Contains("cleanup release failed", StringComparison.Ordinal),
    "The response must report both the original and cleanup failures.");
Assert(cleanupFailureOperations.ButtonDown,
    "A failed operating-system release must not be reported as physically successful.");
Assert(!cleanupFailureState.TryValidate(
    "client", cleanupFailureSession.BootId, cleanupFailureSession.Generation, cleanupFailureSession.SessionId),
    "Cleanup failure must not restore the old session.");
AssertResult(
    cleanupFailureState.TryMove(
        cleanupFailureSession.BootId,
        cleanupFailureSession.Generation,
        cleanupFailureSession.SessionId,
        2,
        7,
        8),
    NativeCommandResult.StorageUnavailable,
    "Commands must remain unavailable after cleanup failure.");
var releasesBeforeRecovery = cleanupFailureOperations.Actions.Count(action => action == "up");
AssertResult(
    cleanupFailureState.TryRecoverStorage(out var firstRecoveryFailure),
    NativeCommandResult.StorageUnavailable,
    "Explicit recovery must retry cleanup and remain unavailable if release still fails.");
Assert(firstRecoveryFailure?.Contains("cleanup release failed", StringComparison.Ordinal) == true,
    "Recovery must report the outstanding cleanup failure.");
Assert(cleanupFailureOperations.Actions.Count(action => action == "up") > releasesBeforeRecovery,
    "Recovery must attempt button release again.");
AssertResult(
    cleanupFailureState.TryRecoverStorage(out _),
    NativeCommandResult.StorageUnavailable,
    "Repeated failed recovery cleanup must remain safe and fail closed.");
cleanupFailureOperations.AlwaysFailRelease = false;
AssertResult(
    cleanupFailureState.TryRecoverStorage(out _),
    NativeCommandResult.Accepted,
    "Storage recovery must succeed only after button release can be confirmed.");
Assert(!cleanupFailureOperations.ButtonDown,
    "Successful explicit recovery must release the previously uncertain button state.");

var nativeStopFailureStore = new TestGenerationStore();
var nativeStopFailureOperations = new TestNativeOperations();
var nativeStopFailureState = CreateFaultState(nativeStopFailureStore, nativeStopFailureOperations);
var nativeStopFailureSession = Activate(nativeStopFailureState, "client", "stop-release-failure-session");
AssertResult(
    nativeStopFailureState.TrySetLeftButton(
        nativeStopFailureSession.BootId,
        nativeStopFailureSession.Generation,
        nativeStopFailureSession.SessionId,
        1,
        true),
    NativeCommandResult.Accepted,
    "The stop release-failure scenario must first press successfully.");
nativeStopFailureOperations.ReleaseFailuresRemaining = 1;
AssertResult(
    nativeStopFailureState.TryStop(
        "client",
        nativeStopFailureSession.BootId,
        nativeStopFailureSession.Generation,
        nativeStopFailureSession.SessionId,
        2,
        out var stopReleaseFailure),
    NativeCommandResult.NativeOperationFailed,
    "A native release exception during stop must return a structured operation failure.");
Assert(stopReleaseFailure?.Contains("release operation failed", StringComparison.Ordinal) == true,
    "The stop response must report the release failure.");
Assert(!nativeStopFailureState.TryValidate(
    "client",
    nativeStopFailureSession.BootId,
    nativeStopFailureSession.Generation,
    nativeStopFailureSession.SessionId),
    "Stop must invalidate the session before returning a release failure.");
Assert(nativeStopFailureOperations.Actions[^1] == "up" && nativeStopFailureOperations.ButtonDown,
    "A failed stop release must remain marked uncertain rather than claiming the button is up.");
AssertResult(
    nativeStopFailureState.TryMove(
        nativeStopFailureSession.BootId,
        nativeStopFailureSession.Generation,
        nativeStopFailureSession.SessionId,
        3,
        1,
        1),
    NativeCommandResult.StorageUnavailable,
    "The bridge must remain unavailable after stop release failure.");
AssertResult(
    nativeStopFailureState.TryRecoverStorage(out _),
    NativeCommandResult.Accepted,
    "Explicit recovery may restore service after confirmed button release.");
Assert(!nativeStopFailureOperations.ButtonDown,
    "Explicit recovery must release the button before restoring service.");
AssertResult(
    nativeStopFailureState.TryActivate(
        "client",
        nativeStopFailureSession.BootId,
        nativeStopFailureSession.Generation,
        "replayed-stopped-session",
        out _),
    NativeCommandResult.Rejected,
    "Recovery after failed stop must not revive the old session credentials.");

var doubleStopFailureStore = new TestGenerationStore();
var doubleStopFailureOperations = new TestNativeOperations();
var doubleStopFailureState = CreateFaultState(doubleStopFailureStore, doubleStopFailureOperations);
var doubleStopFailureSession = Activate(doubleStopFailureState, "client", "double-stop-failure-session");
AssertResult(
    doubleStopFailureState.TrySetLeftButton(
        doubleStopFailureSession.BootId,
        doubleStopFailureSession.Generation,
        doubleStopFailureSession.SessionId,
        1,
        true),
    NativeCommandResult.Accepted,
    "The combined stop-failure scenario must first press successfully.");
doubleStopFailureOperations.AlwaysFailRelease = true;
doubleStopFailureStore.FailSave = true;
AssertResult(
    doubleStopFailureState.TryStop(
        "client",
        doubleStopFailureSession.BootId,
        doubleStopFailureSession.Generation,
        doubleStopFailureSession.SessionId,
        2,
        out var doubleStopFailure),
    NativeCommandResult.NativeOperationFailed,
    "Stop must preserve the native failure result when release and persistence both fail.");
Assert(doubleStopFailure?.Contains("cleanup release failed", StringComparison.Ordinal) == true
       && doubleStopFailure.Contains("Generation persistence also failed", StringComparison.Ordinal)
       && doubleStopFailure.Contains("generation-store write failure", StringComparison.Ordinal),
    "The stop error must retain both cleanup and persistence failures.");
AssertResult(
    doubleStopFailureState.TryGetActivationChallenge("client", out _, out _, out _),
    NativeCommandResult.StorageUnavailable,
    "A double stop failure must leave the bridge unavailable.");

var nativeOperationHttpError = NativeCommandHttpError.From(
    NativeCommandResult.NativeOperationFailed,
    "Native mouse release failed.");
Assert(nativeOperationHttpError.StatusCode == 500
       && nativeOperationHttpError.Code == "native_operation_failed"
       && nativeOperationHttpError.Error == "Native mouse release failed.",
    "Both hosts must map stop operation failures through the shared structured HTTP contract.");
var storageHttpError = NativeCommandHttpError.From(NativeCommandResult.StorageUnavailable);
Assert(storageHttpError.StatusCode == 503 && storageHttpError.Code == "storage_unavailable",
    "The shared HTTP contract must identify unavailable storage.");
var rejectedHttpError = NativeCommandHttpError.From(NativeCommandResult.Rejected);
Assert(rejectedHttpError.StatusCode == 409 && rejectedHttpError.Code == "command_rejected",
    "The shared HTTP contract must identify rejected commands.");

var cancellationStore = new TestGenerationStore();
var cancellationState = CreateState(cancellationStore, []);
var liveSession = Activate(cancellationState, "client", "live-session");
var pendingChallenge = Challenge(cancellationState, "client");
AssertResult(
    cancellationState.TryStop(
        "client", pendingChallenge.BootId, pendingChallenge.Generation, "pending-session", 1, out _),
    NativeCommandResult.Accepted,
    "Stop must consume an unactivated challenge while preserving a different live session.");
Assert(cancellationState.TryValidate(
    "client", liveSession.BootId, liveSession.Generation, liveSession.SessionId),
    "Cancelling a pending activation must not invalidate an unrelated active session.");
AssertResult(
    cancellationState.TryActivate(
        "client", pendingChallenge.BootId, pendingChallenge.Generation, "pending-session", out _),
    NativeCommandResult.Rejected,
    "An activation delayed until after its stop must be rejected.");

var activationFailureStore = new TestGenerationStore();
var activationFailureActions = new List<string>();
var activationFailure = CreateState(activationFailureStore, activationFailureActions);
var oldSession = Activate(activationFailure, "client", "old-session");
Assert(activationFailure.TrySetLeftButton(
        oldSession.BootId, oldSession.Generation, oldSession.SessionId, 1, true)
       == NativeCommandResult.Accepted,
    "The old session must be able to hold the button before activation failure.");
var failedChallenge = Challenge(activationFailure, "client");
activationFailureStore.FailSave = true;
AssertResult(
    activationFailure.TryActivate(
        "client", failedChallenge.BootId, failedChallenge.Generation, "new-session", out _),
    NativeCommandResult.StorageUnavailable,
    "Generation persistence failure must reject activation.");
Assert(!activationFailure.TryValidate("client", oldSession.BootId, oldSession.Generation, oldSession.SessionId),
    "Failed activation must invalidate the previous session.");
Assert(activationFailure.TryMove(oldSession.BootId, oldSession.Generation, oldSession.SessionId, 2, 1, 1)
       == NativeCommandResult.StorageUnavailable,
    "Commands must be rejected after activation persistence fails.");
Assert(activationFailureActions[^1] == "up", "Failed activation must release a held button.");
AssertResult(
    activationFailure.TryGetActivationChallenge("client", out _, out _, out _),
    NativeCommandResult.StorageUnavailable,
    "Activation must remain unavailable until storage recovery.");

activationFailureStore.FailSave = false;
AssertResult(activationFailure.TryRecoverStorage(out _), NativeCommandResult.Accepted,
    "Activation storage must recover when the store is writable.");
var recoveredSession = Activate(activationFailure, "client", "recovered-session");
Assert(activationFailure.TryValidate(
    "client", recoveredSession.BootId, recoveredSession.Generation, recoveredSession.SessionId),
    "A fresh session must work after recovery.");

var stopFailureStore = new TestGenerationStore();
var stopFailureActions = new List<string>();
var stopFailure = CreateState(stopFailureStore, stopFailureActions);
var heldSession = Activate(stopFailure, "client", "held-session");
Assert(stopFailure.TrySetLeftButton(
        heldSession.BootId, heldSession.Generation, heldSession.SessionId, 1, true)
       == NativeCommandResult.Accepted,
    "The session must hold a button before stop failure.");
stopFailureStore.FailSave = true;
AssertResult(
    stopFailure.TryStop(
        "client",
        heldSession.BootId,
        heldSession.Generation,
        heldSession.SessionId,
        2,
        out _),
    NativeCommandResult.StorageUnavailable,
    "Stop must report generation persistence failure.");
Assert(stopFailureActions[^1] == "up", "Stop failure must release the held button before persistence.");
Assert(!stopFailure.TryValidate("client", heldSession.BootId, heldSession.Generation, heldSession.SessionId),
    "Stop failure must invalidate the old session in memory.");
Assert(stopFailure.TryMove(heldSession.BootId, heldSession.Generation, heldSession.SessionId, 3, 5, 6)
       == NativeCommandResult.StorageUnavailable,
    "Old commands must be rejected after failed stop.");
AssertResult(
    stopFailure.TryGetActivationChallenge("client", out _, out _, out _),
    NativeCommandResult.StorageUnavailable,
    "Commands and activation must stay unavailable while storage is inconsistent.");

var previousBoot = heldSession.BootId;
stopFailureStore.FailSave = false;
AssertResult(stopFailure.TryRecoverStorage(out _), NativeCommandResult.Accepted,
    "Stop failure must be recoverable after storage returns.");
var postRecoveryChallenge = Challenge(stopFailure, "client");
Assert(postRecoveryChallenge.BootId != previousBoot, "Storage recovery must rotate the boot identity.");
AssertResult(
    stopFailure.TryActivate(
        "client", previousBoot, postRecoveryChallenge.Generation, "replayed-old-boot", out _),
    NativeCommandResult.Rejected,
    "An old boot identity must not activate after storage recovery.");

var persistedStore = new TestGenerationStore();
var beforeRestart = CreateState(persistedStore, []);
var priorProcessSession = Activate(beforeRestart, "client", "prior-process-session");
Assert(beforeRestart.TrySetLeftButton(
        priorProcessSession.BootId,
        priorProcessSession.Generation,
        priorProcessSession.SessionId,
        1,
        true)
       == NativeCommandResult.Accepted,
    "The prior process session must press.");
persistedStore.FailSave = true;
AssertResult(
    beforeRestart.TryStop(
        "client",
        priorProcessSession.BootId,
        priorProcessSession.Generation,
        priorProcessSession.SessionId,
        2,
        out _),
    NativeCommandResult.StorageUnavailable,
    "The simulated prior-process stop must fail to persist.");
persistedStore.FailSave = false;
var afterRestart = CreateState(persistedStore, []);
Assert(afterRestart.TryMove(
    priorProcessSession.BootId,
    priorProcessSession.Generation,
    priorProcessSession.SessionId,
    2,
    7,
    8) == NativeCommandResult.Rejected,
    "A previous-process command must be rejected even when its stop was not persisted.");
AssertResult(
    afterRestart.TryActivate(
        "client",
        priorProcessSession.BootId,
        priorProcessSession.Generation,
        "replayed-old-activation",
        out _),
    NativeCommandResult.Rejected,
    "A previous-process activation must be rejected independently of persisted stop generation.");

var maxStore = new TestGenerationStore(long.MaxValue - 1);
var maxState = CreateState(maxStore, []);
var maxChallenge = Challenge(maxState, "client");
Assert(maxChallenge.Generation == long.MaxValue.ToString(CultureInfo.InvariantCulture),
    "The final generation must be represented exactly as a decimal string.");
AssertResult(
    maxState.TryActivate(
        "client", maxChallenge.BootId, maxChallenge.Generation, "last-generation", out _),
    NativeCommandResult.Accepted,
    "The last available generation may be used once.");
AssertResult(
    maxState.TryGetActivationChallenge("client", out _, out _, out _),
    NativeCommandResult.StorageUnavailable,
    "Generation overflow must fail closed instead of wrapping.");
AssertResult(maxState.TryRecoverStorage(out _), NativeCommandResult.Accepted,
    "An exhausted generation store must have an explicit recovery path.");
var resetChallenge = Challenge(maxState, "client");
Assert(resetChallenge.Generation == "1", "Exhaustion recovery must establish a new safe generation epoch.");
Assert(resetChallenge.BootId != maxChallenge.BootId, "Exhaustion recovery must invalidate prior tokens.");

var validationState = CreateState(new TestGenerationStore(), []);
var validationChallenge = Challenge(validationState, "client");
AssertResult(
    validationState.TryActivate(
        "client", validationChallenge.BootId, long.MaxValue.ToString(), "poison", out _),
    NativeCommandResult.Rejected,
    "An arbitrary maximum client-proposed generation must not be accepted.");
AssertResult(
    validationState.TryActivate("client", validationChallenge.BootId, "0", "zero", out _),
    NativeCommandResult.Rejected,
    "Zero is not a valid activation generation.");
AssertResult(
    validationState.TryActivate("client", validationChallenge.BootId, "-1", "negative", out _),
    NativeCommandResult.Rejected,
    "Negative activation generations must be rejected.");
AssertResult(
    validationState.TryActivate(
        "client", validationChallenge.BootId, "9223372036854775808", "overflow", out _),
    NativeCommandResult.Rejected,
    "Out-of-range activation generations must be rejected.");
AssertResult(
    validationState.TryActivate(
        "client", validationChallenge.BootId, "0001", "noncanonical", out _),
    NativeCommandResult.Rejected,
    "Noncanonical generation values must not bypass exact challenge matching.");

foreach (var invalidStoreValue in new[] { "-1", "v2:7", "not-a-generation", "9223372036854775808" })
{
    var invalidStore = new TestGenerationStore { LoadError = new InvalidDataException(invalidStoreValue) };
    var invalidState = CreateState(invalidStore, []);
    AssertResult(
        invalidState.TryGetActivationChallenge("client", out _, out _, out _),
        NativeCommandResult.StorageUnavailable,
        $"Invalid stored value '{invalidStoreValue}' must fail closed.");
    AssertResult(invalidState.TryRecoverStorage(out _), NativeCommandResult.Accepted,
        "Corrupt or unsupported data must recover through explicit reset.");
    Assert(Challenge(invalidState, "client").Generation == "1",
        "A reset store must allocate from its new boot identity.");
}

var negativeStore = new TestGenerationStore(-1);
var negativeState = CreateState(negativeStore, []);
AssertResult(negativeState.TryRecoverStorage(out _), NativeCommandResult.Accepted,
    "A negative generation returned by a store must be repaired explicitly.");
Assert(Challenge(negativeState, "client").Generation == "1",
    "Negative persisted generations must not allocate zero or revive old sessions.");

var unavailableStore = new TestGenerationStore { FailLoad = true, FailSave = true };
var unavailableState = CreateState(unavailableStore, []);
AssertResult(
    unavailableState.TryGetActivationChallenge("client", out _, out _, out _),
    NativeCommandResult.StorageUnavailable,
    "An unavailable store must not provide a challenge.");
unavailableStore.FailLoad = false;
unavailableStore.FailSave = false;
AssertResult(unavailableState.TryRecoverStorage(out _), NativeCommandResult.Accepted,
    "Unavailable storage must recover explicitly when access returns.");

var storeDirectory = Path.Combine(Path.GetTempPath(), $"Glimouse-generation-tests-{Guid.NewGuid():N}");
Directory.CreateDirectory(storeDirectory);
try
{
    var file = Path.Combine(storeDirectory, "generation.txt");
    var fileStore = new NativeSessionGenerationStore(file);
    Assert(fileStore.Load() == 0, "A missing generation file must start at zero.");
    fileStore.Save(42);
    Assert(fileStore.Load() == 42, "The versioned generation format must round-trip.");
    File.WriteAllText(file, "43");
    Assert(fileStore.Load() == 43, "The legacy numeric format must remain readable.");
    fileStore.Save(long.MaxValue);
    Assert(fileStore.Load() == long.MaxValue, "The store must preserve the largest supported value exactly.");
    File.WriteAllText(file, "0");
    Assert(fileStore.Load() == 0, "Zero is a valid persisted initial high-water mark.");
    foreach (var invalidPersistedValue in new[] { "-1", "9223372036854775808", "v2:44", "corrupt" })
    {
        File.WriteAllText(file, invalidPersistedValue);
        try
        {
            _ = fileStore.Load();
            throw new InvalidOperationException($"Invalid persisted value '{invalidPersistedValue}' must fail.");
        }
        catch (InvalidDataException)
        {
        }
    }
    File.WriteAllText(file, "v9:44");
    try
    {
        _ = fileStore.Load();
        throw new InvalidOperationException("Unsupported store versions must fail.");
    }
    catch (InvalidDataException)
    {
    }
    fileStore.ResetCorruptData();
    Assert(fileStore.Load() == 0, "Explicit store recovery must reset corrupt state.");
    Assert(Directory.GetFiles(storeDirectory, "generation.txt.corrupt-*").Length == 1,
        "Corrupt state must be preserved for diagnosis rather than silently discarded.");
}
finally
{
    Directory.Delete(storeDirectory, recursive: true);
}

Console.WriteLine("Native mouse command-state and generation-store scenarios passed.");

static NativeMouseCommandState CreateState(TestGenerationStore store, List<string> actions) =>
    new(
        (x, y) => actions.Add($"move:{x}:{y}"),
        pressed => actions.Add(pressed ? "down" : "up"),
        delta => actions.Add($"scroll:{delta}"),
        store);

static NativeMouseCommandState CreateFaultState(TestGenerationStore store, TestNativeOperations operations) =>
    new(operations.Move, operations.SetLeftButton, operations.Scroll, store);

static (string BootId, string Generation) Challenge(NativeMouseCommandState state, string clientId)
{
    var result = state.TryGetActivationChallenge(clientId, out var bootId, out var generation, out var failure);
    if (result != NativeCommandResult.Accepted)
    {
        throw new InvalidOperationException($"Could not create activation challenge: {result}; {failure}");
    }
    return (bootId, generation);
}

static (string BootId, string Generation, string SessionId) Activate(
    NativeMouseCommandState state,
    string clientId,
    string sessionId)
{
    var challenge = Challenge(state, clientId);
    AssertResultStatic(
        state.TryActivate(clientId, challenge.BootId, challenge.Generation, sessionId, out _),
        NativeCommandResult.Accepted,
        "Session activation must succeed.");
    return (challenge.BootId, challenge.Generation, sessionId);
}

static void AssertResultStatic(NativeCommandResult actual, NativeCommandResult expected, string message)
{
    if (actual != expected)
    {
        throw new InvalidOperationException($"{message} (expected {expected}, got {actual}).");
    }
}

sealed class TestGenerationStore(long initialGeneration = 0) : INativeSessionGenerationStore
{
    public long DurableGeneration { get; private set; } = initialGeneration;
    public bool FailLoad { get; set; }
    public bool FailSave { get; set; }
    public Exception? LoadError { get; set; }

    public long Load()
    {
        if (FailLoad)
        {
            throw new IOException("Simulated unavailable generation store.");
        }
        if (LoadError is not null)
        {
            throw LoadError;
        }
        return DurableGeneration;
    }

    public void Save(long generation)
    {
        if (FailSave)
        {
            throw new IOException("Simulated generation-store write failure.");
        }
        DurableGeneration = generation;
        LoadError = null;
    }

    public void ResetCorruptData()
    {
        if (FailSave)
        {
            throw new IOException("Simulated generation-store reset failure.");
        }
        DurableGeneration = 0;
        LoadError = null;
    }
}

sealed class TestNativeOperations
{
    public List<string> Actions { get; } = [];
    public Exception? MoveFailure { get; set; }
    public Exception? ScrollFailure { get; set; }
    public Exception? PressFailure { get; set; }
    public int ReleaseFailuresRemaining { get; set; }
    public bool AlwaysFailRelease { get; set; }
    public bool ButtonDown { get; private set; }

    public void Move(int x, int y)
    {
        Actions.Add($"move:{x}:{y}");
        if (MoveFailure is not null)
        {
            throw MoveFailure;
        }
    }

    public void SetLeftButton(bool pressed)
    {
        Actions.Add(pressed ? "down" : "up");
        if (pressed)
        {
            ButtonDown = true;
            if (PressFailure is not null)
            {
                throw PressFailure;
            }
            return;
        }

        if (AlwaysFailRelease)
        {
            throw new InvalidOperationException("cleanup release failed");
        }
        if (ReleaseFailuresRemaining > 0)
        {
            ReleaseFailuresRemaining -= 1;
            throw new InvalidOperationException("release operation failed");
        }

        ButtonDown = false;
    }

    public void Scroll(int delta)
    {
        Actions.Add($"scroll:{delta}");
        if (ScrollFailure is not null)
        {
            throw ScrollFailure;
        }
    }
}
