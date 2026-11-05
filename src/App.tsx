import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clamp,
  createCursorFilterState,
  detectGestureState,
  filterCursorTarget,
  mapNormalizedToScreen,
  updatePinchAction,
  type CalibratedScreen,
  type Point2D,
  type PinchActionState,
} from './lib/mouseMath';
import './App.css';

type CameraStatus = 'idle' | 'starting' | 'ready' | 'error';
type EventTone = 'info' | 'success' | 'warn' | 'error';

type EventEntry = {
  id: number;
  message: string;
  tone: EventTone;
};

type Settings = {
  sensitivity: number;
  smoothing: number;
  enableCursor: boolean;
  enablePinchActions: boolean;
  enableScroll: boolean;
  mirrorPreview: boolean;
};

type HandWorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; landmarks: Point2D[] | null }
  | { type: 'error'; message: string };

const defaultSettings: Settings = {
  sensitivity: 1.05,
  smoothing: 0.58,
  enableCursor: false,
  enablePinchActions: false,
  enableScroll: false,
  mirrorPreview: false,
};

const DEFAULT_CALIBRATION: CalibratedScreen = {
  centerX: 640,
  centerY: 360,
  width: 1280,
  height: 720,
  screen: { width: window.screen.width || 1920, height: window.screen.height || 1080 },
};

const handConnections = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

