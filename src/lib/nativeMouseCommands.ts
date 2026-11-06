export type NativeRequest = (
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Response>;

type QueuedCommand = {
  path: string;
  body: Record<string, unknown>;
  session: number;
  priorityRelease: boolean;
  resolve: () => void;
};

export type NativeCommandErrorCode =
  | 'native_operation_failed'
  | 'storage_unavailable'
  | 'command_rejected'
  | 'http_error';

export class NativeCommandError extends Error {
  readonly path: string;
  readonly status: number;
  readonly code: NativeCommandErrorCode;

  constructor(path: string, status: number, code: NativeCommandErrorCode, message: string) {
    super(message);
    this.name = 'NativeCommandError';
    this.path = path;
    this.status = status;
    this.code = code;
  }
}

const nativeErrorCodes = new Set<NativeCommandErrorCode>([
  'native_operation_failed',
  'storage_unavailable',
  'command_rejected',
]);

export function getNativeFailureMessage(path: string, error: unknown): string {
  if (error instanceof NativeCommandError) {
    return error.message;
  }
  return `The local companion failed to complete ${path}.`;
}

const DEFAULT_TIMEOUT_MS = 2500;

export class NativeMouseCommands {
  private readonly request: NativeRequest;
  private readonly timeoutMs: number;
  private readonly clientId: string;
  private nativeBootId: string | null = null;
  private nativeGeneration: string | null = null;
  private nativeSessionId: string | null = null;
  private activationBootId: string | null = null;
  private activationGeneration: string | null = null;
  private activationSessionId: string | null = null;
  private trackingSession: number | null = null;
  private nextSequence = 0;
  private readonly pending: QueuedCommand[] = [];
  private running = false;
  private activeController: AbortController | null = null;
  private lifecycleController: AbortController | null = null;
  private connecting: Promise<void> | null = null;
  private connectionAttempt = 0;
  private recovering = false;
  private connectionReady = false;
  private onFailure: (path: string, error: unknown) => void;
  private onConnectionState: (ready: boolean) => void = () => {};

  constructor(
    request: NativeRequest,
    onFailure: (path: string, error: unknown) => void = (path, error) => {
      console.error(`Native command failed: ${path}`, error);
    },
    timeoutMs = DEFAULT_TIMEOUT_MS,
    clientId = createIdentity(),
  ) {
    this.request = request;
    this.onFailure = onFailure;
    this.timeoutMs = timeoutMs;
    this.clientId = clientId;
  }

  setFailureHandler(handler: (path: string, error: unknown) => void): void {
    this.onFailure = handler;
  }

  setConnectionStateHandler(handler: (ready: boolean) => void): void {
    this.onConnectionState = handler;
    handler(this.connectionReady);
  }

  async connect(): Promise<void> {
    if (this.connecting) {
      return this.connecting;
    }

    const attempt = ++this.connectionAttempt;
    const connecting = this.connectSession(attempt)
      .catch((error: unknown) => {
        if (attempt === this.connectionAttempt) {
          this.setConnectionReady(false);
        }
        throw error;
      })
      .finally(() => {
        if (this.connecting === connecting) {
          this.connecting = null;
        }
      });
    this.connecting = connecting;
    return connecting;
  }

  beginTrackingSession(session: number): void {
    if (
      !this.nativeSessionId
      || !this.nativeBootId
      || !this.nativeGeneration
      || !this.connectionReady
      || this.recovering
    ) {
      throw new Error('A valid native mouse session is required before tracking can start.');
    }
    if (this.trackingSession !== null && this.trackingSession !== session) {
      throw new Error('The previous tracking session must be stopped before starting another.');
    }
    this.trackingSession = session;
  }

  move(session: number, x: number, y: number): Promise<void> {
    return this.enqueue('/cursor/move', session, { x, y });
  }

  scroll(session: number, delta: number): Promise<void> {
    return this.enqueue('/mouse/scroll', session, { delta });
  }

  setLeftButton(session: number, pressed: boolean): Promise<void> {
    return this.enqueue('/mouse/left', session, { pressed });
  }

  releaseLeftButton(session: number): Promise<void> {
    if (!this.canQueue(session)) {
      return Promise.resolve();
    }

    this.clearPending();
    this.activeController?.abort();
    return new Promise((resolve) => {
      this.pending.unshift({
        path: '/mouse/left',
        body: this.commandBody({ pressed: false }),
        session,
        priorityRelease: true,
        resolve,
      });
      this.drain();
    });
  }

  async invalidateAndRelease(): Promise<void> {
    const sessionId = this.nativeSessionId ?? this.activationSessionId ?? createIdentity();
    const bootId = this.nativeBootId ?? this.activationBootId;
    const generation = this.nativeGeneration ?? this.activationGeneration;
    const sequence = ++this.nextSequence;

    this.trackingSession = null;
    this.nativeBootId = null;
    this.nativeGeneration = null;
    this.nativeSessionId = null;
    this.activationBootId = null;
    this.activationGeneration = null;
    this.activationSessionId = null;
    this.setConnectionReady(false);
    this.recovering = false;
    this.clearPending();
    this.activeController?.abort();
    this.activeController = null;
    this.lifecycleController?.abort();
    this.lifecycleController = null;
    this.connectionAttempt += 1;
    this.connecting = null;

    const controller = new AbortController();
    let stopBootId = bootId;
    let stopGeneration = generation;
    if (!stopBootId || !stopGeneration) {
      const challengeResponse = await this.requestWithTimeout(
        '/mouse/session/challenge',
        { clientId: this.clientId },
        controller,
      );
      const challenge = await readChallenge(challengeResponse);
      stopBootId = challenge.bootId;
      stopGeneration = challenge.generation;
    }
    await this.requestWithTimeout('/cursor/stop', {
        clientId: this.clientId,
        bootId: stopBootId,
        generation: stopGeneration,
        sessionId,
        sequence,
    }, controller);
  }

  private async connectSession(attempt: number): Promise<void> {
    this.recovering = true;
    try {
      if (this.nativeSessionId) {
        const controller = new AbortController();
        this.lifecycleController = controller;
        try {
          await this.requestWithTimeout('/mouse/session/validate', {
            clientId: this.clientId,
            bootId: this.nativeBootId,
            generation: this.nativeGeneration,
            sessionId: this.nativeSessionId,
          }, controller);
          if (attempt !== this.connectionAttempt) {
            throw createAbortError(false);
          }
          if (attempt === this.connectionAttempt) {
            this.setConnectionReady(true);
          }
          return;
        } catch (error) {
          if (attempt !== this.connectionAttempt) {
            throw createAbortError(false);
          }
          if (!(error instanceof NativeCommandError && error.status === 409)) {
            throw error;
          }
          this.expireSession();
        } finally {
          if (this.lifecycleController === controller) {
            this.lifecycleController = null;
          }
        }
      }

      await this.activateSession(attempt);
      if (attempt === this.connectionAttempt) {
        this.setConnectionReady(true);
      }
    } finally {
      if (attempt === this.connectionAttempt) {
        this.recovering = false;
      }
    }
  }

  private async activateSession(connectionAttempt: number): Promise<void> {
    let recoveryAttempted = false;
    for (let retry = 0; retry < 2; retry += 1) {
      if (connectionAttempt !== this.connectionAttempt) {
        throw createAbortError(false);
      }

      let challenge: SessionChallenge;
      try {
        const challengeController = new AbortController();
        this.lifecycleController = challengeController;
        const response = await this.requestWithTimeout(
          '/mouse/session/challenge',
          { clientId: this.clientId },
          challengeController,
        );
        challenge = await readChallenge(response);
      } catch (error) {
        if (
          !recoveryAttempted
          && error instanceof NativeCommandError
          && error.status === 503
        ) {
          recoveryAttempted = true;
          const recoveryController = new AbortController();
          this.lifecycleController = recoveryController;
          await this.requestWithTimeout('/mouse/session/recover', {}, recoveryController);
          retry -= 1;
          continue;
        }
        throw error;
      } finally {
        this.lifecycleController = null;
      }

      if (connectionAttempt !== this.connectionAttempt) {
        throw createAbortError(false);
      }

      const sessionId = createIdentity();
      const controller = new AbortController();
      this.activationBootId = challenge.bootId;
      this.activationGeneration = challenge.generation;
      this.activationSessionId = sessionId;
      this.lifecycleController = controller;
      try {
        await this.requestWithTimeout('/mouse/session', {
          clientId: this.clientId,
          bootId: challenge.bootId,
          generation: challenge.generation,
          sessionId,
        }, controller);
        if (
          connectionAttempt !== this.connectionAttempt
          || challenge.bootId !== this.activationBootId
          || challenge.generation !== this.activationGeneration
        ) {
          throw createAbortError(false);
        }
        this.nativeBootId = challenge.bootId;
        this.nativeGeneration = challenge.generation;
        this.nativeSessionId = sessionId;
        this.activationBootId = null;
        this.activationGeneration = null;
        this.activationSessionId = null;
        this.nextSequence = 0;
        return;
      } catch (error) {
        if (
          !recoveryAttempted
          && error instanceof NativeCommandError
          && error.status === 503
        ) {
          recoveryAttempted = true;
          this.activationBootId = null;
          this.activationGeneration = null;
          this.activationSessionId = null;
          if (this.lifecycleController === controller) {
            this.lifecycleController = null;
          }
          const recoveryController = new AbortController();
          this.lifecycleController = recoveryController;
          try {
            await this.requestWithTimeout('/mouse/session/recover', {}, recoveryController);
          } finally {
            if (this.lifecycleController === recoveryController) {
              this.lifecycleController = null;
            }
          }
          retry -= 1;
          continue;
        }
        if (error instanceof NativeCommandError && error.status === 409 && retry === 0) {
          if (connectionAttempt !== this.connectionAttempt) {
            throw createAbortError(false);
          }
          this.activationBootId = null;
          this.activationGeneration = null;
          this.activationSessionId = null;
          continue;
        }
        if (this.activationSessionId === sessionId) {
          this.activationBootId = null;
          this.activationGeneration = null;
          this.activationSessionId = null;
        }
        throw error;
      } finally {
        if (this.lifecycleController === controller) {
          this.lifecycleController = null;
        }
      }
    }
    throw new Error('The native session could not be activated after a bounded retry.');
  }

  private enqueue(
    path: string,
    session: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.canQueue(session)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.pending.push({
        path,
        body: this.commandBody(payload),
        session,
        priorityRelease: false,
        resolve,
      });
      this.drain();
    });
  }

  private commandBody(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      bootId: this.nativeBootId,
      generation: this.nativeGeneration,
      sessionId: this.nativeSessionId,
      sequence: ++this.nextSequence,
      ...payload,
    };
  }

  private canQueue(session: number): boolean {
    return this.connectionReady
      && !this.recovering
      && this.nativeBootId !== null
      && this.nativeGeneration !== null
      && this.nativeSessionId !== null
      && this.trackingSession === session;
  }

  private clearPending(): void {
    for (const command of this.pending.splice(0)) {
      command.resolve();
    }
  }

  private async requestWithTimeout(
    path: string,
    body: Record<string, unknown>,
    controller: AbortController,
  ): Promise<Response> {
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      abortHandler = () => reject(createAbortError(timedOut));
      if (controller.signal.aborted) {
        abortHandler();
        return;
      }
      controller.signal.addEventListener('abort', abortHandler, { once: true });
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(createAbortError(true));
        controller.abort();
      }, this.timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.request(path, body, controller.signal),
        abortPromise,
        timeoutPromise,
      ]);
      if (!response.ok) {
        const errorResponse = await readNativeError(response);
        throw new NativeCommandError(
          path,
          response.status,
          errorResponse.code,
          errorResponse.message,
        );
      }
      return response;
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      if (abortHandler) {
        controller.signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  private drain(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    void (async () => {
      while (this.pending.length > 0) {
        const command = this.pending.shift()!;
        if (!command.priorityRelease && command.session !== this.trackingSession) {
          command.resolve();
          continue;
        }

        const controller = new AbortController();
        this.activeController = controller;
        try {
          await this.requestWithTimeout(command.path, command.body, controller);
        } catch (error) {
          if (error instanceof NativeCommandError && error.status === 409) {
            await this.recoverFromExpiredSession(command.path, error);
          } else if (!(error instanceof Error && error.name === 'AbortError')) {
            if (!(error instanceof NativeCommandError && error.status >= 400 && error.status < 500)) {
              await this.recoverFromExpiredSession(command.path, error);
            } else {
              this.onFailure(command.path, error);
            }
          }
        } finally {
          if (this.activeController === controller) {
            this.activeController = null;
          }
          command.resolve();
        }
      }
      this.running = false;
      if (this.pending.length > 0) {
        this.drain();
      }
    })();
  }

  private async recoverFromExpiredSession(path: string, error: unknown): Promise<void> {
    if (this.recovering) {
      return;
    }

    this.expireSession();
    this.recovering = true;
    try {
      await this.connect();
    } catch (recoveryError) {
      this.setConnectionReady(false);
      this.onFailure(path, error);
      this.onFailure('/mouse/session', recoveryError);
    } finally {
      this.recovering = false;
    }
  }

  private expireSession(): void {
    this.nativeBootId = null;
    this.nativeGeneration = null;
    this.nativeSessionId = null;
    this.activationBootId = null;
    this.activationGeneration = null;
    this.activationSessionId = null;
    this.setConnectionReady(false);
    this.clearPending();
    this.activeController?.abort();
  }

  private setConnectionReady(ready: boolean): void {
    if (this.connectionReady === ready) {
      return;
    }
    this.connectionReady = ready;
    this.onConnectionState(ready);
  }
}

