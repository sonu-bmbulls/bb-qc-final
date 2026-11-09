import { useEffect, useRef, useState } from "react";
import { zipSync } from "fflate";
import { TT, ToolHeader, btnPrimary, btnGhost, panel, fmtBytes, fmtDuration } from "./theme.jsx";
import { decodeToAudioBuffer, encodeInWorker, cancelAllEncoding, PARALLEL } from "./mp3Encode.js";

const MAX_FILES = 25;
const BITRATES = [
  { kbps: 128, label: "128 kbps", hint: "Small file" },
  { kbps: 192, label: "192 kbps", hint: "Recommended" },
  { kbps: 320, label: "320 kbps", hint: "Best quality" },
];
const STATUS = {
  queued:   { label: "Waiting",     color: TT.textDim },
  decoding: { label: "Reading…",    color: TT.amber },
  encoding: { label: "Converting…", color: TT.amber },
  done:     { label: "Done",        color: TT.green },
  error:    { label: "Failed",      color: TT.redBright },
};

let uid = 0;
const mp3Name = (name) => `${name.replace(/\.[^.]+$/, "") || "audio"}.mp3`;

// Bulk MP3 Converter — up to 25 files, converted one after another in the
// browser (decode via Web Audio, encode in a Web Worker). Nothing is uploaded.
export default function Mp3Converter({ onBack }) {
  const [items, setItems] = useState([]); // {id, file, status, progress, error, url, size, duration}
  const [kbps, setKbps] = useState(192);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef(null);
  const stopRef = useRef(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => {
    cancelAllEncoding();
    itemsRef.current.forEach((it) => it.url && URL.revokeObjectURL(it.url));
  }, []);

  const patch = (id, p) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it)));

  const addFiles = (fileList) => {
    const files = Array.from(fileList || []).filter((f) => /^(audio|video)\//.test(f.type) || /\.(mp4|mov|m4v|mkv|webm|avi|wav|m4a|aac|flac|ogg|opus|mp3|wma)$/i.test(f.name));
    if (!files.length) return;
    const room = MAX_FILES - itemsRef.current.length;
    if (room <= 0) { setNotice(`Max ${MAX_FILES} files per batch.`); return; }
    setNotice(files.length > room ? `Added ${room} files — max ${MAX_FILES} per batch.` : "");
    setItems((list) => [...list, ...files.slice(0, room).map((file) => ({ id: ++uid, file, status: "queued", progress: 0 }))]);
  };

  const removeItem = (id) => setItems((list) => {
    const it = list.find((x) => x.id === id);
    if (it?.url) URL.revokeObjectURL(it.url);
    return list.filter((x) => x.id !== id);
  });

  const clearAll = () => {
    if (running) return;
    items.forEach((it) => it.url && URL.revokeObjectURL(it.url));
    setItems([]); setNotice("");
  };

  // Converts PARALLEL files at a time. Big files (> 300 MB) take every slot so
  // several decoded videos never sit in memory at once.
  const convertAll = async () => {
    setRunning(true); stopRef.current = false;
    const t0 = performance.now();
    const queue = itemsRef.current.filter((it) => it.status !== "done").map((it) => it.id);
    let inUse = 0;
    const waiters = [];
    const take = async (w) => {
      while (inUse + w > PARALLEL) await new Promise((ok) => waiters.push(ok));
      inUse += w;
    };
    const give = (w) => { inUse -= w; waiters.splice(0).forEach((ok) => ok()); };

    const runOne = async (id) => {
      const it = itemsRef.current.find((x) => x.id === id);
      if (!it || stopRef.current) return;
      const weight = it.file.size > 300 * 1024 * 1024 ? PARALLEL : 1;
      await take(weight);
      try {
        if (stopRef.current) return;
        patch(id, { status: "decoding", progress: 0, error: "" });
        const buf = await decodeToAudioBuffer(it.file);
        if (stopRef.current) return;
        patch(id, { status: "encoding", progress: 0.02 });
        const blob = await encodeInWorker(buf, kbps, (v) => patch(id, { progress: v }));
        patch(id, { status: "done", progress: 1, url: URL.createObjectURL(blob), size: blob.size, duration: buf.duration, blob });
      } catch (e) {
        if (e?.name === "AbortError") patch(id, { status: "queued", progress: 0 });
        else patch(id, { status: "error", error: e?.message || "Conversion failed." });
      } finally {
        give(weight);
      }
    };

    let next = 0;
    const lane = async () => { while (!stopRef.current && next < queue.length) await runOne(queue[next++]); };
    await Promise.all(Array.from({ length: PARALLEL }, lane));
    setElapsed((performance.now() - t0) / 1000);
    setRunning(false);
  };

  const stop = () => {
    stopRef.current = true;
    cancelAllEncoding();
    setItems((list) => list.map((it) => (it.status === "decoding" || it.status === "encoding" ? { ...it, status: "queued", progress: 0 } : it)));
    setRunning(false);
  };

  const downloadZip = async () => {
    const done = items.filter((it) => it.status === "done" && it.blob);
    if (!done.length) return;
    const files = {};
    const used = new Set();
    for (const it of done) {
      let name = mp3Name(it.file.name), n = 2;
      while (used.has(name)) name = mp3Name(it.file.name).replace(/\.mp3$/, ` (${n++}).mp3`);
      used.add(name);
      files[name] = [new Uint8Array(await it.blob.arrayBuffer()), { level: 0 }]; // MP3 is already compressed
    }
    const zip = zipSync(files);
    const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `mp3-batch-${new Date().toISOString().slice(0, 10)}.zip` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const doneCount = items.filter((it) => it.status === "done").length;
  const failCount = items.filter((it) => it.status === "error").length;
  const pendingCount = items.length - doneCount;
  const overall = items.length ? items.reduce((s, it) => s + (it.status === "done" ? 1 : it.progress || 0), 0) / items.length : 0;

  return (
    <div className="fade-in" style={{ maxWidth: 900, margin: "0 auto", paddingBottom: 48 }}>
      <ToolHeader icon="🎵" title="MP3 Converter" subtitle={`Convert up to ${MAX_FILES} video or audio files to MP3 at once. Files stay on your computer.`} onBack={onBack} />

      <div
        onClick={() => !running && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!running) addFiles(e.dataTransfer.files); }}
        style={{ ...panel, cursor: running ? "default" : "pointer", textAlign: "center", padding: "32px 20px", borderStyle: "dashed", borderColor: dragOver ? TT.redBright : TT.border, background: dragOver ? TT.redTint : TT.panel }}
      >
        <input ref={inputRef} type="file" multiple accept="video/*,audio/*" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <div style={{ fontSize: 34, marginBottom: 8 }}>⬆️</div>
        <p style={{ fontWeight: 700 }}>Drop files here or click to browse</p>
        <p style={{ color: TT.textDim, fontSize: 12, marginTop: 4 }}>MP4, MOV, WEBM, MKV, WAV, M4A, FLAC… · up to {MAX_FILES} files ({items.length}/{MAX_FILES} added)</p>
      </div>
      {notice && <p style={{ marginTop: 10, fontSize: 12, color: TT.amber }}>⚠️ {notice}</p>}

      <div style={{ ...panel, marginTop: 16 }}>
        <p style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: TT.textMute, marginBottom: 12 }}>Quality (applies to all files)</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {BITRATES.map((b) => {
            const on = b.kbps === kbps;
            return (
              <button key={b.kbps} type="button" disabled={running} onClick={() => setKbps(b.kbps)}
                style={{ padding: "12px 10px", borderRadius: 12, cursor: running ? "default" : "pointer", border: `1px solid ${on ? TT.redBright : TT.border}`, background: on ? TT.redTint : "rgba(255,255,255,0.03)", color: "white" }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>{b.label}</div>
                <div style={{ fontSize: 11, color: TT.textDim, marginTop: 2 }}>{b.hint}</div>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 18, alignItems: "center", flexWrap: "wrap" }}>
          {!running ? (
            <button type="button" onClick={convertAll} disabled={!pendingCount} style={btnPrimary(!!pendingCount)}>
              {!items.length ? "Add files to convert"
                : !pendingCount ? "All converted ✓"
                : failCount && pendingCount === failCount ? `Retry ${failCount} failed`
                : `Convert ${pendingCount} file${pendingCount === 1 ? "" : "s"} to MP3`}
            </button>
          ) : (
            <button type="button" onClick={stop} style={{ ...btnPrimary(true), background: "rgba(255,255,255,0.08)", boxShadow: "none" }}>■ Stop</button>
          )}
          <button type="button" onClick={downloadZip} disabled={!doneCount || running} style={{ ...btnGhost, padding: "12px 16px", opacity: doneCount && !running ? 1 : 0.4, cursor: doneCount && !running ? "pointer" : "not-allowed" }}>
            ⬇ Download all ({doneCount}) as ZIP
          </button>
          {items.length > 0 && !running && <button type="button" onClick={clearAll} style={{ ...btnGhost, padding: "12px 16px" }}>Clear list</button>}
        </div>

        {items.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ height: 6, borderRadius: 6, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.round(overall * 100)}%`, background: TT.gradient, transition: "width 0.3s" }} />
            </div>
            <p style={{ fontSize: 12, color: TT.textDim, marginTop: 6 }}>
              {doneCount} of {items.length} done{failCount ? ` · ${failCount} failed` : ""}
              {running ? ` · converting ${Math.min(PARALLEL, items.length - doneCount)} at a time…` : elapsed && doneCount ? ` · took ${elapsed.toFixed(1)} s` : ""}
            </p>
          </div>
        )}
      </div>

      {items.length > 0 && (
        <div style={{ ...panel, marginTop: 16, padding: 0, overflow: "hidden" }}>
          {items.map((it, i) => {
            const st = STATUS[it.status];
            const active = it.status === "decoding" || it.status === "encoding";
            return (
              <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: i ? `1px solid ${TT.border}` : "none" }}>
                <span style={{ width: 22, fontSize: 11, color: TT.textDim, fontFamily: "DM Mono, monospace" }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.file.name}</p>
                  <p style={{ fontSize: 11, color: it.status === "error" ? TT.redLight : TT.textDim, marginTop: 2 }}>
                    {it.status === "done"
                      ? `${mp3Name(it.file.name)} · ${fmtDuration(it.duration)} · ${fmtBytes(it.size)}`
                      : it.status === "error" ? it.error : fmtBytes(it.file.size)}
                  </p>
                  {active && (
                    <div style={{ height: 4, borderRadius: 4, background: "rgba(255,255,255,0.06)", overflow: "hidden", marginTop: 6 }}>
                      <div style={{ height: "100%", width: `${Math.max(3, Math.round((it.progress || 0) * 100))}%`, background: TT.gradient, transition: "width 0.2s" }} />
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 11, fontWeight: 800, color: st.color, minWidth: 82, textAlign: "right" }}>
                  {it.status === "encoding" ? `${Math.round((it.progress || 0) * 100)}%` : st.label}
                </span>
                {it.status === "done" ? (
                  <a href={it.url} download={mp3Name(it.file.name)} style={{ padding: "7px 12px", borderRadius: 9, background: TT.gradient, color: "white", fontSize: 12, fontWeight: 800, textDecoration: "none" }}>⬇ MP3</a>
                ) : (
                  <button type="button" onClick={() => removeItem(it.id)} disabled={active} title="Remove"
                    style={{ ...btnGhost, padding: "6px 10px", opacity: active ? 0.3 : 1 }}>✕</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
