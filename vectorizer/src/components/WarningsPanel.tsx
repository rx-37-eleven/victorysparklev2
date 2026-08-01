interface Warning {
  label: number;
  kind: string;
  message: string;
  valueMm: number;
}

interface PieceStat {
  id: string;
  label: number;
  areaMm2: number;
  minWidthMm: number;
}

export function WarningsPanel({
  warnings,
  onSelect,
  attentionCount,
}: {
  warnings: Warning[];
  pieceStats: PieceStat[];
  onSelect: (label: number) => void;
  attentionCount: number;
}) {
  if (warnings.length === 0) {
    return (
      <div className="warnings-panel">
        <h2 className="rail-heading">Warnings</h2>
        <p className="hint-text">{attentionCount === 0 ? "No cuttability issues found." : ""}</p>
      </div>
    );
  }

  return (
    <div className="warnings-panel">
      <h2 className="rail-heading">Warnings ({warnings.length})</h2>
      <ul className="warnings-list">
        {warnings.map((w, i) => (
          <li key={i}>
            <button className="warning-item" onClick={() => onSelect(w.label)}>
              <span className="warning-icon" aria-hidden>
                ⚠
              </span>
              <span>
                piece-{String(w.label).padStart(3, "0")} {w.message}
              </span>
              <span aria-hidden>→</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
