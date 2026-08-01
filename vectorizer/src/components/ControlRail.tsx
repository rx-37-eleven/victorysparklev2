import { useState } from "react";
import type { PipelineParams } from "../lib/pipeline";
import type { LoadedInfo } from "../App";

interface Props {
  params: PipelineParams;
  setParams: (updater: (p: PipelineParams) => PipelineParams) => void;
  loaded: LoadedInfo;
  onNewFile: () => void;
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="control-row">
      <span className="control-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="control-value">{format ? format(value) : value}</span>
    </label>
  );
}

export function ControlRail({ params, setParams, loaded, onNewFile }: Props) {
  const [widthIn, setWidthIn] = useState<string>("");
  const offsetPreset =
    params.offsetMm === 0 ? "none" : params.offsetMm === 0.4 ? "foil" : params.offsetMm === 1.2 ? "came" : "custom";

  const applyWidthIn = (value: string) => {
    setWidthIn(value);
    const inches = Number(value);
    if (!Number.isFinite(inches) || inches <= 0) {
      setParams((p) => ({ ...p, mmPerPx: null }));
      return;
    }
    const mmPerPx = (inches * 25.4) / loaded.width;
    setParams((p) => ({ ...p, mmPerPx }));
  };

  return (
    <div className="control-rail">
      <div className="rail-section">
        <h2 className="rail-heading">Source</h2>
        <label className="control-row control-row-checkbox">
          <input type="checkbox" checked={params.invert} onChange={(e) => setParams((p) => ({ ...p, invert: e.target.checked }))} />
          Invert
        </label>
        <button className="btn btn-link" onClick={onNewFile}>
          Choose a different image
        </button>
        {loaded.downsampled && (
          <p className="hint-text">
            Downsampled from {loaded.originalWidth}×{loaded.originalHeight} to {loaded.width}×{loaded.height}px for
            performance.
          </p>
        )}
      </div>

      <div className="rail-section">
        <h2 className="rail-heading">Threshold</h2>
        <Slider label="Threshold" value={params.threshold} min={0} max={255} step={1} onChange={(v) => setParams((p) => ({ ...p, threshold: v }))} />
        <label className="control-row control-row-checkbox">
          <input type="checkbox" checked={params.adaptive} onChange={(e) => setParams((p) => ({ ...p, adaptive: e.target.checked }))} />
          Adaptive (uneven lighting / scans)
        </label>
        {params.adaptive && (
          <Slider label="Window" value={params.adaptiveWindow} min={5} max={99} step={2} onChange={(v) => setParams((p) => ({ ...p, adaptiveWindow: v }))} />
        )}
        <label className="control-row control-row-checkbox">
          <input type="checkbox" checked={params.cleanUpScan} onChange={(e) => setParams((p) => ({ ...p, cleanUpScan: e.target.checked }))} />
          Clean up scan
        </label>
      </div>

      <div className="rail-section">
        <h2 className="rail-heading">Lines</h2>
        <Slider label="Close gaps" value={params.closeGaps} min={0} max={8} step={1} onChange={(v) => setParams((p) => ({ ...p, closeGaps: v }))} format={(v) => `${v}px`} />
        <Slider label="Despeckle" value={params.despeckle} min={0} max={40} step={1} onChange={(v) => setParams((p) => ({ ...p, despeckle: v }))} format={(v) => `${v}px²`} />
        <label className="control-row control-row-checkbox">
          <input
            type="checkbox"
            checked={params.treatEdgeAsBorder}
            onChange={(e) => setParams((p) => ({ ...p, treatEdgeAsBorder: e.target.checked }))}
          />
          Treat image edge as panel border
        </label>
      </div>

      <div className="rail-section">
        <h2 className="rail-heading">Curves</h2>
        <Slider
          label="Smoothing"
          value={params.smoothingSigma}
          min={0}
          max={4}
          step={0.1}
          onChange={(v) => setParams((p) => ({ ...p, smoothingSigma: v }))}
        />
        <Slider
          label="Corner sharpness"
          value={params.cornerAngleDeg}
          min={20}
          max={90}
          step={1}
          onChange={(v) => setParams((p) => ({ ...p, cornerAngleDeg: v }))}
          format={(v) => `${v}°`}
        />
      </div>

      <div className="rail-section">
        <h2 className="rail-heading">Size</h2>
        <label className="control-row">
          <span className="control-label">Width</span>
          <input
            className="text-input"
            type="number"
            min={0}
            step="0.1"
            placeholder="in"
            value={widthIn}
            onChange={(e) => applyWidthIn(e.target.value)}
          />
          <span className="control-value">in</span>
        </label>
        <label className="control-row">
          <span className="control-label">Foil / came</span>
          <select
            value={offsetPreset}
            disabled={params.mmPerPx === null}
            onChange={(e) => {
              const v = e.target.value;
              const mm = v === "none" ? 0 : v === "foil" ? 0.4 : v === "came" ? 1.2 : params.offsetMm;
              setParams((p) => ({ ...p, offsetMm: mm }));
            }}
          >
            <option value="none">None (0.00mm)</option>
            <option value="foil">Copper foil (0.4mm/side)</option>
            <option value="came">Lead came (1.2mm/side)</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {offsetPreset === "custom" && (
          <Slider label="Offset" value={params.offsetMm} min={0} max={5} step={0.1} onChange={(v) => setParams((p) => ({ ...p, offsetMm: v }))} format={(v) => `${v.toFixed(1)}mm`} />
        )}
        {params.mmPerPx === null && <p className="hint-text">Set a physical width to enable the kerf offset.</p>}
      </div>
    </div>
  );
}