async function readNativeError(
  response: Response,
): Promise<{ code: NativeCommandErrorCode; message: string }> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (typeof payload === 'object' && payload !== null && 'code' in payload && 'error' in payload) {
    const rawCode = payload.code;
    const rawMessage = payload.error;
    if (
      typeof rawCode === 'string'
      && nativeErrorCodes.has(rawCode as NativeCommandErrorCode)
      && typeof rawMessage === 'string'
    ) {
      const message = sanitizeNativeError(rawMessage);
      if (message) {
        return { code: rawCode as NativeCommandErrorCode, message };
      }
    }
  }

  return {
    code: 'http_error',
    message: `The local companion returned HTTP ${response.status}.`,
  };
}

function sanitizeNativeError(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0];
  const stackStart = firstLine.search(/\s+at\s+(?:[\w.$]+\s*\(|[A-Za-z]:\\|\/)/);
  const detail = stackStart >= 0 ? firstLine.slice(0, stackStart) : firstLine;
  const sanitized = detail
    .replace(/[^a-zA-Z0-9 .,;:()/_-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return sanitized;
}

function createIdentity(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type SessionChallenge = {
  bootId: string;
  generation: string;
};

async function readChallenge(response: Response): Promise<SessionChallenge> {
  const result: unknown = await response.json();
  if (
    typeof result !== 'object'
    || result === null
    || !('bootId' in result)
    || typeof result.bootId !== 'string'
    || result.bootId.length === 0
    || !('generation' in result)
    || typeof result.generation !== 'string'
    || !/^[1-9]\d{0,18}$/.test(result.generation)
    || (result.generation.length === 19 && result.generation > '9223372036854775807')
  ) {
    throw new Error('The native bridge returned an invalid session challenge.');
  }

  return { bootId: result.bootId, generation: result.generation };
}

function createAbortError(timedOut: boolean): Error {
  return new DOMException(
    timedOut ? 'Native request timed out.' : 'Native request was cancelled.',
    timedOut ? 'TimeoutError' : 'AbortError',
  );
}
