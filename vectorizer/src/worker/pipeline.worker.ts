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
    }
    // Anything with no piece -- the came gap between two pieces, and
    // whatever falls outside the panel -- is left transparent so the
    // canvas's checkerboard shows through. It used to be filled near-black,
    // which was fine when every pixel belonged to some region: the pieces
    // came from a watershed that labelled the whole image. Now they come
    // from offset geometry, so "no piece" covers the gaps and the margin
    // around the artwork, and filling that black turned the preview into a
    // black rectangle for any drawing that doesn't reach the page edges.
    
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

    // The SVG rides along with every view, not just the cut-lines one. The
    // export buttons are enabled by its presence, and the default view is
    // "pieces", so leaving it out meant the buttons sat disabled until you
    // happened to click through to "Cut lines" -- with nothing on screen
    // saying that was the reason. The pipeline builds the SVG on every run
    // regardless, and the bitmap views already post a multi-megabyte pixel
    // buffer, so carrying a few hundred kilobytes of markup alongside it
    // costs nothing worth having.
    const common = {
      type: "result" as const,
      requestId: msg.requestId,
      width: result.width,
      height: result.height,
      svg: result.svg.svg,
      warnings: warningsPlain,
      pieceStats,
      pieceCount: result.pieceCount,
    };

    if (msg.view === "bw" || msg.view === "pieces") {
      const rgba =
        msg.view === "bw"
          ? inkToRgba(result.ink)
          : labelsToColorRgba(result.labels, result.width, result.height, result.pieceColors);
      ctx.postMessage({ ...common, view: msg.view, rgba }, { transfer: [rgba.buffer] });
    } else {
      // "source" is drawn from the cached original bitmap on the main thread.
      ctx.postMessage({ ...common, view: msg.view });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", requestId: msg.requestId, message: String(err) });
  }
}
