# Glimouse

Glimouse is a local-first hand-gesture mouse for Windows. It uses your webcam and MediaPipe hand landmarks to estimate cursor movement, then a small local .NET app moves the Windows pointer. Camera frames and landmarks are processed on your device; the hand-tracking model is downloaded from Google on first use.

[Source repository](https://github.com/Itsahoora/Glimouse) · [MIT License](./LICENSE)

## What it does

- Starts and stops a webcam stream with camera selection
- Displays a hand-tracking overlay in real time
- Detects basic hand states such as no hand, pinch, open palm, or closed fist
- Maps the hand to the screen coordinate system with sensitivity and adaptive One Euro smoothing
- Provides opt-in pinch-to-click, pinch-and-hold dragging, and open-palm scrolling
- Provides a mirrored-camera preview option that keeps cursor direction consistent
- Processes camera frames and landmarks locally
- Connects to a local-only native bridge to drive the Windows cursor

## Architecture

- Frontend: Vite + React + TypeScript
- Tracking: MediaPipe Tasks Vision hand landmarker
- MediaPipe WebAssembly runtime is bundled with the app; the hand-landmark model is downloaded on first use
- Native bridge: ASP.NET Core on localhost only
- Logic: deterministic geometry helpers for calibration, smoothing, and gesture classification
- CI: GitHub Actions runs lint, tests, frontend build, and Windows app publish on pushes and pull requests

## Prerequisites

- Windows 11 or a modern Windows desktop
- Node.js 22+
- npm
- .NET SDK 10.0+
- To run the published tray app on a computer without the .NET SDK, install the .NET 10 Desktop Runtime and ASP.NET Core Runtime
- Microsoft Edge WebView2 Runtime
- Webcam enabled and permission granted in the browser

## Installation

```powershell
cd "D:\Projects\Gesture Mouse"
npm install
```

## Run the app

For browser development (tracking ends when you close the tab):

```powershell
cd "D:\Projects\Gesture Mouse"
npm run dev
```

Then open the local Vite URL reported in the terminal (usually http://localhost:5173).

For regular use, launch the Windows tray app. It builds and embeds the UI, starts the local cursor bridge, and keeps tracking active when its window is hidden:

```powershell
cd "D:\Projects\Gesture Mouse"
npm run desktop
```

Start tracking and enable Movement mode first. Closing the Glimouse window hides it to the notification area; it does not stop tracking. Use the tray icon menu and select **Exit** to stop the camera and app completely. The published tray app is framework-dependent, so a computer without the .NET SDK must have the .NET 10 Desktop Runtime and ASP.NET Core Runtime installed. It also requires the Microsoft Edge WebView2 Runtime. It does not install itself to run automatically at Windows sign-in.

The Windows app-folder build is available as a downloadable artifact from the **Actions** tab after a successful workflow run. Download and extract the complete artifact folder; do not copy the `.exe` by itself because its supporting files are required.

## Start the native cursor companion (browser development only)

```powershell
cd "D:\Projects\Gesture Mouse"
dotnet run --project .\native\GestureMouse.CursorCompanion\GestureMouse.CursorCompanion.csproj
```

The companion listens on http://127.0.0.1:5103 and accepts only localhost requests. It is not exposed outside the machine.

## Build for production

```powershell
cd "D:\Projects\Gesture Mouse"
npm run build
dotnet build .\native\GestureMouse.TrayHost\GestureMouse.TrayHost.csproj
```

To publish a Windows x64 app folder:

```powershell
dotnet publish .\native\GestureMouse.TrayHost\GestureMouse.TrayHost.csproj -c Release -r win-x64 --self-contained false
```

## Camera permissions

For the Windows tray app, open **Settings > Privacy & security > Camera** and enable both **Camera access** and **Let desktop apps access your camera**. Windows controls this system-wide desktop-app permission; Glimouse cannot override it. Restart the tray app after changing the setting.

The tray app grants camera permission to its own embedded app origin. The hand-tracking model is downloaded from Google on first use, so an internet connection is required to initialize tracking. If camera access still fails, close other apps using the camera, check that the camera is enabled in Windows, and use the error shown in Glimouse for the specific failure.

For browser development, allow camera access when prompted. If access was previously blocked, update the browser's site permissions and restart tracking.

## Calibrating cursor movement

1. Start tracking.
2. Align the hand to the screen center or use the calibration controls in the dashboard.
3. Choose Fast, Balanced, or Steady smoothing, then fine-tune the slider and sensitivity.
4. Toggle **Mirror camera preview** if you prefer a mirror-style selfie view; cursor direction follows the preview.
5. Enable the single **Pinch: click / hold to drag** control and/or scrolling.
6. Disable movement mode until you are ready to control the cursor.

## Safe usage notes

- Movement mode is opt-in.
- Pinch actions and scroll are opt-in and require Movement mode.
- A quick pinch-and-release clicks; keeping the pinch closed for about 0.42 seconds starts a drag, and release drops.
- The pointer pauses during the initial pinch hold so finger movement does not shift a click target; it follows the hand again after drag begins.
- Open-palm vertical movement scrolls; no right-click or arbitrary button actions are exposed.
- Adaptive One Euro filtering suppresses small hand tremors while responding faster to larger movements; the smoothness presets offer quick starting points.
- Pinch recognition uses separate engage/release thresholds to avoid click/drag flicker from small landmark changes.
- The native bridge releases mouse buttons on stop and error paths.
- Camera and hand processing are local-only by default.

## Known limitations

- Real hardware testing requires a webcam and a physical display.
- Browser development mode cannot keep tracking after its browser tab closes. Use the tray-hosted Windows app to keep tracking while its window is hidden; selecting Exit from the tray stops it.
- MediaPipe inference depends on the browser and webcam driver quality.
- Windows mouse movement is only as reliable as the local native bridge and display calibration.
- This project does not attempt to monitor or upload footage to a cloud service.

## Troubleshooting

- If the camera does not start, confirm the browser permissions and that no other app is using the webcam.
- If the native cursor bridge is offline in browser development mode, run the .NET companion and refresh the dashboard.
- If detection is noisy, increase smoothing and recalibrate the screen mapping.
- If the app loads slowly, the first MediaPipe model fetch may take a moment while the browser downloads the hand-landmark assets.

## Privacy and local processing

Glimouse avoids a cloud backend and keeps camera frames and hand landmarks on the local device. The hand-landmark model is downloaded from Google on first use. The native bridge only accepts requests from localhost and is not intended for remote network exposure.
