import { NativeCommandError } from './nativeMouseCommands';

export type TrackingStopStatus = {
  released: boolean;
  message: string;
  tone: 'success' | 'error';
};

export function getTrackingStopStatus(released: boolean, error?: unknown): TrackingStopStatus {
  if (released) {
    return {
      released: true,
      message: 'Tracking stopped and mouse controls were released.',
      tone: 'success',
    };
  }

  return {
    released: false,
    message: error instanceof NativeCommandError && error.code === 'native_operation_failed'
      ? 'Tracking stopped, but a native release operation failed; mouse-button release is unconfirmed.'
      : 'Tracking stopped, but the bridge did not confirm mouse-button release.',
    tone: 'error',
  };
}

export async function finishTrackingStop(
  cleanup: () => void,
  requestNativeStop: () => Promise<void>,
  report: (status: TrackingStopStatus, error?: unknown) => void,
): Promise<boolean> {
  cleanup();

  try {
    await requestNativeStop();
    report(getTrackingStopStatus(true));
    return true;
  } catch (error) {
    report(getTrackingStopStatus(false, error), error);
    return false;
  }
}