function readSavedSettings(): Settings {
  if (typeof window === 'undefined') {
    return defaultSettings;
  }

  try {
    const raw = window.localStorage.getItem('gestureMouse.settings');
    if (!raw) {
      return defaultSettings;
    }

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return defaultSettings;
    }

    const saved = parsed as Record<string, unknown>;
    const numericSetting = (key: 'sensitivity' | 'smoothing', minimum: number, maximum: number) => {
      const value = saved[key];
      return typeof value === 'number' && Number.isFinite(value)
        ? clamp(value, minimum, maximum)
        : defaultSettings[key];
    };
    const booleanSetting = (key: 'enableCursor' | 'enableScroll' | 'mirrorPreview') => {
      const value = saved[key];
      return typeof value === 'boolean' ? value : defaultSettings[key];
    };
    const pinchActions = saved.enablePinchActions;

    return {
      sensitivity: numericSetting('sensitivity', 0.4, 2),
      smoothing: numericSetting('smoothing', 0.1, 0.9),
      enableCursor: booleanSetting('enableCursor'),
      enablePinchActions: typeof pinchActions === 'boolean'
        ? pinchActions
        : Boolean(saved.enableClick || saved.enableDrag),
      enableScroll: booleanSetting('enableScroll'),
      mirrorPreview: booleanSetting('mirrorPreview'),
    };
  } catch {
    return defaultSettings;
  }
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackingTimerRef = useRef<number | null>(null);
  const handWorkerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const workerReadyPromiseRef = useRef<Promise<void> | null>(null);
  const framePendingRef = useRef(false);
  const trackingSessionRef = useRef(0);
  const cursorFilterRef = useRef(createCursorFilterState());
  const wasPinchingRef = useRef(false);
  const lastPointerSendRef = useRef(0);
  const lastInferenceTimeRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const cursorRequestPendingRef = useRef(false);
  const latestCursorTargetRef = useRef<Point2D | null>(null);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pinchActionStateRef = useRef<PinchActionState>({ startedAt: null, dragging: false });
  const scrollAnchorRef = useRef<number | null>(null);
  const leftButtonHeldRef = useRef(false);
  const lastScrollSendRef = useRef(0);
  const scrollRequestPendingRef = useRef(false);
  const pendingScrollDeltaRef = useRef(0);
  const settingsRef = useRef(defaultSettings);

  const [settings, setSettings] = useState<Settings>(readSavedSettings);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [surfaceReady, setSurfaceReady] = useState(false);
  const [handDetected, setHandDetected] = useState(false);
  const [gestureName, setGestureName] = useState('No hand');
  const [cursorMode, setCursorMode] = useState<'standby' | 'movement' | 'offline'>('standby');
  const [companionReady, setCompanionReady] = useState(false);
  const [calibration, setCalibration] = useState<CalibratedScreen>(DEFAULT_CALIBRATION);
  const [events, setEvents] = useState<EventEntry[]>([
    { id: 1, message: 'Glimouse ready for camera calibration.', tone: 'info' },
    { id: 2, message: 'Movement mode is disabled until you opt in.', tone: 'warn' },
  ]);

  const addEvent = useCallback((message: string, tone: EventTone = 'info') => {
    setEvents((items) => [{ id: Date.now() + Math.random(), message, tone }, ...items].slice(0, 6));
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
    window.localStorage.setItem('gestureMouse.settings', JSON.stringify(settings));
  }, [settings]);

  const statusSummary = useMemo(() => {
    if (cameraStatus === 'starting') {
      return 'Starting tracking';
    }
    if (cameraStatus === 'ready') {
      return handDetected ? 'Tracking ready' : 'Waiting for hand';
    }
    if (cameraStatus === 'error') {
      return 'Tracking unavailable';
    }
    return 'Waiting for start';
  }, [cameraStatus, handDetected]);

  const testCursorCompanion = useCallback(async () => {
    try {
      const response = await fetch('http://127.0.0.1:5103/health');
      if (!response.ok) {
        throw new Error('Companion status not healthy');
      }
      setCompanionReady(true);
      addEvent('Cursor companion connected and listening locally.', 'success');
    } catch (error) {
      setCompanionReady(false);
      addEvent('Cursor companion is not running yet. Start it from native/GestureMouse.CursorCompanion.', 'warn');
      console.warn(error);
    }
  }, [addEvent]);

  const sendNativeCommand = useCallback((path: string, body?: object) => {
    const request = async () => {
      const response = await fetch(`http://127.0.0.1:5103${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) {
        throw new Error(`Native command failed: ${path} (${response.status})`);
      }
    };

    commandQueueRef.current = commandQueueRef.current
      .then(request)
      .catch((error: unknown) => {
        setCursorMode('offline');
        addEvent('A mouse action was rejected by the local companion.', 'error');
        console.error(error);
      });
    return commandQueueRef.current;
  }, [addEvent]);

  const loadCameraDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((item) => item.kind === 'videoinput');
      setCameraDevices(videoDevices);

      if (videoDevices.length > 0 && !selectedCameraId) {
        setSelectedCameraId(videoDevices[0].deviceId);
      }
    } catch (error) {
      addEvent('Unable to list camera devices. Glimouse will try the default camera.', 'warn');
      console.warn(error);
    }
  }, [addEvent, selectedCameraId]);

  const drawHandOverlay = useCallback((landmarks: Point2D[] | null) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !landmarks || landmarks.length === 0) {
      if (canvas) {
        const context = canvas.getContext('2d');
        context?.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const width = video.videoWidth || 640;
    const height = video.videoHeight || 360;
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(125, 247, 213, 0.92)';

    for (const [start, end] of handConnections) {
      const from = landmarks[start];
      const to = landmarks[end];
      context.beginPath();
      context.moveTo(from.x * width, from.y * height);
      context.lineTo(to.x * width, to.y * height);
      context.stroke();
    }

    for (const point of landmarks) {
      context.beginPath();
      context.fillStyle = '#d7ffee';
      context.arc(point.x * width, point.y * height, 4, 0, Math.PI * 2);
      context.fill();
    }
  }, []);

  const sendCursorMove = useCallback(async (screenX: number, screenY: number) => {
    if (!settingsRef.current.enableCursor || !companionReady) {
      return;
    }

    const now = performance.now();
    latestCursorTargetRef.current = { x: screenX, y: screenY };
    if (cursorRequestPendingRef.current || now - lastPointerSendRef.current < 30) {
      return;
    }
    cursorRequestPendingRef.current = true;

    try {
      while (latestCursorTargetRef.current) {
        const target = latestCursorTargetRef.current;
        latestCursorTargetRef.current = null;
        lastPointerSendRef.current = performance.now();
        const response = await fetch('http://127.0.0.1:5103/cursor/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            x: Math.round(clamp(target.x, 0, Math.max((window.screen.width || 1920) - 1, 0))),
            y: Math.round(clamp(target.y, 0, Math.max((window.screen.height || 1080) - 1, 0))),
          }),
        });

        if (!response.ok) {
          throw new Error(`Movement request failed (${response.status})`);
        }
      }

      setCursorMode('movement');
    } catch (error) {
      setCursorMode('offline');
      addEvent('The cursor companion rejected a movement request.', 'warn');
      console.warn(error);
    } finally {
      cursorRequestPendingRef.current = false;
    }
  }, [addEvent, companionReady]);

  const processLandmarks = useCallback((landmarks: Point2D[] | null) => {
    const now = performance.now();
    const deltaSeconds = lastInferenceTimeRef.current === 0
      ? 1 / 30
      : (now - lastInferenceTimeRef.current) / 1000;
    lastInferenceTimeRef.current = now;
    const video = videoRef.current;

    setHandDetected(Boolean(landmarks));
    if (!landmarks || !video) {
      setGestureName('No hand');
      setCursorMode('standby');
      if (leftButtonHeldRef.current) {
        void sendNativeCommand('/mouse/left', { pressed: false });
        leftButtonHeldRef.current = false;
      }
      pinchActionStateRef.current = { startedAt: null, dragging: false };
      wasPinchingRef.current = false;
      scrollAnchorRef.current = null;
      drawHandOverlay(null);
      return;
    }

    const detectedGesture = detectGestureState(landmarks, wasPinchingRef.current);
    wasPinchingRef.current = detectedGesture.pinch;
    const pinchState = settingsRef.current.enablePinchActions
      ? updatePinchAction(pinchActionStateRef.current, detectedGesture.pinch, now)
      : { state: { startedAt: null, dragging: false }, action: 'none' as const };
    pinchActionStateRef.current = pinchState.state;
    setGestureName(detectedGesture.name);

    if (settingsRef.current.enableCursor && detectedGesture.active) {
      const isPinchingBeforeDrag = settingsRef.current.enablePinchActions
        && detectedGesture.pinch
        && !pinchState.state.dragging;
      if (!isPinchingBeforeDrag) {
        const target = mapNormalizedToScreen(
          {
            x: settingsRef.current.mirrorPreview ? 1 - landmarks[8].x : landmarks[8].x,
            y: landmarks[8].y,
          },
          { width: video.videoWidth || 640, height: video.videoHeight || 360 },
          calibration,
          settingsRef.current.sensitivity,
        );
        const filtered = filterCursorTarget(
          cursorFilterRef.current,
          target,
          settingsRef.current.smoothing,
          deltaSeconds,
        );
        cursorFilterRef.current = filtered.state;
        void sendCursorMove(filtered.point.x, filtered.point.y);
      }

      if (pinchState.action === 'drag-start') {
        void sendNativeCommand('/mouse/left', { pressed: true });
        leftButtonHeldRef.current = true;
      } else if (pinchState.action === 'drag-end') {
        void sendNativeCommand('/mouse/left', { pressed: false });
        leftButtonHeldRef.current = false;
      } else if (pinchState.action === 'click') {
        void sendNativeCommand('/mouse/left', { pressed: true });
        void sendNativeCommand('/mouse/left', { pressed: false });
      }

      if (settingsRef.current.enableScroll && detectedGesture.openPalm) {
        const currentY = landmarks[9].y;
        const previousY = scrollAnchorRef.current;
        if (previousY !== null) {
          pendingScrollDeltaRef.current += (previousY - currentY) * 1200;
          if (
            Math.abs(pendingScrollDeltaRef.current) >= 30
            && !scrollRequestPendingRef.current
            && now - lastScrollSendRef.current >= 75
          ) {
            const delta = Math.trunc(clamp(pendingScrollDeltaRef.current, -1200, 1200));
            pendingScrollDeltaRef.current -= delta;
            lastScrollSendRef.current = now;
            scrollRequestPendingRef.current = true;
            void fetch('http://127.0.0.1:5103/mouse/scroll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ delta }),
            })
              .then((response) => {
                if (!response.ok) {
                  throw new Error(`Scroll request failed (${response.status})`);
                }
              })
              .catch((error: unknown) => {
                addEvent('The local companion rejected a scroll request.', 'error');
                console.error(error);
              })
              .finally(() => {
                scrollRequestPendingRef.current = false;
              });
          }
        }
        scrollAnchorRef.current = currentY;
      } else {
        scrollAnchorRef.current = null;
      }
    } else {
      if (leftButtonHeldRef.current) {
        void sendNativeCommand('/mouse/left', { pressed: false });
        leftButtonHeldRef.current = false;
      }
      pinchActionStateRef.current = { startedAt: null, dragging: false };
      wasPinchingRef.current = false;
      scrollAnchorRef.current = null;
    }

    if (!settingsRef.current.enablePinchActions && leftButtonHeldRef.current) {
      void sendNativeCommand('/mouse/left', { pressed: false });
      leftButtonHeldRef.current = false;
    }

    drawHandOverlay(landmarks);
  }, [addEvent, calibration, drawHandOverlay, sendCursorMove, sendNativeCommand]);

  const stopTracking = useCallback(async () => {
    trackingSessionRef.current += 1;
    framePendingRef.current = false;
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (trackingTimerRef.current !== null) {
      window.clearTimeout(trackingTimerRef.current);
      trackingTimerRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraStatus('idle');
    setSurfaceReady(false);
    setHandDetected(false);
    setGestureName('No hand');
    setCursorMode('standby');
    pinchActionStateRef.current = { startedAt: null, dragging: false };
    wasPinchingRef.current = false;
    cursorFilterRef.current = createCursorFilterState();
    scrollAnchorRef.current = null;
    pendingScrollDeltaRef.current = 0;
    scrollRequestPendingRef.current = false;
    leftButtonHeldRef.current = false;
    lastInferenceTimeRef.current = 0;
    lastVideoTimeRef.current = -1;

    await sendNativeCommand('/cursor/stop');
  }, [sendNativeCommand]);

  const startTracking = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('error');
      addEvent('This browser cannot access the camera API.', 'error');
      return;
    }

    const session = ++trackingSessionRef.current;
    try {
      cursorFilterRef.current = createCursorFilterState();
      wasPinchingRef.current = false;
      setCameraStatus('starting');
      await loadCameraDevices();
      if (session !== trackingSessionRef.current) {
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: selectedCameraId ? { exact: selectedCameraId } : undefined,
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      if (session !== trackingSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if (session !== trackingSessionRef.current) {
        return;
      }

      setSurfaceReady(true);
      addEvent('Camera stream started; initializing hand tracking.', 'info');

      let handWorker = handWorkerRef.current;
      if (!handWorker) {
        handWorker = new Worker(new URL('./workers/handTracking.worker.ts', import.meta.url));
        handWorkerRef.current = handWorker;
      }

      handWorker.onmessage = (event: MessageEvent<HandWorkerMessage>) => {
        const message = event.data;
        if (message.type === 'ready') {
          workerReadyRef.current = true;
          return;
        }
        if (message.type === 'error') {
          framePendingRef.current = false;
          addEvent(`Hand tracking worker failed: ${message.message}`, 'error');
          console.error(message.message);
          void stopTracking().finally(() => setCameraStatus('error'));
          return;
        }

        framePendingRef.current = false;
        processLandmarks(message.landmarks);
      };
      if (!workerReadyRef.current) {
        workerReadyPromiseRef.current ??= new Promise<void>((resolve, reject) => {
          const worker = handWorkerRef.current;
          if (!worker) {
            reject(new Error('Hand tracking worker was not created.'));
            return;
          }
          const previousHandler = worker.onmessage;
          worker.onmessage = (event: MessageEvent<HandWorkerMessage>) => {
            const message = event.data;
            if (message.type === 'ready') {
              workerReadyRef.current = true;
              worker.onmessage = previousHandler;
              resolve();
              return;
            }
            if (message.type === 'error') {
              worker.onmessage = previousHandler;
              workerReadyPromiseRef.current = null;
              reject(new Error(message.message));
            }
          };
          worker.addEventListener('error', (event) => {
            workerReadyPromiseRef.current = null;
            reject(new Error(event.message || 'The hand tracking worker could not start.'));
          }, { once: true });
          worker.postMessage({ type: 'init' });
        });
        await workerReadyPromiseRef.current;
      }

      if (session !== trackingSessionRef.current) {
        return;
      }

      setCameraStatus('ready');
      handWorker.onerror = (event) => {
        framePendingRef.current = false;
        addEvent(`Hand tracking worker failed: ${event.message}`, 'error');
        console.error(event.message);
        void stopTracking().finally(() => setCameraStatus('error'));
      };

      const scan = () => {
        const video = videoRef.current;
        if (session !== trackingSessionRef.current) {
          return;
        }
        if (
          video
          && !video.paused
          && video.readyState >= 2
          && video.currentTime !== lastVideoTimeRef.current
          && !framePendingRef.current
        ) {
          lastVideoTimeRef.current = video.currentTime;
          framePendingRef.current = true;
          const frameSession = session;
          void createImageBitmap(video)
            .then((bitmap) => {
              if (frameSession !== trackingSessionRef.current || !handWorkerRef.current) {
                bitmap.close();
                framePendingRef.current = false;
                return;
              }
              handWorkerRef.current.postMessage({ type: 'frame', bitmap }, [bitmap]);
            })
            .catch((error: unknown) => {
              framePendingRef.current = false;
              addEvent('Unable to prepare a camera frame for hand tracking.', 'error');
              console.error(error);
            });
        }

        trackingTimerRef.current = window.setTimeout(scan, 12);
      };

      scan();
    } catch (error) {
      if (session !== trackingSessionRef.current) {
        return;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (trackingTimerRef.current !== null) {
        window.clearTimeout(trackingTimerRef.current);
        trackingTimerRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      handWorkerRef.current?.terminate();
      handWorkerRef.current = null;
      workerReadyRef.current = false;
      workerReadyPromiseRef.current = null;
      framePendingRef.current = false;
      setSurfaceReady(false);
      setCameraStatus('error');
      const isCameraError = error instanceof DOMException;
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const errorMessage = error instanceof Error ? error.message : String(error);
      const guidance = isCameraError && errorName === 'NotAllowedError'
        ? ' In Windows Settings, go to Privacy & security > Camera, turn on Camera access and Let desktop apps access your camera, then restart Glimouse.'
        : isCameraError && errorName === 'NotFoundError'
          ? ' Connect or enable a camera, then select it in Camera source.'
          : isCameraError && errorName === 'NotReadableError'
            ? ' Close other apps using the camera and try again.'
            : isCameraError
              ? ''
              : ' Check your internet connection so the hand-tracking model can download, then restart tracking.';
      const failureType = isCameraError ? 'start the camera' : 'initialize hand tracking';
      addEvent(`Unable to ${failureType} (${errorName}: ${errorMessage}).${guidance}`, 'error');
      console.error(error);
    }
  }, [addEvent, loadCameraDevices, processLandmarks, selectedCameraId, stopTracking]);

  useEffect(() => {
    let active = true;
    if (navigator.mediaDevices?.enumerateDevices) {
      void navigator.mediaDevices.enumerateDevices()
        .then((devices) => {
          if (!active) {
            return;
          }
          const videoDevices = devices.filter((item) => item.kind === 'videoinput');
          setCameraDevices(videoDevices);
          setSelectedCameraId((current) => current || videoDevices[0]?.deviceId || '');
        })
        .catch((error: unknown) => {
          if (active) {
            addEvent('Unable to list camera devices. Glimouse will try the default camera.', 'warn');
            console.warn(error);
          }
        });
    }
    void testCursorCompanion();
    return () => {
      active = false;
    };
  }, [addEvent, testCursorCompanion]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      trackingSessionRef.current += 1;
      framePendingRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (trackingTimerRef.current !== null) {
        window.clearTimeout(trackingTimerRef.current);
        trackingTimerRef.current = null;
      }
      if (video) {
        video.srcObject = null;
      }
      handWorkerRef.current?.terminate();
      handWorkerRef.current = null;
      workerReadyRef.current = false;
      workerReadyPromiseRef.current = null;
      void fetch('http://127.0.0.1:5103/cursor/stop', { method: 'POST' })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Cursor release failed (${response.status})`);
          }
        })
        .catch((error: unknown) => {
          console.error('Unable to release native mouse buttons during cleanup.', error);
        });
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar panel">
        <div className="brand-block">
          <div className="brand-mark">GM</div>
          <div>
            <p className="eyebrow">Local-first control</p>
            <h1>Glimouse</h1>
          </div>
        </div>

        <div className="topbar-actions">
          <span className={`status-pill ${cameraStatus}`}>{statusSummary}</span>
          <button type="button" className="primary-button" onClick={cameraStatus === 'ready' || cameraStatus === 'starting' ? stopTracking : startTracking}>
            {cameraStatus === 'ready' || cameraStatus === 'starting' ? 'Stop tracking' : 'Start tracking'}
          </button>
        </div>
      </header>

      <main className="dashboard-grid">
        <section className="camera-panel panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Capture</p>
              <h2>Camera preview</h2>
            </div>
            <span className={`signal-dot ${handDetected ? 'active' : ''}`} />
          </div>

          <div className={`camera-frame ${settings.mirrorPreview ? 'is-mirrored' : ''}`}>
            <video ref={videoRef} autoPlay playsInline muted className={surfaceReady ? 'is-live' : ''} />
            <canvas ref={canvasRef} className="landmark-overlay" />
            {!surfaceReady && (
              <div className="empty-state">
                <div className="empty-icon">◎</div>
                <p>Camera is offline. Start tracking to begin recognition.</p>
              </div>
            )}
          </div>

          <div className="mini-stats">
            <div>
              <label>Mode</label>
              <strong>{settings.enableCursor ? 'Movement enabled' : 'Movement locked'}</strong>
            </div>
            <div>
              <label>Gesture</label>
              <strong>{gestureName}</strong>
            </div>
            <div>
              <label>Cursor</label>
              <strong>{cursorMode}</strong>
            </div>
          </div>
        </section>

        <aside className="side-panel">
          <div className="panel settings-panel">
            <div className="panel-header compact">
              <div>
                <p className="eyebrow">Controls</p>
                <h2>Tracking</h2>
              </div>
            </div>

            <label className="field-label">
              Sensitivity
              <input
                type="range"
                min="0.4"
                max="2"
                step="0.05"
                value={settings.sensitivity}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, sensitivity: Number(event.target.value) }))
                }
              />
              <span>{settings.sensitivity.toFixed(2)}x</span>
            </label>

            <label className="field-label">
              Smoothness
              <input
                type="range"
                min="0.1"
                max="0.9"
                step="0.01"
                value={settings.smoothing}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, smoothing: Number(event.target.value) }))
                }
              />
              <span>{Math.round(settings.smoothing * 100)}% · filters small hand tremors</span>
            </label>

            <div className="smoothness-presets" role="group" aria-label="Cursor smoothness presets">
              {[
                { label: 'Fast', value: 0.25 },
                { label: 'Balanced', value: 0.58 },
                { label: 'Steady', value: 0.82 },
              ].map((preset) => (
                <button
                  type="button"
                  key={preset.label}
                  className={Math.abs(settings.smoothing - preset.value) < 0.005 ? 'selected' : ''}
                  aria-pressed={Math.abs(settings.smoothing - preset.value) < 0.005}
                  onClick={() => setSettings((current) => ({ ...current, smoothing: preset.value }))}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="toggle-row">
              <span>Movement mode</span>
              <button
                type="button"
                className={`switch ${settings.enableCursor ? 'on' : ''}`}
                aria-label="Enable pointer movement"
                aria-pressed={settings.enableCursor}
                onClick={() =>
                  setSettings((current) => ({ ...current, enableCursor: !current.enableCursor }))
                }
              >
                <span />
              </button>
            </div>

            <div className="toggle-row">
              <span>Mirror camera preview</span>
              <button
                type="button"
                className={`switch ${settings.mirrorPreview ? 'on' : ''}`}
                aria-label="Mirror camera preview"
                aria-pressed={settings.mirrorPreview}
                onClick={() =>
                  setSettings((current) => ({ ...current, mirrorPreview: !current.mirrorPreview }))
                }
              >
                <span />
              </button>
            </div>

            <div className="toggle-row">
              <span>Pinch: click / hold to drag</span>
              <button
                type="button"
                className={`switch ${settings.enablePinchActions ? 'on' : ''}`}
                aria-label="Enable pinch click and hold-to-drag"
                aria-pressed={settings.enablePinchActions}
                disabled={!settings.enableCursor}
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    enablePinchActions: !current.enablePinchActions,
                  }))
                }
              >
                <span />
              </button>
            </div>
            <p className="control-hint">Pinch and release to click. Hold the pinch for 0.42 seconds to drag, then release to drop.</p>

            <div className="toggle-row">
              <span>Open-palm scrolling</span>
              <button
                type="button"
                className={`switch ${settings.enableScroll ? 'on' : ''}`}
                aria-label="Enable open-palm scrolling"
                aria-pressed={settings.enableScroll}
                disabled={!settings.enableCursor}
                onClick={() => setSettings((current) => ({ ...current, enableScroll: !current.enableScroll }))}
              >
                <span />
              </button>
            </div>

            <div className="action-stack">
              <button type="button" className="secondary-button" onClick={() => setCalibration(DEFAULT_CALIBRATION)}>
                Reset calibration
              </button>
              <button type="button" className="secondary-button" onClick={testCursorCompanion}>
                {companionReady ? 'Companion healthy' : 'Check companion'}
              </button>
            </div>
          </div>

          <div className="panel quick-panel">
            <div className="panel-header compact">
              <div>
                <p className="eyebrow">Status</p>
                <h2>Readiness</h2>
              </div>
            </div>
            <ul className="readiness-list">
              <li><span className={cameraStatus === 'ready' ? 'ok' : 'warn'} /> Camera</li>
              <li><span className={handDetected ? 'ok' : 'warn'} /> Hand detection</li>
              <li><span className={companionReady ? 'ok' : 'warn'} /> Native cursor</li>
            </ul>
          </div>
        </aside>
      </main>

      <section className="bottom-grid">
        <div className="panel compact-panel">
          <div className="panel-header compact">
            <div>
              <p className="eyebrow">Calibration</p>
              <h2>Screen mapping</h2>
            </div>
          </div>

          <div className="calibration-box">
            <div>
              <label>Center X</label>
              <input
                type="number"
                value={Math.round(calibration.centerX)}
                onChange={(event) =>
                  setCalibration((current) => ({ ...current, centerX: Number(event.target.value) }))
                }
              />
            </div>
            <div>
              <label>Center Y</label>
              <input
                type="number"
                value={Math.round(calibration.centerY)}
                onChange={(event) =>
                  setCalibration((current) => ({ ...current, centerY: Number(event.target.value) }))
                }
              />
            </div>
            <div>
              <label>Width</label>
              <input
                type="number"
                value={Math.round(calibration.width)}
                onChange={(event) =>
                  setCalibration((current) => ({ ...current, width: Number(event.target.value) }))
                }
              />
            </div>
            <div>
              <label>Height</label>
              <input
                type="number"
                value={Math.round(calibration.height)}
                onChange={(event) =>
                  setCalibration((current) => ({ ...current, height: Number(event.target.value) }))
                }
              />
            </div>
          </div>
        </div>

        <div className="panel compact-panel">
          <div className="panel-header compact">
            <div>
              <p className="eyebrow">Live activity</p>
              <h2>Events</h2>
            </div>
          </div>

          <ul className="event-list">
            {events.map((entry) => (
              <li key={entry.id} className={`event ${entry.tone}`}>
                {entry.message}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="camera-picker panel">
        <label htmlFor="camera-select">Camera source</label>
        <select
          id="camera-select"
          value={selectedCameraId}
          disabled={cameraStatus === 'starting' || cameraStatus === 'ready'}
          onChange={(event) => setSelectedCameraId(event.target.value)}
        >
          {cameraDevices.length === 0 ? (
            <option value="">No camera found</option>
          ) : (
            cameraDevices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || 'Camera'}
              </option>
            ))
          )}
        </select>
      </div>
    </div>
  );
}

export default App;
