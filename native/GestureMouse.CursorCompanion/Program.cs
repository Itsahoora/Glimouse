using System.Net;
using System.Runtime.InteropServices;
using GestureMouse.Shared;

NativeDpi.EnablePerMonitorV2();

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddPolicy("LocalOnly", policy =>
    {
        policy
            .WithOrigins(
                "http://localhost:5173",
                "http://127.0.0.1:5173",
                "https://appassets.gesturemouse.local")
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

var app = builder.Build();

app.UseCors("LocalOnly");
app.Use(async (context, next) =>
{
    var host = context.Request.Host.Host;
    var allowed = string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
        || string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
        || string.Equals(host, "::1", StringComparison.OrdinalIgnoreCase);

    if (!allowed)
    {
        context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
        await context.Response.WriteAsJsonAsync(new { error = "This companion only accepts local requests." });
        return;
    }

    if (context.Request.Headers.TryGetValue("Access-Control-Request-Private-Network", out var privateNetwork)
        && string.Equals(privateNetwork, "true", StringComparison.OrdinalIgnoreCase))
    {
        context.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
    }

    await next();
});

app.MapGet("/health", () => Results.Ok(new { status = "healthy", mode = "local-only" }));

app.MapPost("/mouse/session/challenge", (ClientRequest request) =>
{
    var result = NativeMouse.TryGetActivationChallenge(
        request.ClientId,
        out var bootId,
        out var generation,
        out var failure);
    return result switch
    {
        NativeCommandResult.Accepted => Results.Ok(new { bootId, generation }),
        NativeCommandResult.StorageUnavailable => Results.Json(
            new { error = failure ?? "Native session storage is unavailable." },
            statusCode: (int)HttpStatusCode.ServiceUnavailable),
        _ => Results.BadRequest(new { error = "The client identity is invalid." }),
    };
});

app.MapPost("/mouse/session/recover", () =>
{
    var result = NativeMouse.TryRecoverStorage(out var failure);
    return result switch
    {
        NativeCommandResult.Accepted => Results.Ok(new { status = "recovered" }),
        _ => Results.Json(
            new { error = failure ?? "Native session storage recovery failed." },
            statusCode: (int)HttpStatusCode.ServiceUnavailable),
    };
});

app.MapPost("/mouse/session", (SessionRequest request) =>
{
    var result = NativeMouse.TryActivate(request, out var failure);
    return result switch
    {
        NativeCommandResult.Accepted => Results.Ok(new
        {
            bootId = request.BootId,
            generation = request.Generation,
            sessionId = request.SessionId,
        }),
        NativeCommandResult.StorageUnavailable => Results.Json(
            new { error = failure ?? "Native session storage is unavailable." },
            statusCode: (int)HttpStatusCode.ServiceUnavailable),
        _ => Results.Conflict(new { error = "The session activation challenge is stale or invalid." }),
    };
});

app.MapPost("/mouse/session/validate", (SessionValidationRequest request) =>
    NativeMouse.IsSessionValid(request)
        ? Results.Ok(new { status = "valid" })
        : Results.Conflict(new { error = "The mouse session is no longer active." }));

app.MapPost("/cursor/move", (MoveRequest request) =>
{
    if (request.X < 0 || request.Y < 0)
    {
        return Results.BadRequest(new { error = "Coordinates must be non-negative." });
    }

    var result = NativeMouse.TryMove(
            request.BootId,
            request.Generation,
            request.SessionId,
            request.Sequence,
            request.X,
            request.Y,
            out var failure);
    return CommandResult(result, new { status = "moved" }, failure);
});

app.MapPost("/cursor/stop", (StopRequest request) =>
{
    var result = NativeMouse.TryStop(request, out var failure);
    return CommandResult(result, new { status = "stopped" }, failure);
});

app.MapPost("/mouse/left", (ButtonRequest request) =>
{
    var result = NativeMouse.TrySetLeftButton(
            request.BootId,
            request.Generation,
            request.SessionId,
            request.Sequence,
            request.Pressed,
            out var failure);
    return CommandResult(result, new { status = request.Pressed ? "pressed" : "released" }, failure);
});

app.MapPost("/mouse/scroll", (ScrollRequest request) =>
{
    if (request.Delta == 0 || Math.Abs((long)request.Delta) > 1200)
    {
        return Results.BadRequest(new { error = "Scroll delta must be between -1200 and 1200." });
    }

    var result = NativeMouse.TryScroll(
            request.BootId,
            request.Generation,
            request.SessionId,
            request.Sequence,
            request.Delta,
            out var failure);
    return CommandResult(result, new { status = "scrolled" }, failure);
});

app.Lifetime.ApplicationStopping.Register(NativeMouse.StopAcceptingCommands);

app.Run("http://127.0.0.1:5103");

static IResult CommandResult(NativeCommandResult result, object successBody, string? failure = null) =>
    result == NativeCommandResult.Accepted
        ? Results.Ok(successBody)
        : ToHttpError(result, failure);

static IResult ToHttpError(NativeCommandResult result, string? failure)
{
    var error = NativeCommandHttpError.From(result, failure);
    return Results.Json(
        new { code = error.Code, error = error.Error },
        statusCode: error.StatusCode);
}

internal sealed record ClientRequest(string ClientId);
internal sealed record SessionRequest(string ClientId, string BootId, string Generation, string SessionId);
internal sealed record SessionValidationRequest(
    string ClientId,
    string BootId,
    string Generation,
    string SessionId);
internal sealed record MoveRequest(string BootId, string Generation, string SessionId, long Sequence, int X, int Y);
internal sealed record ButtonRequest(
    string BootId,
    string Generation,
    string SessionId,
    long Sequence,
    bool Pressed);
internal sealed record StopRequest(
    string ClientId,
    string BootId,
    string Generation,
    string SessionId,
    long Sequence);
internal sealed record ScrollRequest(string BootId, string Generation, string SessionId, long Sequence, int Delta);

internal static class NativeMouse
{
    private const uint MouseEventLeftDown = 0x0002;
    private const uint MouseEventLeftUp = 0x0004;
    private const uint MouseEventWheel = 0x0800;
    private static readonly NativeSessionGenerationStore GenerationStore = new();
    private static readonly NativeMouseCommandState Commands = new(
        SetCursorPos,
        SetLeftButton,
        Scroll,
        GenerationStore);

    [DllImport("user32.dll", EntryPoint = "SetCursorPos", SetLastError = true)]
    private static extern bool SetCursorPosNative(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);

    public static void SetCursorPos(int x, int y)
    {
        // The bridge API accepts physical primary-display pixels; this process runs Per-Monitor V2 aware.
        if (!SetCursorPosNative(x, y))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static NativeCommandResult TryGetActivationChallenge(
        string clientId,
        out string bootId,
        out string generation,
        out string? failure) =>
        Commands.TryGetActivationChallenge(clientId, out bootId, out generation, out failure);

    public static NativeCommandResult TryRecoverStorage(out string? failure) =>
        Commands.TryRecoverStorage(out failure);

    public static NativeCommandResult TryActivate(SessionRequest request, out string? failure) =>
        Commands.TryActivate(
            request.ClientId,
            request.BootId,
            request.Generation,
            request.SessionId,
            out failure);

    public static bool IsSessionValid(SessionValidationRequest request) =>
        Commands.TryValidate(request.ClientId, request.BootId, request.Generation, request.SessionId);

    public static NativeCommandResult TryMove(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        int x,
        int y,
        out string? failure) =>
        Commands.TryMove(bootId, generation, sessionId, sequence, x, y, out failure);

    public static NativeCommandResult TrySetLeftButton(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        bool pressed,
        out string? failure) =>
        Commands.TrySetLeftButton(bootId, generation, sessionId, sequence, pressed, out failure);

    public static NativeCommandResult TryScroll(
        string bootId,
        string generation,
        string sessionId,
        long sequence,
        int delta,
        out string? failure) =>
        Commands.TryScroll(bootId, generation, sessionId, sequence, delta, out failure);

    public static NativeCommandResult TryStop(StopRequest request, out string? failure) =>
        Commands.TryStop(
            request.ClientId,
            request.BootId,
            request.Generation,
            request.SessionId,
            request.Sequence,
            out failure);

    public static void StopAcceptingCommands() => Commands.StopAcceptingCommands();

    private static void SetLeftButton(bool pressed) =>
        mouse_event(pressed ? MouseEventLeftDown : MouseEventLeftUp, 0, 0, 0, IntPtr.Zero);

    private static void Scroll(int delta) =>
        mouse_event(MouseEventWheel, 0, 0, unchecked((uint)delta), IntPtr.Zero);
}

internal static class NativeDpi
{
    private static readonly IntPtr PerMonitorAwareV2 = new(-4);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDpiAwarenessContext();

    [DllImport("user32.dll")]
    private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);

    public static void EnablePerMonitorV2()
    {
        if (SetProcessDpiAwarenessContext(PerMonitorAwareV2))
        {
            return;
        }

        var error = Marshal.GetLastWin32Error();
        if (error == 5 && AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), PerMonitorAwareV2))
        {
            return;
        }

        throw new System.ComponentModel.Win32Exception(error, "Unable to enable Per-Monitor V2 DPI awareness.");
    }
}
