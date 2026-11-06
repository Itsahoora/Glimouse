export type Point2D = { x: number; y: number };
export type ScreenBounds = { width: number; height: number };

// Convert WebView CSS pixels to the physical pixels accepted by the PMv2-aware native bridge.
export function toPhysicalScreenCoordinates(
  point: Point2D,
  screen: ScreenBounds,
  devicePixelRatio: number,
): Point2D {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const width = Math.max(1, Math.round(screen.width * scale));
  const height = Math.max(1, Math.round(screen.height * scale));

  return {
    x: clamp(Math.round(point.x * scale), 0, width - 1),
    y: clamp(Math.round(point.y * scale), 0, height - 1),
  };
}

export type CalibratedScreen = {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  screen: ScreenBounds;
};

export type PinchActionState = {
  startedAt: number | null;
  dragging: boolean;
};

export type PinchAction = 'none' | 'click' | 'drag-start' | 'drag-end';
export type CursorFilterState = {
  previousTarget: Point2D | null;
  position: Point2D | null;
  velocity: Point2D;
};

const calibrationReference = { width: 1280, height: 720 };
export const PINCH_CONFIRM_MS = 100;
export const PINCH_DRAG_HOLD_MS = 420;
const DERIVATIVE_CUTOFF_HZ = 1;

export function updatePinchAction(
  state: PinchActionState,
  pinching: boolean,
  now: number,
): { state: PinchActionState; action: PinchAction } {
  if (pinching) {
    const startedAt = state.startedAt ?? now;
    if (!state.dragging && now - startedAt >= PINCH_DRAG_HOLD_MS) {
      return { state: { startedAt, dragging: true }, action: 'drag-start' };
    }

    return { state: { ...state, startedAt }, action: 'none' };
  }

  if (state.startedAt === null) {
    return { state, action: 'none' };
  }

  const duration = now - state.startedAt;
  const action = state.dragging
    ? 'drag-end'
    : duration >= PINCH_CONFIRM_MS
      ? 'click'
      : 'none';

  return { state: { startedAt: null, dragging: false }, action };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function createCursorFilterState(): CursorFilterState {
  return {
    previousTarget: null,
    position: null,
    velocity: { x: 0, y: 0 },
  };
}

function smoothingAlpha(cutoffHz: number, deltaSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / deltaSeconds);
}

export function filterCursorTarget(
  state: CursorFilterState,
  target: Point2D,
  smoothness: number,
  deltaSeconds: number,
): { state: CursorFilterState; point: Point2D } {
  if (!state.position || !state.previousTarget) {
    const nextState = {
      previousTarget: target,
      position: target,
      velocity: { x: 0, y: 0 },
    };
    return { state: nextState, point: target };
  }

  const elapsed = clamp(deltaSeconds, 1 / 120, 0.1);
  const filteredSmoothness = clamp(smoothness, 0.1, 0.9);
  const minCutoffHz = 1.5 - filteredSmoothness * 1.35;
  const beta = 0.004 + filteredSmoothness * 0.014;
  const derivativeAlpha = smoothingAlpha(DERIVATIVE_CUTOFF_HZ, elapsed);
  const rawVelocity = {
    x: (target.x - state.previousTarget.x) / elapsed,
    y: (target.y - state.previousTarget.y) / elapsed,
  };
  const velocity = {
    x: state.velocity.x + derivativeAlpha * (rawVelocity.x - state.velocity.x),
    y: state.velocity.y + derivativeAlpha * (rawVelocity.y - state.velocity.y),
  };
  const alphaX = smoothingAlpha(minCutoffHz + beta * Math.abs(velocity.x), elapsed);
  const alphaY = smoothingAlpha(minCutoffHz + beta * Math.abs(velocity.y), elapsed);
  const point = {
    x: state.position.x + alphaX * (target.x - state.position.x),
    y: state.position.y + alphaY * (target.y - state.position.y),
  };

  const nextState = {
    previousTarget: target,
    position: point,
    velocity,
  };
  return { state: nextState, point };
}

export function mapNormalizedToScreen(
  point: Point2D,
  cameraBounds: ScreenBounds,
  calibration: CalibratedScreen,
  sensitivity: number,
): Point2D {
  const normalizedX = clamp(point.x, 0, 1);
  const normalizedY = clamp(point.y, 0, 1);

  const scaleX = cameraBounds.width / calibrationReference.width;
  const scaleY = cameraBounds.height / calibrationReference.height;
  const centerX = calibration.centerX * scaleX;
  const centerY = calibration.centerY * scaleY;
  const calibrationWidth = calibration.width * scaleX;
  const calibrationHeight = calibration.height * scaleY;
  const localX = (normalizedX * cameraBounds.width - centerX) / Math.max(calibrationWidth, 1);
  const localY = (normalizedY * cameraBounds.height - centerY) / Math.max(calibrationHeight, 1);

  const scale = 0.9 + sensitivity * 0.55;
  const screenX = clamp(
    calibration.screen.width / 2 + localX * calibration.screen.width * scale,
    0,
    calibration.screen.width,
  );
  const screenY = clamp(
    calibration.screen.height / 2 + localY * calibration.screen.height * scale,
    0,
    calibration.screen.height,
  );

  return { x: screenX, y: screenY };
}

export function distance(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function detectGestureState(landmarks: Point2D[] | null, wasPinching = false): {
  name: string;
  active: boolean;
  pinch: boolean;
  openPalm: boolean;
} {
  if (!landmarks || landmarks.length < 21) {
    return { name: 'No hand', active: false, pinch: false, openPalm: false };
  }

  const wrist = landmarks[0];
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const palmScale = distance(wrist, landmarks[9]);
  const pinchThreshold = wasPinching ? 0.48 : 0.38;
  const pinch = palmScale > 0.025 && distance(thumbTip, indexTip) < palmScale * pinchThreshold;
  const fingerExtensions = [
    landmarks[8].y < landmarks[6].y,
    landmarks[12].y < landmarks[10].y,
    landmarks[16].y < landmarks[14].y,
    landmarks[20].y < landmarks[18].y,
  ];
  const extendedCount = fingerExtensions.filter(Boolean).length;
  const openPalm = extendedCount >= 3;
  const indexRaised = fingerExtensions[0];
  const allFingersFolded = extendedCount === 0;

  if (pinch) {
    return { name: 'Pinch', active: true, pinch, openPalm };
  }

  if (indexRaised && extendedCount === 1) {
    return { name: 'Point', active: true, pinch, openPalm };
  }

  if (allFingersFolded) {
    return { name: 'Closed fist', active: false, pinch, openPalm };
  }

  if (openPalm) {
    return { name: 'Open palm', active: true, pinch, openPalm };
  }

  return { name: 'Tracking', active: true, pinch, openPalm };
}
