import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type { PipelineParams } from "./lib/pipeline";
import { DEFAULT_PARAMS } from "./lib/pipeline";
import { CanvasView } from "./components/CanvasView";
import { ControlRail } from "./components/ControlRail";
import { WarningsPanel } from "./components/WarningsPanel";
import { DropZone } from "./components/DropZone";

export type ViewMode = "source" | "bw" | "pieces" | "cutlines";

export interface LoadedInfo {
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  downsampled: boolean;
  otsuThreshold: number;
  sourceRgba: Uint8ClampedArray;
}

export interface RunResult {
  view: ViewMode;
  width: number;
  height: number;
  rgba?: Uint8ClampedArray;
  svg?: string;
  warnings: { label: number; kind: string; message: string; valueMm: number }[];
  pieceStats: { id: string; label: number; areaMm2: number; minWidthMm: number }[];
  pieceCount: number;
}

let requestCounter = 0;

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loaded, setLoaded] = useState<LoadedInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<PipelineParams>(DEFAULT_PARAMS);
  const [view, setView] = useState<ViewMode>("pieces");
  const [result, setResult] = useState<RunResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<number | null>(null);

  const inFlightRef = useRef<{ requestId: number; view: ViewMode } | null>(null);
  const pendingRef = useRef<{ params: PipelineParams; view: ViewMode } | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./worker/pipeline.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "loaded") {
        setLoading(false);
        setLoaded({
          width: msg.width,
          height: msg.height,
          originalWidth: msg.originalWidth,
          originalHeight: msg.originalHeight,
          downsampled: msg.downsampled,
          otsuThreshold: msg.otsuThreshold,
          sourceRgba: msg.sourceRgba,
        });
        setParams((p) => ({ ...p, threshold: msg.otsuThreshold }));
      } else if (msg.type === "result") {
        setComputing(false);
        setResult(msg);
        inFlightRef.current = null;
        if (pendingRef.current) {
          const next = pendingRef.current;
          pendingRef.current = null;
          sendRun(next.params, next.view);
        }
      } else if (msg.type === "error") {
        setLoading(false);
        setComputing(false);
        setError(msg.message);
        inFlightRef.current = null;
      }
    };
    return () => worker.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendRun = useCallback((p: PipelineParams, v: ViewMode) => {
    const worker = workerRef.current;
    if (!worker) return;
    const requestId = ++requestCounter;
    inFlightRef.current = { requestId, view: v };
    setComputing(true);
    worker.postMessage({ type: "run", requestId, params: p, view: v });
  }, []);

  const requestRun = useCallback(
    (p: PipelineParams, v: ViewMode) => {
      if (inFlightRef.current) {
        pendingRef.current = { params: p, view: v };
        return;
      }
      sendRun(p, v);
    },
    [sendRun],
  );

  useEffect(() => {
    if (!loaded) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      requestRun(params, view);
    }, 60);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, view, loaded]);

  const handleFile = useCallback((f: File) => {
    setFile(f);
    setError(null);
    setLoading(true);
    setResult(null);
    const worker = workerRef.current;
    if (!worker) return;
    const requestId = ++requestCounter;
    worker.postMessage({ type: "load", requestId, blob: f });
  }, []);

  const attentionCount = result?.warnings.length ?? 0;

  const exportSvg = useCallback(() => {
    if (!result?.svg) return;
    const blob = new Blob([result.svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pattern.svg";
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  const exportPng = useCallback(() => {
    if (!result?.svg) return;
    const img = new Image();
    const svgBlob = new Blob([result.svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const pngUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = pngUrl;
        a.download = "pattern-preview.png";
        a.click();
        URL.revokeObjectURL(pngUrl);
      }, "image/png");
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }, [result]);

  const statusText = useMemo(() => {
    if (!loaded) return "";
    if (result) {
      const n = result.pieceCount;
      const warn = result.warnings.length;
      return `${n} piece${n === 1 ? "" : "s"}${warn > 0 ? ` · ${warn} need${warn === 1 ? "s" : ""} attention` : ""}`;
    }
    return "";
  }, [loaded, result]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Stained Glass Vectorizer</div>
        <div className="topbar-title">{file?.name ?? "Untitled pattern"}</div>
        <div className="topbar-actions">
          <button className="btn" disabled={!result?.svg} onClick={exportPng}>
            PNG preview
          </button>
          <button className="btn btn-primary" disabled={!result?.svg} onClick={exportSvg}>
            Export SVG
          </button>
        </div>
      </header>
      <div className="body">
        <aside className="rail">
          {!loaded ? (
            <DropZone onFile={handleFile} loading={loading} error={error} />
          ) : (
            <ControlRail params={params} setParams={setParams} loaded={loaded} onNewFile={() => setLoaded(null)} />
          )}
        </aside>
        <main className="canvas-area">
          {loaded && (
            <div className="view-modes" role="tablist" aria-label="View mode">
              {(["source", "bw", "pieces", "cutlines"] as ViewMode[]).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  className={`view-tab ${view === v ? "active" : ""}`}
                  onClick={() => setView(v)}
                >
                  {v === "source" ? "Source" : v === "bw" ? "Black & White" : v === "pieces" ? "Pieces" : "Cut lines"}
                </button>
              ))}
              {computing && (
                <span className="computing-indicator" aria-live="polite">
                  Computing…
                </span>
              )}
            </div>
          )}
          <CanvasView loaded={loaded} result={result} view={view} selectedLabel={selectedLabel} onSelectLabel={setSelectedLabel} />
        </main>
        <aside className="status-panel">
          {statusText && <div className="status-summary">{statusText}</div>}
          <WarningsPanel warnings={result?.warnings ?? []} pieceStats={result?.pieceStats ?? []} onSelect={setSelectedLabel} attentionCount={attentionCount} />
        </aside>
      </div>
      <footer className="footer">Everything runs locally in your browser. No image ever leaves your machine.</footer>
    </div>
  );
}
