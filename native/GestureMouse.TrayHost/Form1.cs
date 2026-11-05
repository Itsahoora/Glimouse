using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace GestureMouse.TrayHost;

public partial class Form1 : Form
{
    private const string VirtualHostName = "appassets.gesturemouse.local";
    private readonly WebView2 _browser = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon _trayIcon;
    private bool _allowExit;
    private bool _browserInitialized;

    public Form1()
    {
        InitializeComponent();
        Text = "Glimouse";
        Width = 1440;
        Height = 960;
        MinimumSize = new Size(920, 680);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_browser);

        var menu = new ContextMenuStrip();
        menu.Items.Add(new ToolStripMenuItem("Open Glimouse", null, (_, _) => ShowWindow()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Exit", null, (_, _) => ExitApplication()));

        _trayIcon = new NotifyIcon
        {
            Text = "Glimouse is running",
            Icon = SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true,
        };
        _trayIcon.DoubleClick += (_, _) => ShowWindow();
        Shown += async (_, _) => await InitializeBrowserAsync();
        FormClosing += OnFormClosing;
        FormClosed += (_, _) => _trayIcon.Dispose();
    }

    private async Task InitializeBrowserAsync()
    {
        if (_browserInitialized)
        {
            return;
        }

        var assetsDirectory = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        var indexPath = Path.Combine(assetsDirectory, "index.html");
        if (!File.Exists(indexPath))
        {
            MessageBox.Show(
                this,
                "The frontend files are missing. Build the web app with `npm run build`, then rebuild Glimouse.",
                "Glimouse assets not found",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        try
        {
            var userDataDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "GestureMouse",
                "WebView2");
            Directory.CreateDirectory(userDataDirectory);
            var options = new CoreWebView2EnvironmentOptions(
                "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows");
            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userDataDirectory,
                options);
            await _browser.EnsureCoreWebView2Async(environment);
            _browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
                VirtualHostName,
                assetsDirectory,
                CoreWebView2HostResourceAccessKind.DenyCors);
            await _browser.CoreWebView2.Profile.SetPermissionStateAsync(
                CoreWebView2PermissionKind.Camera,
                $"https://{VirtualHostName}",
                CoreWebView2PermissionState.Allow);
            _browser.CoreWebView2.PermissionRequested += OnPermissionRequested;
            _browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _browser.CoreWebView2.Settings.IsZoomControlEnabled = false;
            _browser.CoreWebView2.Navigate($"https://{VirtualHostName}/index.html");
            _browserInitialized = true;
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                this,
                $"Glimouse could not initialize its WebView2 camera host.\n\n{exception.Message}",
                "Glimouse startup failed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs eventArgs)
    {
        if (eventArgs.PermissionKind is CoreWebView2PermissionKind.Camera
            && Uri.TryCreate(eventArgs.Uri, UriKind.Absolute, out var requestUri)
            && requestUri.Scheme == Uri.UriSchemeHttps
            && string.Equals(requestUri.Host, VirtualHostName, StringComparison.OrdinalIgnoreCase))
        {
            eventArgs.State = CoreWebView2PermissionState.Allow;
            eventArgs.Handled = true;
        }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs eventArgs)
    {
        if (_allowExit || eventArgs.CloseReason == CloseReason.WindowsShutDown)
        {
            return;
        }

        eventArgs.Cancel = true;
        Hide();
        _trayIcon.ShowBalloonTip(
            1800,
            "Glimouse keeps running",
            "Tracking remains active in the notification area. Choose Exit from the tray menu to stop.",
            ToolTipIcon.Info);
    }

    private void ShowWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ExitApplication()
    {
        _allowExit = true;
        Close();
    }
}
