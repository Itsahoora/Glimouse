import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  clamp,
  createCursorFilterState,
  detectGestureState,
  filterCursorTarget,
  mapNormalizedToScreen,
  toPhysicalScreenCoordinates,
  updatePinchAction,
  type CalibratedScreen,
  type Point2D,
  type PinchActionState,
} from './lib/mouseMath';
import { HandTrackingClient } from './lib/handTrackingClient';
import {
  getNativeFailureMessage,
  NativeMouseCommands,
} from './lib/nativeMouseCommands';
import { finishTrackingStop } from './lib/trackingStop';
import {
  applyMouseInputSettingsChange,
  canProcessMouseInput,
  updatePinchSuppression,
} from './lib/mouseInputSafety';
import { defaultSettings, parseSettings, type Settings } from './lib/settings';
import './App.css';

type CameraStatus = 'idle' | 'starting' | 'ready' | 'error';
type EventTone = 'info' | 'success' | 'warn' | 'error';

type EventEntry = {
  id: number;
  message: string;
  tone: EventTone;
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
    return parseSettings(window.localStorage.getItem('gestureMouse.settings'));
  } catch {
    return defaultSettings;
  }
}

function readNativeClientId(): string {
  const key = 'gestureMouse.nativeClientId';
  try {
    const stored = window.localStorage.getItem(key);
    if (stored) {
      return stored;
    }

    const id = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(key, id);
    return id;
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackingTimerRef = useRef<number | null>(null);
  const handTrackingClientRef = useRef<HandTrackingClient | null>(null);
  const handTrackingWorkerIdentityRef = useRef<symbol | null>(null);
  const framePendingRef = useRef(false);
  const trackingSessionRef = useRef(0);
  const cursorFilterRef = useRef(createCursorFilterState());
  const wasPinchingRef = useRef(false);
  const lastPointerSendRef = useRef(0);
  const lastInferenceTimeRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const cursorRequestPendingRef = useRef(false);
  const latestCursorTargetRef = useRef<Point2D | null>(null);
  const cursorRequestIdRef = useRef(0);
  const scrollRequestIdRef = useRef(0);
  const pinchActionStateRef = useRef<PinchActionState>({ startedAt: null, dragging: false });
  const suppressPinchUntilReleaseRef = useRef(false);
  const scrollAnchorRef = useRef<number | null>(null);
  const leftButtonHeldRef = useRef(false);
  const lastScrollSendRef = useRef(0);
  const scrollRequestPendingRef = useRef(false);
  const pendingScrollDeltaRef = useRef(0);
  const settingsRef = useRef(defaultSettings);
  const mountedRef = useRef(true);
  const nativeWasReadyRef = useRef(false);
  const nativeHasConnectedRef = useRef(false);
  const processLandmarksRef = useRef<(landmarks: Point2D[] | null, session: number) => void>(() => {});
  const workerFailureRef = useRef<(session: number, message: string) => void>(() => {});

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
  const settingsStorageWarningShownRef = useRef(false);

  const addEvent = useCallback((message: string, tone: EventTone = 'info') => {
    setEvents((items) => [{ id: Date.now() + Math.random(), message, tone }, ...items].slice(0, 6));
  }, []);

  const [nativeMouseCommands] = useState(() => new NativeMouseCommands(
      (path, body, signal) => fetch(`http://127.0.0.1:5103${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
      undefined,
      undefined,
      readNativeClientId(),
    ));

  useEffect(() => {
    nativeMouseCommands.setFailureHandler((path, error) => {
      if (!mountedRef.current) {
        return;
      }
      setCursorMode('offline');
      addEvent(getNativeFailureMessage(path, error), 'error');
      console.error(error);
    });
    nativeMouseCommands.setConnectionStateHandler((ready) => {
      if (!mountedRef.current) {
        return;
      }
      const hadBeenReady = nativeWasReadyRef.current;
      nativeWasReadyRef.current = ready;
      setCompanionReady(ready);
      if (ready && nativeHasConnectedRef.current && !hadBeenReady) {
        addEvent('The companion session was restored with a fresh mouse session.', 'success');
      } else if (!ready && hadBeenReady) {
        addEvent('The companion session was lost. Reconnecting without replaying old mouse actions.', 'warn');
      }
      if (ready) {
        nativeHasConnectedRef.current = true;
      }
      if (!ready) {
        setCursorMode('offline');
        leftButtonHeldRef.current = false;
        pinchActionStateRef.current = { startedAt: null, dragging: false };
        wasPinchingRef.current = false;
        suppressPinchUntilReleaseRef.current = true;
        scrollAnchorRef.current = null;
        pendingScrollDeltaRef.current = 0;
        scrollRequestPendingRef.current = false;
        cursorRequestPendingRef.current = false;
        latestCursorTargetRef.current = null;
      }
    });
  }, [addEvent, nativeMouseCommands]);

  useEffect(() => {
    settingsRef.current = settings;
    try {
      window.localStorage.setItem('gestureMouse.settings', JSON.stringify(settings));
    } catch (error) {
      if (!settingsStorageWarningShownRef.current) {
        settingsStorageWarningShownRef.current = true;
        addEvent('Settings could not be saved in this browser profile.', 'warn');
        console.warn(error);
      }
    }
  }, [addEvent, settings]);

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
      await nativeMouseCommands.connect();
      if (!mountedRef.current) {
        return;
      }
      setCompanionReady(true);
      addEvent('Cursor companion connected and listening locally.', 'success');
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setCompanionReady(false);
      addEvent('Cursor companion is not running yet. Start it from native/GestureMouse.CursorCompanion.', 'warn');
      console.warn(error);
    }
  }, [addEvent, nativeMouseCommands]);

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

  const sendCursorMove = useCallback(async (screenX: number, screenY: number, session: number) => {
    if (
      session !== trackingSessionRef.current
      || !canProcessMouseInput(settingsRef.current)
      || !companionReady
    ) {
      return;
    }

    const now = performance.now();
    latestCursorTargetRef.current = { x: screenX, y: screenY };
    if (cursorRequestPendingRef.current || now - lastPointerSendRef.current < 30) {
      return;
    }
    cursorRequestPendingRef.current = true;
    const requestId = ++cursorRequestIdRef.current;

    try {
      while (latestCursorTargetRef.current) {
        if (
          session !== trackingSessionRef.current
          || !canProcessMouseInput(settingsRef.current)
          || !companionReady
        ) {
          return;
        }
        const target = latestCursorTargetRef.current;
        latestCursorTargetRef.current = null;
        lastPointerSendRef.current = performance.now();
        const physicalTarget = toPhysicalScreenCoordinates(
          target,
          {
            width: window.screen.width || 1920,
            height: window.screen.height || 1080,
          },
          window.devicePixelRatio,
        );
        await nativeMouseCommands.move(session, physicalTarget.x, physicalTarget.y);
      }

      if (
        session === trackingSessionRef.current
        && canProcessMouseInput(settingsRef.current)
        && companionReady
      ) {
        setCursorMode('movement');
      }
    } catch (error) {
      if (session !== trackingSessionRef.current) {
        return;
      }
      setCursorMode('offline');
      addEvent('The cursor companion failed to complete a movement request.', 'warn');
      console.warn(error);
    } finally {
      if (requestId === cursorRequestIdRef.current) {
        cursorRequestPendingRef.current = false;
      }
    }
  }, [addEvent, companionReady, nativeMouseCommands]);

  const processLandmarks = useCallback((landmarks: Point2D[] | null, session: number) => {
    if (session !== trackingSessionRef.current) {
      return;
    }
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
        void nativeMouseCommands.setLeftButton(session, false);
        leftButtonHeldRef.current = false;
      }
      pinchActionStateRef.current = { startedAt: null, dragging: false };
      wasPinchingRef.current = false;
      suppressPinchUntilReleaseRef.current = false;
      scrollAnchorRef.current = null;
      pendingScrollDeltaRef.current = 0;
      drawHandOverlay(null);
      return;
    }

    const detectedGesture = detectGestureState(landmarks, wasPinchingRef.current);
    wasPinchingRef.current = detectedGesture.pinch;
    const pinchSuppression = updatePinchSuppression({
      leftButtonHeld: leftButtonHeldRef.current,
      pinchStartedAt: pinchActionStateRef.current.startedAt,
      dragging: pinchActionStateRef.current.dragging,
      wasPinching: wasPinchingRef.current,
      scrollAnchor: scrollAnchorRef.current,
      pendingScrollDelta: pendingScrollDeltaRef.current,
      scrollRequestPending: scrollRequestPendingRef.current,
      cursorRequestPending: cursorRequestPendingRef.current,
      latestCursorTarget: latestCursorTargetRef.current,
      suppressPinchUntilRelease: suppressPinchUntilReleaseRef.current,
    }, detectedGesture.pinch);
    suppressPinchUntilReleaseRef.current = pinchSuppression.suppressPinchUntilRelease;
    const pinchState = settingsRef.current.enablePinchActions
      && !suppressPinchUntilReleaseRef.current
      ? updatePinchAction(pinchActionStateRef.current, detectedGesture.pinch, now)
      : { state: { startedAt: null, dragging: false }, action: 'none' as const };
    pinchActionStateRef.current = pinchState.state;
    setGestureName(detectedGesture.name);

    if (canProcessMouseInput(settingsRef.current) && detectedGesture.active) {
      const isPinchingBeforeDrag = settingsRef.current.enablePinchActions
        && !suppressPinchUntilReleaseRef.current
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
        void sendCursorMove(filtered.point.x, filtered.point.y, session);
      }

      if (pinchState.action === 'drag-start') {
        void nativeMouseCommands.setLeftButton(session, true);
        leftButtonHeldRef.current = true;
      } else if (pinchState.action === 'drag-end') {
        void nativeMouseCommands.setLeftButton(session, false);
        leftButtonHeldRef.current = false;
      } else if (pinchState.action === 'click') {
        void nativeMouseCommands.setLeftButton(session, true);
        void nativeMouseCommands.setLeftButton(session, false);
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
            const requestId = ++scrollRequestIdRef.current;
            void nativeMouseCommands.scroll(session, delta)
              .finally(() => {
                if (requestId === scrollRequestIdRef.current) {
                  scrollRequestPendingRef.current = false;
                }
              });
          }
        }
        scrollAnchorRef.current = currentY;
      } else {
        scrollAnchorRef.current = null;
      }
    } else {
      if (leftButtonHeldRef.current) {
        void nativeMouseCommands.setLeftButton(session, false);
        leftButtonHeldRef.current = false;
      }
      pinchActionStateRef.current = { startedAt: null, dragging: false };
      wasPinchingRef.current = false;
      scrollAnchorRef.current = null;
      pendingScrollDeltaRef.current = 0;
    }

    if (!settingsRef.current.enablePinchActions && leftButtonHeldRef.current) {
      void nativeMouseCommands.setLeftButton(session, false);
      leftButtonHeldRef.current = false;
    }

    if (!canProcessMouseInput(settingsRef.current)) {
      scrollAnchorRef.current = null;
      pendingScrollDeltaRef.current = 0;
    }

    drawHandOverlay(landmarks);
  }, [calibration, drawHandOverlay, nativeMouseCommands, sendCursorMove]);
  useLayoutEffect(() => {
    processLandmarksRef.current = processLandmarks;
  }, [processLandmarks]);

  const changeInputSettings = useCallback((next: Settings) => {
    const change = applyMouseInputSettingsChange(
      settingsRef.current,
      next,
      {
        leftButtonHeld: leftButtonHeldRef.current,
        pinchStartedAt: pinchActionStateRef.current.startedAt,
        dragging: pinchActionStateRef.current.dragging,
        wasPinching: wasPinchingRef.current,
        scrollAnchor: scrollAnchorRef.current,
        pendingScrollDelta: pendingScrollDeltaRef.current,
        scrollRequestPending: scrollRequestPendingRef.current,
        cursorRequestPending: cursorRequestPendingRef.current,
        latestCursorTarget: latestCursorTargetRef.current,
        suppressPinchUntilRelease: suppressPinchUntilReleaseRef.current,
      },
      () => {
        const session = trackingSessionRef.current;
        if (session > 0) {
          void nativeMouseCommands.releaseLeftButton(session);
        }
      },
    );
    const { reset, state } = change;
    if (reset.releaseButton) {
      leftButtonHeldRef.current = state.leftButtonHeld;
      pinchActionStateRef.current = {
        startedAt: state.pinchStartedAt,
        dragging: state.dragging,
      };
      wasPinchingRef.current = state.wasPinching;
      suppressPinchUntilReleaseRef.current = state.suppressPinchUntilRelease;

      if (reset.movementDisabled) {
        setCursorMode('standby');
        cursorRequestIdRef.current += 1;
        cursorRequestPendingRef.current = state.cursorRequestPending;
        latestCursorTargetRef.current = state.latestCursorTarget;
        scrollRequestIdRef.current += 1;
        scrollAnchorRef.current = state.scrollAnchor;
        pendingScrollDeltaRef.current = state.pendingScrollDelta;
        scrollRequestPendingRef.current = state.scrollRequestPending;
      }
    }

    settingsRef.current = next;
    setSettings(next);
  }, [nativeMouseCommands]);

  const stopTracking = useCallback(() => finishTrackingStop(
    () => {
      const stoppedSession = trackingSessionRef.current;
      trackingSessionRef.current += 1;
      const trackingClient = handTrackingClientRef.current;
      handTrackingClientRef.current = null;
      handTrackingWorkerIdentityRef.current = null;
      trackingClient?.cancelSession(stoppedSession);
      trackingClient?.terminate();
      framePendingRef.current = false;
      cursorRequestIdRef.current += 1;
      cursorRequestPendingRef.current = false;
      latestCursorTargetRef.current = null;
      scrollRequestIdRef.current += 1;
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
      suppressPinchUntilReleaseRef.current = false;
      cursorFilterRef.current = createCursorFilterState();
      scrollAnchorRef.current = null;
      pendingScrollDeltaRef.current = 0;
      scrollRequestPendingRef.current = false;
      leftButtonHeldRef.current = false;
      lastInferenceTimeRef.current = 0;
      lastVideoTimeRef.current = -1;
    },
    () => nativeMouseCommands.invalidateAndRelease(),
    (status, error) => {
      if (!mountedRef.current) {
        return;
      }
      addEvent(status.message, status.tone);
      if (!status.released) {
        console.error(error);
      }
    },
  ), [addEvent, nativeMouseCommands]);

  const handleWorkerFailure = useCallback((session: number, message: string) => {
    if (session !== trackingSessionRef.current) {
      return;
    }

    framePendingRef.current = false;
    addEvent(`Hand tracking worker failed: ${message}`, 'error');
    console.error(message);
    void stopTracking().finally(() => {
      if (trackingSessionRef.current === session + 1) {
        setCameraStatus('error');
      }
    });
  }, [addEvent, stopTracking]);
  useLayoutEffect(() => {
    workerFailureRef.current = handleWorkerFailure;
  }, [handleWorkerFailure]);

  const startTracking = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('error');
      addEvent('This browser cannot access the camera API.', 'error');
      return;
    }

    const session = ++trackingSessionRef.current;
    try {
      await nativeMouseCommands.connect();
      if (session !== trackingSessionRef.current) {
        return;
      }
      nativeMouseCommands.beginTrackingSession(session);
      cursorFilterRef.current = createCursorFilterState();
      wasPinchingRef.current = false;
      suppressPinchUntilReleaseRef.current = false;
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
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (session !== trackingSessionRef.current) {
            return;
          }

          addEvent('The camera disconnected. Stopping tracking.', 'error');
          void stopTracking().finally(() => setCameraStatus('error'));
        }, { once: true });
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if (session !== trackingSessionRef.current) {
        return;
      }

      setSurfaceReady(true);
      addEvent('Camera stream started; initializing hand tracking.', 'info');

      const worker = new Worker(new URL('./workers/handTracking.worker.ts', import.meta.url));
      const workerIdentity = Symbol('hand-tracking-worker');
      handTrackingWorkerIdentityRef.current = workerIdentity;
      const trackingClient = new HandTrackingClient(worker, session, {
        onResult: (messageSession, landmarks) => {
          if (messageSession !== trackingSessionRef.current) {
            return;
          }
          framePendingRef.current = false;
          processLandmarksRef.current(landmarks, messageSession);
        },
        onError: (messageSession, message) => {
          if (handTrackingWorkerIdentityRef.current !== workerIdentity) {
            return;
          }
          workerFailureRef.current(messageSession, message);
        },
      });
      handTrackingClientRef.current = trackingClient;

      await trackingClient.initialize(session);

      if (session !== trackingSessionRef.current) {
        return;
      }

      setCameraStatus('ready');

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
              if (frameSession !== trackingSessionRef.current || !trackingClient) {
                bitmap.close();
                return;
              }
              if (!trackingClient.postFrame(frameSession, bitmap) && frameSession === trackingSessionRef.current) {
                framePendingRef.current = false;
              }
            })
            .catch((error: unknown) => {
              if (frameSession !== trackingSessionRef.current) {
                return;
              }
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
      trackingSessionRef.current += 1;
      const trackingClient = handTrackingClientRef.current;
      handTrackingClientRef.current = null;
      handTrackingWorkerIdentityRef.current = null;
      if (trackingClient) {
        trackingClient.cancelSession(session);
        trackingClient.terminate();
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
      framePendingRef.current = false;
      cursorRequestIdRef.current += 1;
      cursorRequestPendingRef.current = false;
      latestCursorTargetRef.current = null;
      scrollRequestIdRef.current += 1;
      leftButtonHeldRef.current = false;
      pinchActionStateRef.current = { startedAt: null, dragging: false };
      wasPinchingRef.current = false;
      suppressPinchUntilReleaseRef.current = false;
      scrollAnchorRef.current = null;
      pendingScrollDeltaRef.current = 0;
      scrollRequestPendingRef.current = false;
      void nativeMouseCommands.invalidateAndRelease().catch((releaseError: unknown) => {
        addEvent(
          'Tracking stopped, but native mouse-button release could not be confirmed.',
          'error',
        );
        console.error(releaseError);
      });
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
  }, [addEvent, loadCameraDevices, nativeMouseCommands, selectedCameraId, stopTracking]);

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
    mountedRef.current = true;
    const video = videoRef.current;
    return () => {
      mountedRef.current = false;
      const stoppedSession = trackingSessionRef.current;
      trackingSessionRef.current += 1;
      const trackingClient = handTrackingClientRef.current;
      handTrackingClientRef.current = null;
      handTrackingWorkerIdentityRef.current = null;
      trackingClient?.cancelSession(stoppedSession);
      framePendingRef.current = false;
      cursorRequestIdRef.current += 1;
      cursorRequestPendingRef.current = false;
      latestCursorTargetRef.current = null;
      scrollRequestIdRef.current += 1;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (trackingTimerRef.current !== null) {
        window.clearTimeout(trackingTimerRef.current);
        trackingTimerRef.current = null;
      }
      if (video) {
        video.srcObject = null;
      }
      trackingClient?.terminate();
      void nativeMouseCommands.invalidateAndRelease().catch((error: unknown) => {
        console.error(error);
      });
    };
  }, [nativeMouseCommands]);

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
                onClick={() => changeInputSettings({
                  ...settings,
                  enableCursor: !settings.enableCursor,
                })}
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
                onClick={() => changeInputSettings({
                  ...settings,
                  enablePinchActions: !settings.enablePinchActions,
                })}
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
