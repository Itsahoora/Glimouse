# Glimouse

Glimouse is a local-first hand-gesture mouse for Windows. It uses a webcam and MediaPipe hand tracking to control the cursor. Camera frames and hand landmarks are processed on your device; the hand-tracking model is downloaded from Google the first time tracking starts.

[MIT License](./LICENSE)

## Features

- Live webcam preview with hand-tracking overlay and camera selection
- Cursor movement with calibration, sensitivity, and adaptive smoothing
- Optional pinch-to-click, pinch-and-hold dragging, and open-palm scrolling
- Optional mirrored camera preview with matching cursor direction
- Local-only native bridge for Windows mouse control
- Movement and click/scroll controls are opt-in

## Download and run

Glimouse runs on 64-bit Windows and requires the Microsoft Edge WebView2 Runtime and a webcam.
The latest published release is `v0.1.0`.

1. Download the latest `Glimouse-*-win-x64.zip` from the repository's **Releases** page.
2. Extract the entire archive.
3. Run `Glimouse.exe` from the extracted folder. Keep the other files beside it.

The release archive includes the .NET runtime and app assets. You do not need to install the .NET SDK or runtime. WebView2 is a separate Windows prerequisite. The first tracking session needs an internet connection to download the MediaPipe hand model.

The app stays in the notification area when its window is closed. Choose **Exit** from the tray icon menu to stop the app and camera. Glimouse does not install itself to run at Windows sign-in.

### Create a release

Pushing a version tag that starts with `v` runs the Windows release workflow. It tests and builds the project, then publishes the self-contained x64 app and attaches a ZIP containing the executable, supporting files, and MIT license to a GitHub Release.

```powershell
$version = "vX.Y.Z"
git tag $version
git push origin $version
```

## Development

### Requirements

- Windows 10 or later (64-bit)
- Node.js 22 or later and npm
- .NET 10 SDK
- Microsoft Edge WebView2 Runtime
- Webcam access

Install dependencies and start the web app:

```powershell
npm ci
npm run dev
```

Open the local URL printed by Vite. Browser development mode can preview hand tracking but needs the native companion for cursor control. In a separate terminal, start it with:

```powershell
dotnet run --project .\native\GestureMouse.CursorCompanion\GestureMouse.CursorCompanion.csproj
```

To run the Windows tray app from source:

```powershell
npm run desktop
```

The tray app builds the frontend, hosts it in WebView2, and starts its local cursor bridge. Enable camera access for desktop apps under **Settings > Privacy & security > Camera**.

### Build and test

Run these commands from the repository root:

```powershell
npm ci
npm run lint
npm test
npm run build
dotnet build .\native\GestureMouse.CursorCompanion\GestureMouse.CursorCompanion.csproj
dotnet build .\native\GestureMouse.TrayHost\GestureMouse.TrayHost.csproj
dotnet run --project .\native\GestureMouse.CommandState.Tests\GestureMouse.CommandState.Tests.csproj --configuration Release
dotnet publish .\native\GestureMouse.TrayHost\GestureMouse.TrayHost.csproj -c Release -r win-x64 --self-contained false
```

GitHub Actions runs the frontend checks, builds the cursor companion, runs the native command-state scenarios, and publishes the tray app for pushes and pull requests to `main`.

## Privacy and safety

- Webcam frames and hand landmarks are processed locally; Glimouse has no cloud backend.
- The hand-tracking model is fetched from Google on first use.
- The cursor bridge listens only on localhost and is not intended for remote network access.
- Movement, clicking, dragging, and scrolling are opt-in. The app does not expose right-click or arbitrary mouse-button actions.
- The bridge releases held mouse buttons when it stops.

## Known limitations

- The first tracking session requires an internet connection to download the model.
- Tracking quality depends on the webcam, lighting, browser/runtime, and hand visibility.
- Browser development mode stops tracking when its tab closes; use the tray app to keep it running while its window is hidden.
- Real cursor-control testing requires a Windows desktop, webcam, and physical display.
