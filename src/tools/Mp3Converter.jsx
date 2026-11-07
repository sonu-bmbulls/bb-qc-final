import { useEffect, useRef, useState } from "react";
import { TT, ToolHeader, btnPrimary, btnGhost, panel, fmtBytes, fmtDuration } from "./theme.jsx";
import { decodeToAudioBuffer, encodeMp3 } from "./mp3Encode.js";

const BITRATES = [
  { kbps: 128, label: "128 kbps", hint: "Small file" },
  { kbps: 192, label: "192 kbps", hint: "Recommended" },
  { kbps: 320, label: "320 kbps", hint: "Best quality" },
];

// MP3 Converter — everything happens in the browser; the file never leaves
// the user's computer.
export default function Mp3Converter({ onBack }) {
  const [file, setFile] = useState(null);
  const [kbps, setKbps] = useState(192);
  const [phase, setPhase] = useState("idle"); // idle | decoding | encoding | done | error
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { url, name, size, duration }
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => () => { abortRef.current?.abort(); if (result?.url) URL.revokeObjectURL(result.url); }, [result]);

  const pick = (f) => {
    if (!f) return;
    abortRef.current?.abort();
    if (result?.url) URL.revokeObjectURL(result.url);
    setFile(f); setResult(null); setError(""); setPhase("idle"); setProgress(0);
  };

  const convert = async () => {
    if (!file) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setError(""); setResult(null); setProgress(0);
    try {
      setPhase("decoding");
      const buf = await decodeToAudioBuffer(file);
      if (ac.signal.aborted) return;
      setPhase("encoding");
      const blob = await encodeMp3(buf, kbps, setProgress, ac.signal);
      const base = file.name.replace(/\.[^.]+$/, "") || "audio";
      setResult({ url: URL.createObjectURL(blob), name: `${base}.mp3`, size: blob.size, duration: buf.duration });
      setPhase("done");
    } catch (e) {
      if (e?.name === "AbortError") { setPhase("idle"); return; }
      setError(e?.message || "Conversion failed.");
      setPhase("error");
    }
  };

  const cancel = () => { abortRef.current?.abort(); setPhase("idle"); setProgress(0); };
  const busy = phase === "decoding" || phase === "encoding";

  return (
    <div className="fade-in" style={{ maxWidth: 760, margin: "0 auto", paddingBottom: 48 }}>
      <ToolHeader icon="🎵" title="MP3 Converter" subtitle="Convert any video or audio file to MP3. Your file stays on your computer." onBack={onBack} />

      <div
        onClick={() => !busy && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!busy) pick(e.dataTransfer.files?.[0]); }}
        style={{
          ...panel,
          cursor: busy ? "default" : "pointer",
          textAlign: "center",
          padding: "40px 20px",
          borderStyle: "dashed",
          borderColor: dragOver ? TT.redBright : TT.border,
          background: dragOver ? TT.redTint : TT.panel,
        }}
      >
        <input ref={inputRef} type="file" accept="video/*,audio/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        <div style={{ fontSize: 38, marginBottom: 10 }}>{file ? "🎞️" : "⬆️"}</div>
        {file ? (
          <>
            <p style={{ fontWeight: 700, wordBreak: "break-all" }}>{file.name}</p>
            <p style={{ color: TT.textDim, fontSize: 12, marginTop: 4 }}>{fmtBytes(file.size)} · click to choose a different file</p>
          </>
        ) : (
          <>
            <p style={{ fontWeight: 700 }}>Drop a video or audio file here</p>
            <p style={{ color: TT.textDim, fontSize: 12, marginTop: 4 }}>MP4, MOV, WEBM, WAV, M4A… or click to browse</p>
          </>
        )}
      </div>

      <div style={{ ...panel, marginTop: 16 }}>
        <p style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: TT.textMute, marginBottom: 12 }}>Quality</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {BITRATES.map((b) => {
            const on = b.kbps === kbps;
            return (
              <button key={b.kbps} type="button" disabled={busy} onClick={() => setKbps(b.kbps)}
                style={{ padding: "12px 10px", borderRadius: 12, cursor: busy ? "default" : "pointer", border: `1px solid ${on ? TT.redBright : TT.border}`, background: on ? TT.redTint : "rgba(255,255,255,0.03)", color: "white" }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>{b.label}</div>
                <div style={{ fontSize: 11, color: TT.textDim, marginTop: 2 }}>{b.hint}</div>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 18, alignItems: "center" }}>
          <button type="button" onClick={convert} disabled={!file || busy} style={btnPrimary(!!file && !busy)}>
            {busy ? "Converting…" : "Convert to MP3"}
          </button>
          {busy && <button type="button" onClick={cancel} style={btnGhost}>Cancel</button>}
        </div>

        {busy && (
          <div style={{ marginTop: 16 }}>
            <div style={{ height: 8, borderRadius: 6, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${phase === "decoding" ? 4 : Math.max(4, Math.round(progress * 100))}%`, background: TT.gradient, transition: "width 0.2s" }} />
            </div>
            <p style={{ fontSize: 12, color: TT.textDim, marginTop: 8 }}>
              {phase === "decoding" ? "Reading audio from the file…" : `Encoding MP3… ${Math.round(progress * 100)}%`}
            </p>
          </div>
        )}

        {phase === "error" && (
          <p style={{ marginTop: 14, fontSize: 13, color: TT.redLight }}>⚠️ {error}</p>
        )}
      </div>

      {result && (
        <div className="pop-in" style={{ ...panel, marginTop: 16, borderColor: "rgba(16,185,129,0.4)" }}>
          <p style={{ fontWeight: 800, color: TT.green, marginBottom: 10 }}>✓ Your MP3 is ready</p>
          <audio controls src={result.url} style={{ width: "100%" }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: TT.textDim, wordBreak: "break-all" }}>
              {result.name} · {fmtDuration(result.duration)} · {fmtBytes(result.size)}
            </span>
            <a href={result.url} download={result.name} style={{ ...btnPrimary(true), textDecoration: "none", display: "inline-block" }}>⬇ Download MP3</a>
          </div>
        </div>
      )}
    </div>
  );
}
