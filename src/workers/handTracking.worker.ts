/// <reference lib="webworker" />

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import wasmNoSimdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url';
import wasmNoSimdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url';

type WorkerRequest =
  | { type: 'init' }
  | { type: 'frame'; bitmap: ImageBitmap };

type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; landmarks: Array<{ x: number; y: number }> | null }
  | { type: 'error'; message: string };

let handLandmarker: HandLandmarker | null = null;
let initialization: Promise<void> | null = null;

const workerScope = self as DedicatedWorkerGlobalScope;

async function initialize(): Promise<void> {
  if (handLandmarker) {
    return;
  }
  if (initialization) {
    return initialization;
  }

  initialization = (async () => {
    const vision = await FilesetResolver.forVisionTasks();
    const usesNoSimd = vision.wasmLoaderPath.includes('_nosimd_');
    vision.wasmLoaderPath = usesNoSimd ? wasmNoSimdLoaderUrl : wasmLoaderUrl;
    vision.wasmBinaryPath = usesNoSimd ? wasmNoSimdBinaryUrl : wasmBinaryUrl;
    const options = {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      },
      runningMode: 'VIDEO' as const,
      numHands: 1,
    };

    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'GPU' },
      });
    } catch {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'CPU' },
      });
    }
  })();

  try {
    await initialization;
  } catch (error) {
    initialization = null;
    throw error;
  }
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'init') {
      await initialize();
      workerScope.postMessage({ type: 'ready' } satisfies WorkerResponse);
      return;
    }

    const bitmap = event.data.bitmap;
    try {
      await initialize();
      const result = handLandmarker!.detectForVideo(bitmap, performance.now());
      const landmarks = result.landmarks[0]?.map(({ x, y }) => ({ x, y })) ?? null;
      workerScope.postMessage({ type: 'result', landmarks } satisfies WorkerResponse);
    } finally {
      bitmap.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    workerScope.postMessage({ type: 'error', message } satisfies WorkerResponse);
  }
};