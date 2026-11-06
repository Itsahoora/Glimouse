import { describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings } from './settings';

describe('parseSettings', () => {
  it('uses safe defaults when settings are missing or invalid JSON', () => {
    expect(parseSettings(null)).toEqual(defaultSettings);
    expect(parseSettings('{')).toEqual(defaultSettings);
    expect(parseSettings('[]')).toEqual(defaultSettings);
  });

  it('clamps finite numeric settings and defaults invalid values', () => {
    const settings = parseSettings(JSON.stringify({
      sensitivity: 20,
      smoothing: Number.NaN,
      enableCursor: true,
    }));

    expect(settings.sensitivity).toBe(2);
    expect(settings.smoothing).toBe(defaultSettings.smoothing);
    expect(settings.enableCursor).toBe(true);
    expect(settings.enablePinchActions).toBe(false);
  });

  it('preserves legacy boolean click and drag settings without trusting invalid values', () => {
    expect(parseSettings('{"enableClick":true}').enablePinchActions).toBe(true);
    expect(parseSettings('{"enableDrag":"true"}').enablePinchActions).toBe(false);
  });
});
