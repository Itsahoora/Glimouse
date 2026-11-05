using System.Net;
using System.Runtime.InteropServices;
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
        bridge.StartAsync().GetAwaiter().GetResult();

        try
        {
            Application.Run(new Form1());
        }
        finally
        {
            NativeMouse.ReleaseButtons();
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
        app.MapPost("/cursor/move", (MoveRequest request) =>
        {
            if (request.X < 0 || request.Y < 0)
            {
                return Results.BadRequest(new { error = "Coordinates must be non-negative." });
            }

            NativeMouse.Move(request.X, request.Y);
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
        return app;
    }
}

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

    [DllImport("user32.dll", EntryPoint = "mouse_event")]
    private static extern void MouseEvent(uint flags, uint dx, uint dy, uint data, IntPtr extraInfo);

    public static void Move(int x, int y)
    {
        if (!SetCursorPosNative(x, y))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static void SetLeftButton(bool pressed)
    {
        if (_leftButtonDown == pressed)
        {
            return;
        }

        MouseEvent(pressed ? MouseEventLeftDown : MouseEventLeftUp, 0, 0, 0, IntPtr.Zero);
        _leftButtonDown = pressed;
    }

    public static void ReleaseButtons()
    {
        SetLeftButton(false);
    }

    public static void Scroll(int delta)
    {
        MouseEvent(MouseEventWheel, 0, 0, unchecked((uint)delta), IntPtr.Zero);
    }
}
