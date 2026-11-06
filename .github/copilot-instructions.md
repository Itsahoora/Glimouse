# Copilot instructions for Glimouse

## Project overview

Glimouse is a local-first Windows hand-gesture mouse that uses a webcam and MediaPipe hand tracking to control the cursor. The app is intentionally local-only: camera frames and landmarks stay on-device, and the native bridge only listens on localhost.

- Frontend: Vite + React + TypeScript in `src/`
- Hand tracking worker: `src/workers/handTracking.worker.ts` uses MediaPipe in a Web Worker so camera processing does not block UI rendering
- Gesture math/calibration: `src/lib/mouseMath.ts` contains the cursor mapping, smoothing, pinch logic, and gesture detection
- UI orchestration: `src/App.tsx` handles camera selection, calibration, settings, and native companion calls
- Native companion: `native/GestureMouse.CursorCompanion/` exposes a local HTTP API on `http://127.0.0.1:5103` to issue Windows mouse commands
- Windows tray app: `native/GestureMouse.TrayHost/` hosts the frontend in WebView2 and starts the local cursor bridge

The repo is effectively a small cross-platform app: browser-side logic for detection and UI, plus a Windows-only mouse control bridge. Keep changes aligned with that split.

## Build, test, and lint commands

Install dependencies:

```powershell
npm ci
```

Run the linter:

```powershell
npm run lint
```

Run the test suite:

```powershell
npm test
```

Run a single test file:

```powershell
npm test -- --run src/lib/mouseMath.test.ts
```

Build the frontend bundle:

```powershell
npm run build
```

Run the desktop app from source:

```powershell
npm run desktop
```

Development workflow from the README:

```powershell
npm run dev
```

In a second terminal, start the local cursor companion:

```powershell
dotnet run --project .\native\GestureMouse.CursorCompanion\GestureMouse.CursorCompanion.csproj
```

Publish the Windows tray app:

```powershell
dotnet publish .\native\GestureMouse.TrayHost\GestureMouse.TrayHost.csproj -c Release -r win-x64 --self-contained false
```

CI is configured in `.github/workflows/ci.yml` and runs `npm ci`, `npm run lint`, `npm test`, `npm run build`, and the Windows publish step on pushes and PRs to `main`.

## Key conventions and repo-specific patterns

- Keep gesture math and calibration logic pure and deterministic. `src/lib/mouseMath.ts` is the canonical place for screen mapping, smoothing, pinch timing, and gesture classification.
- Prefer the worker-based MediaPipe path (`src/workers/handTracking.worker.ts`) over doing heavy inference on the main thread.
- Treat `src/App.tsx` as orchestration code: camera setup, event handling, settings persistence, and communication with the local companion, not as a place for core math algorithms.
- Preserve the local-only security model: the cursor companion must only accept loopback/localhost requests and should not be opened to remote network access.
- Settings are persisted in browser `localStorage` under `gestureMouse.settings`; defaults are intentionally opt-in for cursor control, pinch actions, and scrolling.
- Keep Windows-specific implementation details in `native/**`; do not hide platform-specific behavior behind broad abstractions that make the local-only bridge harder to reason about.
- Camera calibration is screen-specific. If you change cursor mapping or smoothing, also check the adjacent tests in `src/lib/mouseMath.test.ts`.
- Browser development mode can preview tracking but does not fully emulate true Windows cursor control; use the tray app or the local companion for realistic behavior.

## Notes for future Copilot sessions

- This repo targets Windows 10+ and Node.js 22+.
- The first real tracking session may need internet access to download the MediaPipe hand model.
- Cursor movement, pinch-to-click, dragging, and scrolling are user-controlled options; keep changes consistent with the opt-in design.
- If code changes touch gesture detection or screen mapping, validate with the focused `mouseMath` tests before broader checking.
