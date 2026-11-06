using System.Net;
using System.Runtime.InteropServices;
using GestureMouse.Shared;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace GestureMouse.TrayHost;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var bridge = BuildBridge();
        try
        {
            bridge.StartAsync().GetAwaiter().GetResult();
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                $"Glimouse could not start its local cursor bridge on 127.0.0.1:5103.\n\n{exception.Message}\n\nClose any other Glimouse cursor companion and try again.",
                "Glimouse bridge startup failed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        try
        {
            Application.Run(new Form1());
        }
        finally
        {
            NativeMouse.StopAcceptingCommands();
            bridge.StopAsync().GetAwaiter().GetResult();
        }
    }

    private static WebApplication BuildBridge()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:5103");
        builder.Services.AddCors(options => options.AddPolicy("GestureMouseLocal", policy =>
        {
            policy
                .WithOrigins(
                    "https://appassets.gesturemouse.local",
                    "http://localhost:5173",
                    "http://127.0.0.1:5173")
                .AllowAnyHeader()
                .AllowAnyMethod();
        }));

        var app = builder.Build();
        app.Use(async (context, next) =>
        {
            var host = context.Request.Host.Host;
            if (!string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
            {
                context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
                await context.Response.WriteAsJsonAsync(new { error = "Local requests only." });
                return;
            }

            if (context.Request.Headers.TryGetValue("Access-Control-Request-Private-Network", out var privateNetwork)
                && string.Equals(privateNetwork, "true", StringComparison.OrdinalIgnoreCase))
            {
                context.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
            }

            await next();
        });
        app.UseCors("GestureMouseLocal");
        app.MapGet("/health", () => Results.Ok(new { status = "healthy", mode = "tray-host-local" }));
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
        return app;
    }

    private static IResult CommandResult(NativeCommandResult result, object successBody, string? failure = null) =>
        result == NativeCommandResult.Accepted
            ? Results.Ok(successBody)
            : ToHttpError(result, failure);

    private static IResult ToHttpError(NativeCommandResult result, string? failure)
    {
        var error = NativeCommandHttpError.From(result, failure);
        return Results.Json(
            new { code = error.Code, error = error.Error },
            statusCode: error.StatusCode);
    }
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
        Move,
        SetLeftButton,
        Scroll,
        GenerationStore);

    [DllImport("user32.dll", EntryPoint = "SetCursorPos", SetLastError = true)]
    private static extern bool SetCursorPosNative(int x, int y);

    [DllImport("user32.dll", EntryPoint = "mouse_event")]
    private static extern void MouseEvent(uint flags, uint dx, uint dy, uint data, IntPtr extraInfo);

    public static void Move(int x, int y)
    {
        // The bridge API accepts physical primary-display pixels; the host runs Per-Monitor V2 aware.
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
        MouseEvent(pressed ? MouseEventLeftDown : MouseEventLeftUp, 0, 0, 0, IntPtr.Zero);

    private static void Scroll(int delta) =>
        MouseEvent(MouseEventWheel, 0, 0, unchecked((uint)delta), IntPtr.Zero);
}
