using System.Net;
using System.Runtime.InteropServices;

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

app.MapPost("/cursor/move", (MoveRequest request) =>
{
    if (request.X < 0 || request.Y < 0)
    {
        return Results.BadRequest(new { error = "Coordinates must be non-negative." });
    }

    NativeMouse.SetCursorPos(request.X, request.Y);
    return Results.Ok(new { status = "moved" });
});

app.MapPost("/cursor/stop", () =>
{
    NativeMouse.ReleaseButtons();
    return Results.Ok(new { status = "stopped" });
});

app.MapPost("/mouse/left", (ButtonRequest request) =>
{
    NativeMouse.SetLeftButton(request.Pressed);
    return Results.Ok(new { status = request.Pressed ? "pressed" : "released" });
});

app.MapPost("/mouse/scroll", (ScrollRequest request) =>
{
    if (request.Delta == 0 || Math.Abs((long)request.Delta) > 1200)
    {
        return Results.BadRequest(new { error = "Scroll delta must be between -1200 and 1200." });
    }

    NativeMouse.Scroll(request.Delta);
    return Results.Ok(new { status = "scrolled" });
});

app.Lifetime.ApplicationStopping.Register(NativeMouse.ReleaseButtons);

app.Run("http://127.0.0.1:5103");

internal sealed record MoveRequest(int X, int Y);
internal sealed record ButtonRequest(bool Pressed);
internal sealed record ScrollRequest(int Delta);

internal static class NativeMouse
{
    private const uint MouseEventLeftDown = 0x0002;
    private const uint MouseEventLeftUp = 0x0004;
    private const uint MouseEventWheel = 0x0800;
    private static bool _leftButtonDown;

    [DllImport("user32.dll", EntryPoint = "SetCursorPos", SetLastError = true)]
    private static extern bool SetCursorPosNative(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);

    public static void SetCursorPos(int x, int y)
    {
        if (!SetCursorPosNative(x, y))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static void ReleaseButtons()
    {
        SetLeftButton(false);
    }

    public static void SetLeftButton(bool pressed)
    {
        if (_leftButtonDown == pressed)
        {
            return;
        }

        mouse_event(pressed ? MouseEventLeftDown : MouseEventLeftUp, 0, 0, 0, IntPtr.Zero);
        _leftButtonDown = pressed;
    }

    public static void Scroll(int delta)
    {
        mouse_event(MouseEventWheel, 0, 0, unchecked((uint)delta), IntPtr.Zero);
    }
}
