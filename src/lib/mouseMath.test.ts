import { describe, expect, it } from 'vitest';
import {
  clamp,
  createCursorFilterState,
  detectGestureState,
  filterCursorTarget,
  mapNormalizedToScreen,
  PINCH_DRAG_HOLD_MS,
  toPhysicalScreenCoordinates,
  updatePinchAction,
  type PinchActionState,
} from './mouseMath';

describe('clamp', () => {
  it('keeps values within the allowed range', () => {
    expect(clamp(12, 0, 10)).toBe(10);
    expect(clamp(-4, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe('mapNormalizedToScreen', () => {
  it('maps the camera midpoint to the center of the primary display', () => {
    const calibration = {
      centerX: 640,
      centerY: 360,
      width: 1280,
      height: 720,
      screen: { width: 1920, height: 1080 },
    };

    const result = mapNormalizedToScreen({ x: 0.5, y: 0.5 }, { width: 640, height: 360 }, calibration, 1);

    expect(result.x).toBe(960);
    expect(result.y).toBe(540);
  });

  it('can reverse horizontal mapping to match a mirrored preview', () => {
    const calibration = {
      centerX: 640,
      centerY: 360,
      width: 1280,
      height: 720,
      screen: { width: 1920, height: 1080 },
    };
    const left = mapNormalizedToScreen({ x: 0.25, y: 0.5 }, { width: 1280, height: 720 }, calibration, 1);
    const mirroredLeft = mapNormalizedToScreen({ x: 0.75, y: 0.5 }, { width: 1280, height: 720 }, calibration, 1);

    expect(left.x).toBeLessThan(960);
    expect(mirroredLeft.x).toBeGreaterThan(960);
  });

  it('clamps out-of-range landmarks to the primary-display edges', () => {
    const calibration = {
      centerX: 640,
      centerY: 360,
      width: 1280,
      height: 720,
      screen: { width: 1920, height: 1080 },
    };

    expect(mapNormalizedToScreen({ x: -1, y: -1 }, { width: 1280, height: 720 }, calibration, 1))
      .toEqual({ x: 0, y: 0 });
    expect(mapNormalizedToScreen({ x: 2, y: 2 }, { width: 1280, height: 720 }, calibration, 1))
      .toEqual({ x: 1920, y: 1080 });
  });
});

describe('toPhysicalScreenCoordinates', () => {
  it.each([1, 1.25, 1.5, 2])('maps screen center at %sx scaling', (scale) => {
    expect(toPhysicalScreenCoordinates(
      { x: 960, y: 540 },
      { width: 1920, height: 1080 },
      scale,
    )).toEqual({ x: 960 * scale, y: 540 * scale });
  });

  it('converts CSS-pixel coordinates to physical pixels at display scaling', () => {
    expect(toPhysicalScreenCoordinates(
      { x: 800, y: 450 },
      { width: 1536, height: 864 },
      1.25,
    )).toEqual({ x: 1000, y: 563 });
  });

  it('clamps to the last addressable primary-display pixel', () => {
    expect(toPhysicalScreenCoordinates(
      { x: 1536, y: 864 },
      { width: 1536, height: 864 },
      1.5,
    )).toEqual({ x: 2303, y: 1295 });
  });

  it('uses unscaled coordinates for an invalid device-pixel ratio', () => {
    expect(toPhysicalScreenCoordinates(
      { x: 40, y: 20 },
      { width: 100, height: 50 },
      Number.NaN,
    )).toEqual({ x: 40, y: 20 });
  });
});

describe('filterCursorTarget', () => {
  it('reduces small hand jitter more when smoothness is higher', () => {
    const targets = [0, 3, -2, 4, -3, 2].map((x) => ({ x, y: x }));
    const filterTargets = (smoothness: number) => {
      let state = createCursorFilterState();
      let point = targets[0];
      for (const target of targets) {
        const filtered = filterCursorTarget(state, target, smoothness, 1 / 30);
        state = filtered.state;
        point = filtered.point;
      }
      return point;
    };
    const steady = filterTargets(0.85);
    const responsive = filterTargets(0.2);

    expect(Math.abs(steady.x)).toBeLessThan(Math.abs(responsive.x));
  });

  it('responds more quickly to large movement than to small jitter', () => {
    const initial = { x: 0, y: 0 };
    const initialized = filterCursorTarget(createCursorFilterState(), initial, 0.8, 1 / 30);
    const jitter = filterCursorTarget(initialized.state, { x: 8, y: 8 }, 0.8, 1 / 30);
    const movement = filterCursorTarget(initialized.state, { x: 500, y: 500 }, 0.8, 1 / 30);

    expect(movement.point.x / 500).toBeGreaterThan(jitter.point.x / 8);
  });

  it('starts at the first target without jumping from a stale position', () => {
    const target = { x: 100, y: 250 };
    const result = filterCursorTarget(createCursorFilterState(), target, 0.7, 1 / 30);

    expect(result.point).toEqual(target);
  });
});

describe('detectGestureState', () => {
  const makeHand = () => {
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.6 }));
    landmarks[0] = { x: 0.5, y: 0.9 };
    landmarks[9] = { x: 0.5, y: 0.55 };
    landmarks[4] = { x: 0.25, y: 0.6 };
    landmarks[6] = { x: 0.4, y: 0.48 };
    landmarks[8] = { x: 0.4, y: 0.3 };
    landmarks[10] = { x: 0.46, y: 0.48 };
    landmarks[12] = { x: 0.46, y: 0.3 };
    landmarks[14] = { x: 0.54, y: 0.48 };
    landmarks[16] = { x: 0.54, y: 0.3 };
    landmarks[18] = { x: 0.6, y: 0.48 };
    landmarks[20] = { x: 0.6, y: 0.3 };
    return landmarks;
  };

  it('detects a pinch gesture when thumb and index tip are close together', () => {
    const landmarks = makeHand();
    landmarks[4] = { x: 0.405, y: 0.305 };
    landmarks[8] = { x: 0.4, y: 0.3 };

    expect(detectGestureState(landmarks).pinch).toBe(true);
  });

  it('keeps an active pinch through small landmark jitter', () => {
    const landmarks = makeHand();
    landmarks[4] = { x: 0.54, y: 0.3 };
    landmarks[8] = { x: 0.4, y: 0.3 };

    expect(detectGestureState(landmarks, false).pinch).toBe(false);
    expect(detectGestureState(landmarks, true).pinch).toBe(true);
  });

  describe('updatePinchAction', () => {
    it('uses a short pinch for click and a sustained pinch for drag', () => {
      const idle: PinchActionState = { startedAt: null, dragging: false };
      const start = updatePinchAction(idle, true, 1000);
      const click = updatePinchAction(start.state, false, 1250);
      const holdStart = updatePinchAction(idle, true, 2000);
      const dragStart = updatePinchAction(holdStart.state, true, 2000 + PINCH_DRAG_HOLD_MS);
      const dragEnd = updatePinchAction(dragStart.state, false, 2500);

      expect(click.action).toBe('click');
      expect(dragStart.action).toBe('drag-start');
      expect(dragEnd.action).toBe('drag-end');
    });

    it('ignores a pinch shorter than the confirmation interval', () => {
      const start = updatePinchAction({ startedAt: null, dragging: false }, true, 1000);
      const release = updatePinchAction(start.state, false, 1050);

      expect(release.action).toBe('none');
    });
  });

  it('identifies a closed fist and disables cursor action', () => {
    const landmarks = makeHand();
    landmarks[4] = { x: 0.25, y: 0.7 };
    landmarks[8] = { x: 0.4, y: 0.6 };
    landmarks[12] = { x: 0.46, y: 0.6 };
    landmarks[16] = { x: 0.54, y: 0.6 };
    landmarks[20] = { x: 0.6, y: 0.6 };

    expect(detectGestureState(landmarks).name).toBe('Closed fist');
    expect(detectGestureState(landmarks).active).toBe(false);
  });

  it('recognizes an open palm for scrolling', () => {
    const gesture = detectGestureState(makeHand());

    expect(gesture.name).toBe('Open palm');
    expect(gesture.openPalm).toBe(true);
  });
});
