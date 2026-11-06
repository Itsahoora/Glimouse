import type { Point2D } from './mouseMath';
import type { WorkerPort, WorkerResponse } from './handTrackingProtocol';

type SessionWaiter = {
  requestId: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

export type HandTrackingHandlers = {
  onResult: (session: number, landmarks: Point2D[] | null) => void;
  onError: (session: number, message: string) => void;
};

export type HandTrackingTimeouts = {
  initializationMs?: number;
  inferenceMs?: number;
};

export const DEFAULT_HAND_TRACKING_TIMEOUTS: Required<HandTrackingTimeouts> = {
  initializationMs: 30_000,
  inferenceMs: 10_000,
};

export class HandTrackingClient {
  private readonly worker: WorkerPort;
  private readonly handlers: HandTrackingHandlers;
  private readonly ownerSession: number;
  private readonly initializationTimeoutMs: number;
  private readonly inferenceTimeoutMs: number;
  private activeSession: number | null = null;
  private waiter: SessionWaiter | null = null;
  private ready = false;
  private terminated = false;
  private nextRequestId = 0;
  private initTimeout: ReturnType<typeof setTimeout> | null = null;
  private inferenceTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingFrameRequestId: number | null = null;
  private readonly handleMessage: EventListener;
  private readonly handleError: EventListener;
  private readonly handleMessageError: EventListener;

  constructor(
    worker: WorkerPort,
    ownerSession: number,
    handlers: HandTrackingHandlers,
    timeouts: HandTrackingTimeouts = {},
  ) {
    this.worker = worker;
    this.ownerSession = ownerSession;
    this.handlers = handlers;
    this.initializationTimeoutMs = timeouts.initializationMs ?? DEFAULT_HAND_TRACKING_TIMEOUTS.initializationMs;
    this.inferenceTimeoutMs = timeouts.inferenceMs ?? DEFAULT_HAND_TRACKING_TIMEOUTS.inferenceMs;
    this.handleMessage = (event) => {
      this.onMessage((event as MessageEvent<WorkerResponse>).data);
    };
    this.handleError = (event) => {
      const error = event as ErrorEvent;
      this.failWorker(error.message || 'The hand tracking worker failed to start.');
    };
    this.handleMessageError = () => {
      this.failWorker('The hand tracking worker returned an unreadable message.');
    };

    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', this.handleError);
    worker.addEventListener('messageerror', this.handleMessageError);
  }

  initialize(session: number): Promise<void> {
    if (this.terminated) {
      return Promise.reject(new Error('The hand tracking worker has been terminated.'));
    }
    if (session !== this.ownerSession || this.activeSession !== null) {
      return Promise.reject(new Error('The hand tracking worker belongs to a different tracking session.'));
    }

    this.activeSession = session;
    const requestId = ++this.nextRequestId;
    return new Promise<void>((resolve, reject) => {
      this.waiter = { requestId, resolve, reject };
      this.initTimeout = setTimeout(() => {
        this.failWorker('Hand tracking initialization timed out.', 'TimeoutError');
      }, this.initializationTimeoutMs);
      try {
        this.worker.postMessage({ type: 'init', session, requestId });
      } catch (error) {
        this.failWorker(error instanceof Error ? error.message : String(error));
      }
    });
  }

  cancelSession(session: number): void {
    if (this.ownerSession !== session || this.activeSession !== session) {
      return;
    }
    this.activeSession = null;
    this.ready = false;
    this.clearTimers();
    this.pendingFrameRequestId = null;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      const error = new Error('Tracking session was cancelled.');
      error.name = 'AbortError';
      waiter.reject(error);
    }
  }

  postFrame(session: number, bitmap: ImageBitmap): boolean {
    if (
      this.terminated
      || this.activeSession !== session
      || !this.ready
      || this.pendingFrameRequestId !== null
    ) {
      bitmap.close();
      return false;
    }

    const requestId = ++this.nextRequestId;
    this.pendingFrameRequestId = requestId;
    this.inferenceTimeout = setTimeout(() => {
      this.failWorker('Hand tracking inference timed out.', 'TimeoutError');
    }, this.inferenceTimeoutMs);

    try {
      this.worker.postMessage({ type: 'frame', bitmap, session, requestId }, [bitmap]);
      return true;
    } catch (error) {
      bitmap.close();
      this.failWorker(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.activeSession = null;
    this.ready = false;
    this.clearTimers();
    this.pendingFrameRequestId = null;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      const error = new Error('Tracking worker was terminated.');
      error.name = 'AbortError';
      waiter.reject(error);
    }
    this.removeListeners();
    this.worker.terminate();
  }

  private onMessage(message: WorkerResponse): void {
    if (this.terminated || message.session !== this.activeSession || message.session !== this.ownerSession) {
      return;
    }

    if (message.type === 'ready') {
      const waiter = this.waiter;
      if (!waiter || message.requestId !== waiter.requestId) {
        return;
      }
      this.clearInitializationTimeout();
      this.waiter = null;
      this.ready = true;
      waiter.resolve();
      return;
    }

    if (message.type === 'error') {
      if (message.phase === 'init' && this.waiter?.requestId === message.requestId) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter.reject(new Error(message.message));
      }
      this.failWorker(message.message);
      return;
    }

    if (message.requestId !== this.pendingFrameRequestId) {
      return;
    }
    this.clearInferenceTimeout();
    this.pendingFrameRequestId = null;
    if (this.ready) {
      this.handlers.onResult(message.session, message.landmarks);
    }
  }

  private failWorker(message: string, name = 'Error'): void {
    if (this.terminated) {
      return;
    }
    const session = this.ownerSession;
    this.terminated = true;
    this.activeSession = null;
    this.ready = false;
    this.clearTimers();
    this.pendingFrameRequestId = null;
    const waiter = this.waiter;
    this.waiter = null;
    const error = new Error(message);
    error.name = name;
    waiter?.reject(error);
    this.removeListeners();
    this.worker.terminate();
    this.handlers.onError(session, message);
  }

  private clearTimers(): void {
    this.clearInitializationTimeout();
    this.clearInferenceTimeout();
  }

  private clearInitializationTimeout(): void {
    if (this.initTimeout !== null) {
      clearTimeout(this.initTimeout);
      this.initTimeout = null;
    }
  }

  private clearInferenceTimeout(): void {
    if (this.inferenceTimeout !== null) {
      clearTimeout(this.inferenceTimeout);
      this.inferenceTimeout = null;
    }
  }

  private removeListeners(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
  }
}
