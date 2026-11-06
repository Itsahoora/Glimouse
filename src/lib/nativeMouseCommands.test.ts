import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getNativeFailureMessage,
  NativeCommandError,
  NativeMouseCommands,
  type NativeRequest,
} from './nativeMouseCommands';

type RecordedCall = {
  path: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
};

function response(status = 200, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

class MockNativeBridge {
  readonly calls: RecordedCall[] = [];
  readonly request = vi.fn<NativeRequest>((path, body, signal) => this.handle(path, body, signal));
  bootId = 'boot-1';
  generation = 0n;
  activeSession: string | null = null;
  activeGeneration = 0n;
  lastSequence = 0;
  restartCount = 0;

  restart(): void {
    this.bootId = `boot-${++this.restartCount + 1}`;
    this.activeSession = null;
    this.lastSequence = 0;
  }

  private handle(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    this.calls.push({ path, body, signal });
    if (path === '/mouse/session/challenge') {
      return Promise.resolve(response(200, {
        bootId: this.bootId,
        generation: (this.generation + 1n).toString(),
      }));
    }
    if (path === '/mouse/session/recover') {
      return Promise.resolve(response());
    }
    if (path === '/mouse/session') {
      const requestedGeneration = BigInt(String(body.generation));
      if (body.bootId !== this.bootId || requestedGeneration !== this.generation + 1n) {
        return Promise.resolve(response(409));
      }
      this.generation = requestedGeneration;
      this.activeGeneration = requestedGeneration;
      this.activeSession = String(body.sessionId);
      this.lastSequence = 0;
      return Promise.resolve(response());
    }
    if (path === '/mouse/session/validate') {
      return Promise.resolve(
        body.bootId === this.bootId
          && body.sessionId === this.activeSession
          && String(body.generation) === this.activeGeneration.toString()
          ? response()
          : response(409),
      );
    }
    if (path === '/cursor/stop') {
      const requestedGeneration = BigInt(String(body.generation));
      const matchesActive = body.sessionId === this.activeSession
        && requestedGeneration === this.activeGeneration;
      const cancelsChallenge = this.activeSession === null
        && requestedGeneration === this.generation + 1n;
      if (body.bootId !== this.bootId || (!matchesActive && !cancelsChallenge)) {
        return Promise.resolve(response(409));
      }
      this.generation = matchesActive ? this.generation + 1n : requestedGeneration;
      this.activeSession = null;
      this.lastSequence = 0;
      return Promise.resolve(response());
    }
    if (path === '/cursor/move' || path === '/mouse/scroll' || path === '/mouse/left') {
      const sequence = Number(body.sequence);
      if (
        body.bootId !== this.bootId
        || body.sessionId !== this.activeSession
        || sequence <= this.lastSequence
      ) {
        return Promise.resolve(response(409));
      }
      this.lastSequence = sequence;
      return Promise.resolve(response());
    }
    return Promise.resolve(response(404));
  }
}

async function connectedQueue(bridge: MockNativeBridge, timeoutMs = 100) {
  const queue = new NativeMouseCommands(bridge.request, vi.fn(), timeoutMs, 'test-client');
  await queue.connect();
  queue.beginTrackingSession(1);
  return queue;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NativeMouseCommands', () => {
  it('uses a high-priority session-aware release during an active drag', async () => {
    const bridge = new MockNativeBridge();
    const queue = await connectedQueue(bridge);

    await queue.setLeftButton(1, true);
    await queue.releaseLeftButton(1);

    expect(bridge.calls.map(({ path }) => path)).toEqual([
      '/mouse/session/challenge',
      '/mouse/session',
      '/mouse/left',
      '/mouse/left',
    ]);
    expect(bridge.calls[2].body).toMatchObject({
      bootId: bridge.calls[1].body.bootId,
      sessionId: bridge.calls[1].body.sessionId,
      sequence: 1,
      pressed: true,
    });
    expect(bridge.calls[3].body).toMatchObject({
      sessionId: bridge.calls[1].body.sessionId,
      sequence: 2,
      pressed: false,
    });
  });

  it('drops queued mouse actions and invalidates the session when tracking stops', async () => {
    const bridge = new MockNativeBridge();
    const queue = await connectedQueue(bridge);
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation((path, body, signal) =>
      path === '/cursor/move'
        ? (bridge.calls.push({ path, body, signal }), new Promise<Response>(() => {}))
        : request(path, body, signal),
    );

    const first = queue.move(1, 25, 30);
    const queued = queue.scroll(1, 120);
    const stop = queue.invalidateAndRelease();
    await Promise.all([first, queued, stop]);

    expect(bridge.calls.map(({ path }) => path)).toEqual([
      '/mouse/session/challenge',
      '/mouse/session',
      '/cursor/move',
      '/cursor/stop',
    ]);
    expect(bridge.calls[3].body.generation).toBe(bridge.calls[1].body.generation);
    expect(bridge.calls[3].body.bootId).toBe(bridge.calls[1].body.bootId);
  });

  it.each(['/cursor/move', '/mouse/scroll'])('aborts delayed %s when stop invalidates its session', async (path) => {
    const bridge = new MockNativeBridge();
    const queue = await connectedQueue(bridge);
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation((requestPath, body, signal) =>
      requestPath === path
        ? (bridge.calls.push({ path: requestPath, body, signal }), new Promise<Response>(() => {}))
        : request(requestPath, body, signal),
    );

    const delayed = path === '/cursor/move'
      ? queue.move(1, 100, 200)
      : queue.scroll(1, 120);
    await queue.invalidateAndRelease();
    await delayed;

    const command = bridge.calls.find((call) => call.path === path)!;
    const invalidation = bridge.calls.find((call) => call.path === '/cursor/stop')!;
    expect(command.signal.aborted).toBe(true);
    expect(command.body.sessionId).toBe(invalidation.body.sessionId);
    expect(invalidation.body.bootId).toBe(bridge.calls[1].body.bootId);
  });

  it('preserves button press/release sequence ordering in a live session', async () => {
    const bridge = new MockNativeBridge();
    const queue = await connectedQueue(bridge);

    await queue.setLeftButton(1, true);
    await queue.setLeftButton(1, false);
    await queue.setLeftButton(1, true);
    await queue.setLeftButton(1, false);

    expect(bridge.calls.filter(({ path }) => path === '/mouse/left')
      .map(({ body }) => [body.pressed, body.sequence])).toEqual([
      [true, 1],
      [false, 2],
      [true, 3],
      [false, 4],
    ]);
  });

  it('makes repeated stop and rapid stop/start operations safe', async () => {
    const bridge = new MockNativeBridge();
    const queue = await connectedQueue(bridge);

    await queue.invalidateAndRelease();
    await queue.invalidateAndRelease();
    await queue.connect();
    queue.beginTrackingSession(2);
    await queue.move(2, 40, 50);

    expect(bridge.calls.filter(({ path }) => path === '/cursor/stop')).toHaveLength(2);
    const activations = bridge.calls.filter(({ path }) => path === '/mouse/session');
    expect(activations).toHaveLength(2);
    expect(BigInt(String(activations[1].body.generation)))
      .toBeGreaterThan(BigInt(String(activations[0].body.generation)));
    expect(bridge.calls.at(-1)?.body).toMatchObject({
      sessionId: activations[1].body.sessionId,
      sequence: 1,
      x: 40,
      y: 50,
    });
  });

  it('validates a cached token and renews it after the companion restarts', async () => {
    const bridge = new MockNativeBridge();
    const queue = await connectedQueue(bridge);
    const oldSession = bridge.activeSession;
    bridge.restart();

    await queue.connect();
    await queue.move(1, 5, 6);

    const activations = bridge.calls.filter(({ path }) => path === '/mouse/session');
    expect(bridge.calls.some(({ path }) => path === '/mouse/session/validate')).toBe(true);
    expect(activations).toHaveLength(2);
    expect(activations[1].body.sessionId).not.toBe(oldSession);
    expect(activations[1].body.bootId).toBe(bridge.bootId);
    expect(bridge.calls.at(-1)?.body).toMatchObject({
      sessionId: activations[1].body.sessionId,
      sequence: 1,
      x: 5,
      y: 6,
    });
  });

  it('renews once on an active-session 409 and never replays the rejected command', async () => {
    const bridge = new MockNativeBridge();
    const connectionStates: boolean[] = [];
    const queue = await connectedQueue(bridge);
    queue.setConnectionStateHandler((ready) => connectionStates.push(ready));
    const request = bridge.request.getMockImplementation()!;
    let rejected = false;
    bridge.request.mockImplementation((path, body, signal) => {
      if (path === '/cursor/move' && !rejected) {
        rejected = true;
        bridge.calls.push({ path, body, signal });
        return Promise.resolve(response(409));
      }
      return request(path, body, signal);
    });

    await queue.move(1, 1, 2);
    const rejectedMove = bridge.calls.find(({ path }) => path === '/cursor/move')!;
    const activations = bridge.calls.filter(({ path }) => path === '/mouse/session');
    expect(connectionStates).toEqual([true, false, true]);
    expect(activations).toHaveLength(2);
    expect(bridge.calls.filter(({ path }) => path === '/cursor/move')).toHaveLength(1);
    expect(BigInt(String(activations[1].body.generation)))
      .toBeGreaterThan(BigInt(String(activations[0].body.generation)));

    await queue.move(1, 3, 4);
    expect(bridge.calls.at(-1)?.body).toMatchObject({
      sessionId: activations[1].body.sessionId,
      sequence: 1,
      x: 3,
      y: 4,
    });
    expect(rejectedMove.body.sessionId).not.toBe(activations[1].body.sessionId);
  });

  it('does not report readiness when the companion cannot establish a session', async () => {
    const states: boolean[] = [];
    const request = vi.fn<NativeRequest>(() => Promise.reject(new Error('connection refused')));
    const queue = new NativeMouseCommands(request, vi.fn(), 25, 'test-client');
    queue.setConnectionStateHandler((ready) => states.push(ready));

    await expect(queue.connect()).rejects.toThrow('connection refused');
    expect(states).toEqual([false]);
  });

  it('recovers once from storage failure before creating a session', async () => {
    const bridge = new MockNativeBridge();
    const request = bridge.request.getMockImplementation()!;
    let failed = false;
    bridge.request.mockImplementation((path, body, signal) => {
      if (path === '/mouse/session/challenge' && !failed) {
        failed = true;
        bridge.calls.push({ path, body, signal });
        return Promise.resolve(response(503));
      }
      return request(path, body, signal);
    });
    const queue = new NativeMouseCommands(bridge.request, vi.fn(), 100, 'test-client');

    await queue.connect();
    expect(bridge.calls.map(({ path }) => path)).toEqual([
      '/mouse/session/challenge',
      '/mouse/session/recover',
      '/mouse/session/challenge',
      '/mouse/session',
    ]);
  });

  it('times out a stalled request, renews the session, drops old work, and accepts fresh input', async () => {
    vi.useFakeTimers();
    const bridge = new MockNativeBridge();
    const errors: unknown[] = [];
    const queue = new NativeMouseCommands(bridge.request, (_path, error) => errors.push(error), 20, 'test-client');
    await queue.connect();
    queue.beginTrackingSession(1);
    const oldSessionId = bridge.activeSession;
    const request = bridge.request.getMockImplementation()!;
    let stalledSignal: AbortSignal | undefined;
    let removedAbortListeners = 0;
    bridge.request.mockImplementation((path, body, signal) => {
      if (path === '/cursor/move') {
        bridge.calls.push({ path, body, signal });
        stalledSignal = signal;
        const remove = signal.removeEventListener.bind(signal);
        vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, options) => {
          if (type === 'abort') {
            removedAbortListeners += 1;
          }
          return remove(type, listener, options);
        });
        return new Promise<Response>(() => {});
      }
      return request(path, body, signal);
    });

    const stalledMove = queue.move(1, 15, 25);
    const staleScroll = queue.scroll(1, 120);
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([stalledMove, staleScroll]);

    const activationsAfterTimeout = bridge.calls.filter(({ path }) => path === '/mouse/session');
    expect(stalledSignal?.aborted).toBe(true);
    expect(bridge.activeSession).not.toBe(oldSessionId);
    expect(activationsAfterTimeout).toHaveLength(2);
    expect(bridge.calls.filter(({ path }) => path === '/mouse/scroll')).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(removedAbortListeners).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    bridge.request.mockImplementation(request);
    await queue.move(1, 30, 40);
    expect(bridge.calls.at(-1)?.body).toMatchObject({
      sessionId: bridge.activeSession,
      x: 30,
      y: 40,
    });
  });

  it('does not turn explicit session cancellation into timeout recovery', async () => {
    vi.useFakeTimers();
    const bridge = new MockNativeBridge();
    const errors: unknown[] = [];
    const queue = new NativeMouseCommands(bridge.request, (_path, error) => errors.push(error), 100, 'test-client');
    await queue.connect();
    queue.beginTrackingSession(1);
    const request = bridge.request.getMockImplementation()!;
    let activeSignal: AbortSignal | undefined;
    bridge.request.mockImplementation((path, body, signal) => {
      if (path === '/cursor/move') {
        bridge.calls.push({ path, body, signal });
        activeSignal = signal;
        return new Promise<Response>(() => {});
      }
      return request(path, body, signal);
    });

    const movement = queue.move(1, 15, 25);
    await queue.invalidateAndRelease();
    await movement;

    expect(activeSignal?.aborted).toBe(true);
    expect(errors).toEqual([]);
    expect(bridge.calls.filter(({ path }) => path === '/mouse/session')).toHaveLength(1);
    expect(bridge.calls.filter(({ path }) => path === '/mouse/session/challenge')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('parses structured stop-operation failures and sanitizes their message', async () => {
    const bridge = new MockNativeBridge();
    const queue = await connectedQueue(bridge);
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation((path, body, signal) =>
      path === '/cursor/stop'
        ? Promise.resolve(response(500, {
          code: 'native_operation_failed',
          error: 'Native release failed.\n at Hidden.StackTrace()',
        }))
        : request(path, body, signal),
    );

    await expect(queue.invalidateAndRelease()).rejects.toMatchObject({
      name: 'NativeCommandError',
      status: 500,
      code: 'native_operation_failed',
      message: 'Native release failed.',
    });
  });

  it.each([
    ['missing body', undefined],
    ['invalid code', { code: 'unexpected', error: 'server detail' }],
    ['invalid error value', { code: 'native_operation_failed', error: { stack: 'secret' } }],
  ])('falls back to the HTTP status for a stop response with %s', async (_label, body) => {
    const bridge = new MockNativeBridge();
    const queue = await connectedQueue(bridge);
    const request = bridge.request.getMockImplementation()!;
    const failedResponse = body === undefined
      ? new Response('invalid JSON', {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
      : response(503, body);
    bridge.request.mockImplementation((path, requestBody, signal) =>
      path === '/cursor/stop'
        ? Promise.resolve(failedResponse)
        : request(path, requestBody, signal),
    );

    await expect(queue.invalidateAndRelease()).rejects.toMatchObject({
      name: 'NativeCommandError',
      status: 503,
      code: 'http_error',
      message: 'The local companion returned HTTP 503.',
    });
  });

  it('provides safe application-facing messages for known native failures', () => {
    const error = new NativeCommandError(
      '/cursor/stop',
      500,
      'native_operation_failed',
      'Native mouse release failed.',
    );

    expect(getNativeFailureMessage('/cursor/stop', error)).toBe('Native mouse release failed.');
    expect(getNativeFailureMessage('/cursor/stop', new Error('untrusted error'))).toBe(
      'The local companion failed to complete /cursor/stop.',
    );
  });
});
