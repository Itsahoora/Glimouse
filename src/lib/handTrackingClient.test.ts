import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandTrackingClient } from './handTrackingClient';
import type { WorkerPort, WorkerRequest, WorkerResponse } from './handTrackingProtocol';

class FakeWorker implements WorkerPort {
  readonly posted: WorkerRequest[] = [];
  private readonly listeners = new Map<string, EventListener[]>();
  private readonly originalListeners = new Map<string, EventListener[]>();
  terminated = false;

  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    this.originalListeners.set(type, [...(this.originalListeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: WorkerResponse): void {
    const event = new MessageEvent('message', { data: message });
    this.listeners.get('message')?.forEach((listener) => listener(event));
  }

  emitError(message: string): void {
    const event = createErrorEvent(message);
    this.listeners.get('error')?.forEach((listener) => listener(event));
  }

  emitQueuedError(message: string): void {
    const event = createErrorEvent(message);
    this.originalListeners.get('error')?.forEach((listener) => listener(event));
  }
}

function createErrorEvent(message: string): ErrorEvent {
  const event = new Event('error');
  Object.defineProperty(event, 'message', { value: message });
  return event as ErrorEvent;
}

function setup(session = 1, timeouts = { initializationMs: 100, inferenceMs: 50 }) {
  const worker = new FakeWorker();
  const onResult = vi.fn();
  const onError = vi.fn();
  const client = new HandTrackingClient(worker, session, { onResult, onError }, timeouts);
  return { worker, client, onResult, onError };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HandTrackingClient', () => {
  it('cancels pending initialization and ignores late replies', async () => {
    const { worker, client } = setup();
    const initialization = client.initialize(1);
    client.cancelSession(1);

    await expect(initialization).rejects.toMatchObject({ name: 'AbortError' });
    worker.emit({ type: 'ready', session: 1, requestId: 1 });
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    expect(client.postFrame(1, bitmap)).toBe(false);
    expect(bitmap.close).toHaveBeenCalledOnce();
    client.terminate();
  });

  it('times out initialization, terminates the worker, and settles its waiter', async () => {
    vi.useFakeTimers();
    const { worker, client, onError } = setup(1, { initializationMs: 25, inferenceMs: 50 });
    const initialization = client.initialize(1);
    const result = expect(initialization).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(25);
    await result;

    expect(worker.terminated).toBe(true);
    expect(onError).toHaveBeenCalledWith(1, 'Hand tracking initialization timed out.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails and terminates on an initialization error response', async () => {
    const { worker, client, onError } = setup();
    const initialization = client.initialize(1);
    const result = expect(initialization).rejects.toThrow('model failed');
    worker.emit({ type: 'error', session: 1, requestId: 1, phase: 'init', message: 'model failed' });

    await result;
    expect(worker.terminated).toBe(true);
    expect(onError).toHaveBeenCalledWith(1, 'model failed');
  });

  it('terminates an unresponsive worker when inference exceeds its watchdog', async () => {
    vi.useFakeTimers();
    const { worker, client, onError } = setup(1, { initializationMs: 100, inferenceMs: 20 });
    const initialization = client.initialize(1);
    worker.emit({ type: 'ready', session: 1, requestId: 1 });
    await initialization;
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    expect(client.postFrame(1, bitmap)).toBe(true);

    await vi.advanceTimersByTimeAsync(20);

    expect(worker.terminated).toBe(true);
    expect(onError).toHaveBeenCalledWith(1, 'Hand tracking inference timed out.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('associates untagged browser errors with their original worker, not a newer session', async () => {
    const old = setup(1);
    const oldInitialization = old.client.initialize(1);
    old.client.terminate();
    await expect(oldInitialization).rejects.toMatchObject({ name: 'AbortError' });

    const current = setup(2);
    const currentInitialization = current.client.initialize(2);
    old.worker.emitQueuedError('late old-worker failure');
    current.worker.emit({ type: 'ready', session: 2, requestId: 1 });
    await currentInitialization;

    expect(current.onError).not.toHaveBeenCalled();
    expect(old.onError).not.toHaveBeenCalled();
    expect(current.worker.terminated).toBe(false);
  });

  it('ignores stale session and request IDs', async () => {
    const { worker, client, onResult } = setup();
    const initialization = client.initialize(1);
    worker.emit({ type: 'ready', session: 1, requestId: 1 });
    await initialization;
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    client.postFrame(1, bitmap);

    worker.emit({ type: 'result', session: 1, requestId: 999, landmarks: null });
    expect(onResult).not.toHaveBeenCalled();
    worker.emit({ type: 'result', session: 1, requestId: 2, landmarks: null });
    expect(onResult).toHaveBeenCalledWith(1, null);
    client.terminate();
  });

  it('settles pending initialization on stop and supports repeated fresh starts', async () => {
    vi.useFakeTimers();
    for (const session of [1, 2, 3]) {
      const { worker, client } = setup(session);
      const initialization = client.initialize(session);
      client.cancelSession(session);
      client.terminate();
      await expect(initialization).rejects.toMatchObject({ name: 'AbortError' });
      expect(worker.terminated).toBe(true);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
