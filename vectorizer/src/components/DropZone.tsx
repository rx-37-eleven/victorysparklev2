import { useCallback, useRef, useState } from "react";

export function DropZone({ onFile, loading, error }: { onFile: (f: File) => void; loading: boolean; error: string | null }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (f) onFile(f);
    },
    [onFile],
  );

  return (
    <div className="drop-panel">
      <h2 className="rail-heading">Source</h2>
      <div
        className={`dropzone ${dragOver ? "drag-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
        {loading ? (
          <p>Loading…</p>
        ) : (
          <>
            <p className="dropzone-title">Drop a line-art PNG or JPG</p>
            <p className="dropzone-hint">or click to choose a file</p>
          </>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="empty-state-help">
        <p>
          <strong>What works:</strong> clean black lines on white, drawn or scanned at a decent resolution. Lead
          lines should form closed regions -- every piece needs to be a fully bounded cell.
        </p>
        <p>
          <strong>What doesn't:</strong> photos, grayscale shading, or anti-aliased-to-death JPEGs where the lines
          have gone soft and grey rather than solid black.
        </p>
      </div>
    </div>
  );
}
