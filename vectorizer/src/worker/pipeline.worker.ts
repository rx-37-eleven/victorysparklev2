/// <reference lib="webworker" />

import { toGrayscale } from "../lib/grayscale";
import { PipelineCache, runPipeline, otsuDefault, DEFAULT_PARAMS, type PipelineParams } from "../lib/pipeline";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const MAX_LONG_EDGE = 4000;

interface LoadMessage {
  type: "load";
  requestId: number;
  blob: Blob;
}

interface RunMessage {
  type: "run";
  requestId: number;
  params: PipelineParams;
  view: "source" | "bw" | "pieces" | "cutlines";
}

type InMessage = LoadMessage | RunMessage;

const cache = new PipelineCache();
let downsampled = false;
let originalWidth = 0;
let originalHeight = 0;

ctx.addEventListener("message", (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  if (msg.type === "load") {
    handleLoad(msg).catch((err) => {
      ctx.postMessage({ type: "error", requestId: msg.requestId, message: String(err) });
    });
  } else if (msg.type === "run") {
    handleRun(msg);
  }
});

async function handleLoad(msg: LoadMessage): Promise<void> {
  const bitmap = await createImageBitmap(msg.blob);
  originalWidth = bitmap.width;
  originalHeight = bitmap.height;
  const longEdge = Math.max(bitmap.width, bitmap.height);
  let width = bitmap.width;
  let height = bitmap.height;
  downsampled = longEdge > MAX_LONG_EDGE;
  if (downsampled) {
    const scale = MAX_LONG_EDGE / longEdge;
    width = Math.round(bitmap.width * scale);
    height = Math.round(bitmap.height * scale);
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx2d = canvas.getContext("2d")!;
  ctx2d.drawImage(bitmap, 0, 0, width, height);
  const imageData = ctx2d.getImageData(0, 0, width, height);

  const isJpeg = msg.blob.type === "image/jpeg";
  const gray = toGrayscale(imageData.data, width, height);
  cache.loadSource(gray, width, height, isJpeg);
  const otsu = otsuDefault(cache);

  const rgba = imageData.data;
  ctx.postMessage(
    {
      type: "loaded",
      requestId: msg.requestId,
      width,
      height,
      originalWidth,
      originalHeight,
      downsampled,
      otsuThreshold: otsu,
      sourceRgba: rgba,
    },
    { transfer: [rgba.buffer] },
  );
}

function labelsToColorRgba(labels: Int32Array, width: number, height: number, colors: Map<number, [number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const color = label > 0 ? colors.get(label) : undefined;
    const o = i * 4;
    if (color) {
      out[o] = color[0];
      out[o + 1] = color[1];
      out[o + 2] = color[2];
      out[o + 3] = 255;
    } else {
      out[o] = 20;
      out[o + 1] = 20;
      out[o + 2] = 24;
      out[o + 3] = 255;
    }
  }
  return out;
}

function inkToRgba(ink: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ink.length * 4);
  for (let i = 0; i < ink.length; i++) {
    const v = ink[i] ? 0 : 255;
    const o = i * 4;
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}

function handleRun(msg: RunMessage): void {
  if (!cache.sourceGray) return;
  try {
    const result = runPipeline(cache, msg.params ?? DEFAULT_PARAMS);

    const warningsPlain = result.warnings.map((w) => ({ ...w }));
    const pieceStats = Array.from(result.svg.pieces);

    if (msg.view === "bw") {
      const rgba = inkToRgba(result.ink);
      ctx.postMessage(
        { type: "result", requestId: msg.requestId, view: "bw", width: result.width, height: result.height, rgba, warnings: warningsPlain, pieceStats, pieceCount: result.pieceCount },
        { transfer: [rgba.buffer] },
      );
    } else if (msg.view === "pieces") {
      const rgba = labelsToColorRgba(result.labels, result.width, result.height, result.pieceColors);
      ctx.postMessage(
        { type: "result", requestId: msg.requestId, view: "pieces", width: result.width, height: result.height, rgba, warnings: warningsPlain, pieceStats, pieceCount: result.pieceCount },
        { transfer: [rgba.buffer] },
      );
    } else {
      // "cutlines" and "source" both just need the SVG + warnings; "source" view is drawn from the cached original bitmap on the main thread.
      ctx.postMessage({
        type: "result",
        requestId: msg.requestId,
        view: msg.view,
        width: result.width,
        height: result.height,
        svg: result.svg.svg,
        warnings: warningsPlain,
        pieceStats,
        pieceCount: result.pieceCount,
      });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", requestId: msg.requestId, message: String(err) });
  }
}
