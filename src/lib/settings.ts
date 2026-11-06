import { clamp } from './mouseMath';

export type Settings = {
  sensitivity: number;
  smoothing: number;
  enableCursor: boolean;
  enablePinchActions: boolean;
  enableScroll: boolean;
  mirrorPreview: boolean;
};

export const defaultSettings: Settings = {
  sensitivity: 1.05,
  smoothing: 0.58,
  enableCursor: false,
  enablePinchActions: false,
  enableScroll: false,
  mirrorPreview: false,
};

export function parseSettings(raw: string | null): Settings {
  if (!raw) {
    return defaultSettings;
  }

  try {
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
    const legacyPinchActions = [saved.enableClick, saved.enableDrag]
      .some((value) => value === true);

    return {
      sensitivity: numericSetting('sensitivity', 0.4, 2),
      smoothing: numericSetting('smoothing', 0.1, 0.9),
      enableCursor: booleanSetting('enableCursor'),
      enablePinchActions: typeof saved.enablePinchActions === 'boolean'
        ? saved.enablePinchActions
        : legacyPinchActions,
      enableScroll: booleanSetting('enableScroll'),
      mirrorPreview: booleanSetting('mirrorPreview'),
    };
  } catch {
    return defaultSettings;
  }
}
