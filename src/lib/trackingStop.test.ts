import { describe, expect, it, vi } from 'vitest';
import { NativeCommandError } from './nativeMouseCommands';
import { finishTrackingStop } from './trackingStop';

describe('finishTrackingStop', () => {
  it('cleans up immediately but reports release success only after native stop completes', async () => {
    const cleanup = vi.fn();
    const report = vi.fn();
    let resolveStop!: () => void;
    const requestNativeStop = vi.fn(() => new Promise<void>((resolve) => {
      resolveStop = resolve;
    }));

    const stopping = finishTrackingStop(cleanup, requestNativeStop, report);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(requestNativeStop).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();

    resolveStop();
    await expect(stopping).resolves.toBe(true);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      released: true,
      message: 'Tracking stopped and mouse controls were released.',
      tone: 'success',
    });
  });

  it('reports an unconfirmed release while retaining camera and worker cleanup', async () => {
    const cleanup = vi.fn(() => {
      stopCamera();
      terminateWorker();
      clearTrackingTimer();
    });
    const stopCamera = vi.fn();
    const terminateWorker = vi.fn();
    const clearTrackingTimer = vi.fn();
    const releaseError = new NativeCommandError(
      '/cursor/stop',
      500,
      'native_operation_failed',
      'Native mouse release failed.',
    );
    const report = vi.fn();

    await expect(finishTrackingStop(
      cleanup,
      () => Promise.reject(releaseError),
      report,
    )).resolves.toBe(false);

    expect(stopCamera).toHaveBeenCalledOnce();
    expect(terminateWorker).toHaveBeenCalledOnce();
    expect(clearTrackingTimer).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith({
      released: false,
      message: 'Tracking stopped, but a native release operation failed; mouse-button release is unconfirmed.',
      tone: 'error',
    }, releaseError);
  });

  it('distinguishes a rejected stop from a native release failure', async () => {
    const report = vi.fn();

    await expect(finishTrackingStop(
      vi.fn(),
      () => Promise.reject(new NativeCommandError(
        '/cursor/stop',
        409,
        'command_rejected',
        'The stop request was rejected.',
      )),
      report,
    )).resolves.toBe(false);

    expect(report).toHaveBeenCalledExactlyOnceWith({
      released: false,
      message: 'Tracking stopped, but the bridge did not confirm mouse-button release.',
      tone: 'error',
    }, expect.any(NativeCommandError));
  });
});
