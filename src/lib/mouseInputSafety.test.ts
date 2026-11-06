import { describe, expect, it } from 'vitest';
import { defaultSettings } from './settings';
import {
  applyMouseInputSettingsChange,
  canProcessMouseInput,
  resetMouseInputSafetyState,
  updatePinchSuppression,
  type MouseInputSafetyState,
} from './mouseInputSafety';

const activeDrag: MouseInputSafetyState = {
  leftButtonHeld: true,
  pinchStartedAt: 100,
  dragging: true,
  wasPinching: true,
  scrollAnchor: 0.4,
  pendingScrollDelta: 60,
  scrollRequestPending: true,
  cursorRequestPending: true,
  latestCursorTarget: { x: 400, y: 300 },
  suppressPinchUntilRelease: false,
};

describe('mouse input safety settings', () => {
  it('immediately resets an active drag and pending input when movement is disabled', () => {
    const next = { ...defaultSettings, enableCursor: true, enablePinchActions: true };
    let releases = 0;
    const releaseButton = () => { releases += 1; };
    const change = applyMouseInputSettingsChange(
      next,
      { ...next, enableCursor: false },
      activeDrag,
      releaseButton,
    );

    expect(change.reset).toMatchObject({ movementDisabled: true, releaseButton: true });
    expect(releases).toBe(1);
    expect(change.state).toMatchObject({
      leftButtonHeld: false,
      pinchStartedAt: null,
      dragging: false,
      wasPinching: false,
      scrollAnchor: null,
      pendingScrollDelta: 0,
      scrollRequestPending: false,
      cursorRequestPending: false,
      latestCursorTarget: null,
      suppressPinchUntilRelease: true,
    });
  });

  it('releases a drag when pinch actions are disabled without changing other preferences', () => {
    const previous = {
      ...defaultSettings,
      enableCursor: true,
      enablePinchActions: true,
      enableScroll: true,
      mirrorPreview: true,
    };
    const next = { ...previous, enablePinchActions: false };
    let releases = 0;
    const change = applyMouseInputSettingsChange(previous, next, activeDrag, () => { releases += 1; });

    expect(change.reset).toMatchObject({
      movementDisabled: false,
      pinchActionsDisabled: true,
      releaseButton: true,
    });
    expect(releases).toBe(1);
    expect(next).toMatchObject({
      enableCursor: true,
      enableScroll: true,
      mirrorPreview: true,
      enablePinchActions: false,
    });
    expect(change.state.leftButtonHeld).toBe(false);
    expect(change.state.dragging).toBe(false);
    expect(change.state.scrollAnchor).toBe(activeDrag.scrollAnchor);
  });

  it('keeps tracking eligible while movement mode blocks all mouse input', () => {
    const movementDisabled = { ...defaultSettings, enableCursor: false, enablePinchActions: true };

    expect(canProcessMouseInput(movementDisabled)).toBe(false);
    expect(movementDisabled.enablePinchActions).toBe(true);
    expect(movementDisabled.enableScroll).toBe(defaultSettings.enableScroll);
  });

  it('does not restore stale pinch state when movement is re-enabled', () => {
    const next = { ...defaultSettings, enableCursor: true, enablePinchActions: true };
    const disabled = resetMouseInputSafetyState(activeDrag, true);
    const reenabled = applyMouseInputSettingsChange(
      { ...next, enableCursor: false },
      next,
      disabled,
      () => { throw new Error('Re-enabling must not release the button again.'); },
    );

    expect(reenabled.reset.releaseButton).toBe(false);
    expect(reenabled.state).toBe(disabled);
    expect(updatePinchSuppression(disabled, true).suppressPinchUntilRelease).toBe(true);
    expect(updatePinchSuppression(disabled, false).suppressPinchUntilRelease).toBe(false);
    expect(disabled.dragging).toBe(false);
    expect(disabled.pinchStartedAt).toBeNull();
  });

  it('keeps repeated movement-disable updates safe and releases only on the transition', () => {
    let releases = 0;
    const enabled = { ...defaultSettings, enableCursor: true };
    const disabledSettings = { ...enabled, enableCursor: false };
    const first = applyMouseInputSettingsChange(
      enabled,
      disabledSettings,
      activeDrag,
      () => { releases += 1; },
    );
    const repeated = applyMouseInputSettingsChange(
      disabledSettings,
      disabledSettings,
      first.state,
      () => { releases += 1; },
    );

    expect(repeated.state).toEqual(first.state);
    expect(repeated.state.leftButtonHeld).toBe(false);
    expect(repeated.state.dragging).toBe(false);
    expect(releases).toBe(1);
  });
});
