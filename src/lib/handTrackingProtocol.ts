export type WorkerRequest =
  | { type: 'init'; session: number; requestId: number }
  | { type: 'frame'; bitmap: ImageBitmap; session: number; requestId: number };

export type WorkerResponse =
  | { type: 'ready'; session: number; requestId: number }
  | { type: 'result'; landmarks: Array<{ x: number; y: number }> | null; session: number; requestId: number }
  | { type: 'error'; message: string; phase: 'init' | 'frame'; session: number; requestId: number };

export interface WorkerPort {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  terminate(): void;
}
