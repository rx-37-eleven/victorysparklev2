import { useEffect, useMemo, useRef, useState } from "react";
import type { LoadedInfo, RunResult, ViewMode } from "../App";

interface Props {
  loaded: LoadedInfo | null;
  result: RunResult | null;
  view: ViewMode;
  selectedLabel: number | null;
  onSelectLabel: (label: number) => void;
}

export function CanvasView({ loaded, result, view, selectedLabel, onSelectLabel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const draggingRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const width = loaded?.width ?? 0;
  const height = loaded?.height ?? 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !loaded) return;
    if (view === "cutlines") return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rgba: Uint8ClampedArray | undefined;
    if (view === "source") {
      rgba = loaded.sourceRgba;
    } else if (result && result.view === view && result.rgba) {
      rgba = result.rgba;
    }
    if (rgba && rgba.length === width * height * 4) {
      const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
      ctx.putImageData(imageData, 0, 0);
    } else {
      ctx.fillStyle = "#141418";
      ctx.fillRect(0, 0, width, height);
    }
  }, [loaded, result, view, width, height]);

  const idToLabel = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of result?.pieceStats ?? []) map.set(p.id, p.label);
    return map;
  }, [result]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    setTransform((t) => ({ ...t, scale: Math.min(20, Math.max(0.1, t.scale * (1 + delta))) }));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    draggingRef.current = { startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = draggingRef.current;
    if (!drag) return;
    setTransform((t) => ({ ...t, x: drag.origX + (e.clientX - drag.startX), y: drag.origY + (e.clientY - drag.startY) }));
  };
  const onPointerUp = () => {
    draggingRef.current = null;
  };

  const onSvgClick = (e: React.MouseEvent) => {
    let el = e.target as Element | null;
    while (el && el.tagName !== "path") el = el.parentElement;
    const id = el?.getAttribute("id");
    if (id) {
      const label = idToLabel.get(id);
      if (label !== undefined) onSelectLabel(label);
    }
  };

  if (!loaded) {
    return <div className="canvas-empty">Drop an image to get started.</div>;
  }

  return (
    <div
      className="canvas-viewport"
      ref={containerRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div
        className="canvas-transform-layer"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        {view === "cutlines" ? (
          result?.svg ? (
            <div
              className={`svg-overlay ${selectedLabel !== null ? "has-selection" : ""}`}
              onClick={onSvgClick}
              dangerouslySetInnerHTML={{ __html: result.svg }}
            />
          ) : (
            <div className="canvas-empty">Computing vector preview…</div>
          )
        ) : (
          <canvas ref={canvasRef} />
        )}
      </div>
    </div>
  );
}
