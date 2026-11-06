import type { Settings } from './settings';

export type MouseInputSafetyState = {
  leftButtonHeld: boolean;
  pinchStartedAt: number | null;
  dragging: boolean;
  wasPinching: boolean;
  scrollAnchor: number | null;
  pendingScrollDelta: number;
  scrollRequestPending: boolean;
  cursorRequestPending: boolean;
  latestCursorTarget: { x: number; y: number } | null;
  suppressPinchUntilRelease: boolean;
};

export function getMouseInputSafetyReset(previous: Settings, next: Settings) {
  const movementDisabled = previous.enableCursor && !next.enableCursor;
  const pinchActionsDisabled = previous.enablePinchActions && !next.enablePinchActions;
  return {
    movementDisabled,
    pinchActionsDisabled,
    releaseButton: movementDisabled || pinchActionsDisabled,
  };
}

export function applyMouseInputSettingsChange(
  previous: Settings,
  next: Settings,
  state: MouseInputSafetyState,
  releaseButton: () => void,
) {
  const reset = getMouseInputSafetyReset(previous, next);
  if (!reset.releaseButton) {
    return { reset, state };
  }

  releaseButton();
  return {
    reset,
    state: resetMouseInputSafetyState(state, reset.movementDisabled),
  };
}

export function canProcessMouseInput(settings: Settings): boolean {
  return settings.enableCursor;
}

export function resetMouseInputSafetyState(
  state: MouseInputSafetyState,
  resetMovement: boolean,
): MouseInputSafetyState {
  return {
    ...state,
    leftButtonHeld: false,
    pinchStartedAt: null,
    dragging: false,
    wasPinching: false,
    scrollAnchor: resetMovement ? null : state.scrollAnchor,
    pendingScrollDelta: resetMovement ? 0 : state.pendingScrollDelta,
    scrollRequestPending: resetMovement ? false : state.scrollRequestPending,
    cursorRequestPending: resetMovement ? false : state.cursorRequestPending,
    latestCursorTarget: resetMovement ? null : state.latestCursorTarget,
    suppressPinchUntilRelease: true,
  };
}

export function updatePinchSuppression(
  state: MouseInputSafetyState,
  pinching: boolean,
): MouseInputSafetyState {
  if (pinching || !state.suppressPinchUntilRelease) {
    return state;
  }
  return { ...state, suppressPinchUntilRelease: false };
}
