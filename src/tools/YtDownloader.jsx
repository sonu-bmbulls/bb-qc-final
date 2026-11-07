import { useMemo, useState } from "react";
import { TT, ToolHeader, btnPrimary, inputStyle, panel, fmtBytes, fmtDuration } from "./theme.jsx";

// YT Downloader — yt-dlp + ffmpeg on the server (api/yt/info.js, api/yt/download.js).
//   • Video in any available quality up to 4K
//   • MP3 audio (128 / 192 / 320 kbps)
//   • Optional start → end timestamp to download just one segment
const MP3_RATES = [128, 192, 320];

function parseTime(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

const chip = (on) => ({
  padding: "11px 14px", borderRadius: 12, cursor: "pointer", textAlign: "left",
  border: `1px solid ${on ? TT.redBright : TT.border}`,
  background: on ? TT.redTint : "rgba(255,255,255,0.03)", color: "white",
});
const label = { fontSize: 12, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: TT.textMute, marginBottom: 10 };

export default function YtDownloader({ onBack }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState(null);
  const [kind, setKind] = useState("video");   // video | mp3
  const [res, setRes] = useState(null);
  const [kbps, setKbps] = useState(192);
  const [clipOn, setClipOn] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [startedAt, setStartedAt] = useState(0);

  const lookup = async () => {
    const u = url.trim();
    if (!u) return;
    setLoading(true); setError(""); setInfo(null); setStartedAt(0);
    try {
      const r = await fetch(`/api/yt/info?url=${encodeURIComponent(u)}`);
      const isJson = (r.headers.get("content-type") || "").includes("application/json");
      if (!isJson) throw new Error("The downloader server isn't reachable right now. Please try again later.");
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Lookup failed (${r.status})`);
      setInfo({ ...data, url: u });
      const def = data.video.find((v) => v.res <= 1080) || data.video[0];
      setRes(def?.res ?? null);
      setKind(data.video.length ? "video" : "mp3");
      setClipOn(false); setStart(""); setEnd("");
    } catch (e) {
      setError(e?.message || "Lookup failed.");
    } finally {
      setLoading(false);
    }
  };

  // Clip validation
  const clip = useMemo(() => {
    if (!clipOn || !info) return { ok: true, s: null, e: null };
    const s = parseTime(start), e = parseTime(end);
    if (Number.isNaN(s) || Number.isNaN(e)) return { ok: false, msg: "Use times like 1:30 or 01:02:03." };
    if (s == null && e == null) return { ok: false, msg: "Enter a start and/or end time." };
    if (s != null && info.duration && s >= info.duration) return { ok: false, msg: `Start is past the end (${fmtDuration(info.duration)}).` };
    if (s != null && e != null && e <= s) return { ok: false, msg: "End must be after start." };
    return { ok: true, s, e: e != null && info.duration ? Math.min(e, info.duration) : e };
  }, [clipOn, start, end, info]);

  const segLen = info ? ((clip.e ?? info.duration) - (clip.s ?? 0)) : 0;
  const ratio = info?.duration ? Math.max(0, Math.min(1, segLen / info.duration)) : 1;
  const selVideo = info?.video.find((v) => v.res === res);
  const estSize = !info ? 0
    : kind === "mp3" ? (kbps * 1000 / 8) * segLen
    : (selVideo?.size || 0) * ratio;
  // Server function runs up to ~5 min; big 4K files may not finish in one go.
  const heavy = kind === "video" && estSize > 1.5e9;

  const download = () => {
    if (!info || !clip.ok) return;
    const p = new URLSearchParams({ url: info.url, type: kind, ui: "1" });
    if (kind === "video" && res) p.set("res", String(res));
    if (kind === "mp3") p.set("kbps", String(kbps));
    if (clipOn && clip.s != null) p.set("start", String(clip.s));
    if (clipOn && clip.e != null) p.set("end", String(clip.e));
    window.open(`/api/yt/download?${p}`, "_blank", "noopener");
    setStartedAt(Date.now());
  };

  return (
    <div className="fade-in" style={{ maxWidth: 860, margin: "0 auto", paddingBottom: 48 }}>
      <ToolHeader icon="📥" title="YT Downloader" subtitle="Download YouTube videos up to 4K, MP3 audio, or just a part of a video." onBack={onBack} />

      <div style={panel}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") lookup(); }}
            placeholder="Paste a YouTube link — video, Shorts or youtu.be"
            style={{ ...inputStyle, flex: "1 1 360px" }}
          />
          <button type="button" onClick={lookup} disabled={!url.trim() || loading} style={btnPrimary(!!url.trim() && !loading)}>
            {loading ? "Fetching…" : "Get video"}
          </button>
        </div>
        {loading && <p style={{ fontSize: 12, color: TT.textDim, marginTop: 10 }}>Reading the video's formats — this takes 5–20 seconds.</p>}
        {error && <p style={{ marginTop: 12, fontSize: 13, color: TT.redLight }}>⚠️ {error}</p>}
        <p style={{ fontSize: 11, color: TT.textDim, marginTop: 10, lineHeight: 1.5 }}>
          Only download videos you own or have permission to use (e.g. our own channel content).
        </p>
      </div>

      {info && (
        <div className="pop-in" style={{ ...panel, marginTop: 16 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
            {info.thumbnail && <img src={info.thumbnail} alt="" style={{ width: 220, maxWidth: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 12, border: `1px solid ${TT.border}` }} />}
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <p style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.35 }}>{info.title}</p>
              <p style={{ fontSize: 13, color: TT.textDim, marginTop: 6 }}>{info.author}{info.duration ? ` · ${fmtDuration(info.duration)}` : ""}</p>
            </div>
          </div>

          {/* Type */}
          <p style={label}>Download as</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
            <button type="button" disabled={!info.video.length} onClick={() => setKind("video")} style={{ ...chip(kind === "video"), opacity: info.video.length ? 1 : 0.4 }}>
              <div style={{ fontWeight: 800 }}>🎬 Video (MP4)</div>
              <div style={{ fontSize: 11, color: TT.textDim, marginTop: 2 }}>Up to {info.video[0]?.label || "—"}</div>
            </button>
            <button type="button" disabled={!info.audio} onClick={() => setKind("mp3")} style={{ ...chip(kind === "mp3"), opacity: info.audio ? 1 : 0.4 }}>
              <div style={{ fontWeight: 800 }}>🎵 Audio (MP3)</div>
              <div style={{ fontSize: 11, color: TT.textDim, marginTop: 2 }}>128 – 320 kbps</div>
            </button>
          </div>

          {/* Quality */}
          <p style={label}>Quality</p>
          {kind === "video" ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 8, marginBottom: 20 }}>
              {info.video.map((v) => (
                <button key={v.res} type="button" onClick={() => setRes(v.res)} style={chip(v.res === res)}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontWeight: 800 }}>{v.label}</span>
                    {v.badge && <span style={{ fontSize: 9, fontWeight: 800, padding: "1px 6px", borderRadius: 10, background: TT.redTint, color: TT.redLight, border: `1px solid ${TT.borderHot}` }}>{v.badge}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: TT.textDim, marginTop: 3 }}>{v.size ? `~${fmtBytes(v.size)}` : "size unknown"}</div>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 20 }}>
              {MP3_RATES.map((k) => (
                <button key={k} type="button" onClick={() => setKbps(k)} style={chip(k === kbps)}>
                  <div style={{ fontWeight: 800 }}>{k} kbps</div>
                  <div style={{ fontSize: 11, color: TT.textDim, marginTop: 3 }}>{k === 128 ? "Small" : k === 192 ? "Recommended" : "Best"}</div>
                </button>
              ))}
            </div>
          )}

          {/* Segment */}
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: clipOn ? 12 : 20 }}>
            <input type="checkbox" checked={clipOn} onChange={(e) => setClipOn(e.target.checked)} style={{ width: 16, height: 16, accentColor: TT.red }} />
            <span style={{ fontSize: 14, fontWeight: 700 }}>✂️ Download only a part (start → end)</span>
          </label>
          {clipOn && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="Start e.g. 1:30" style={{ ...inputStyle, width: 170 }} />
                <span style={{ color: TT.textDim }}>→</span>
                <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder={`End e.g. ${fmtDuration(Math.min(info.duration || 150, 150))}`} style={{ ...inputStyle, width: 170 }} />
                {clip.ok && (clip.s != null || clip.e != null) && <span style={{ fontSize: 12, color: TT.textMute }}>Length: {fmtDuration(segLen)}</span>}
              </div>
              {!clip.ok && <p style={{ fontSize: 12, color: TT.amber, marginTop: 8 }}>⚠️ {clip.msg}</p>}
              <p style={{ fontSize: 11, color: TT.textDim, marginTop: 8 }}>
                Leave start empty to begin at 0:00, or end empty to go to the end.{kind === "video" ? " Video cuts start at the nearest keyframe (within ~1–2 s)." : ""}
              </p>
            </div>
          )}

          {heavy && (
            <p style={{ fontSize: 12, color: TT.amber, marginBottom: 14, lineHeight: 1.5 }}>
              ⚠️ This is a very large file (~{fmtBytes(estSize)}). The server can stream for about 5 minutes per download, so it may stop early.
              For long videos, pick a lower quality or use “Download only a part”.
            </p>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <button type="button" onClick={download} disabled={!clip.ok || (kind === "video" && !res)} style={btnPrimary(clip.ok && (kind === "mp3" || !!res))}>
              ⬇ Download {kind === "mp3" ? `MP3 · ${kbps} kbps` : selVideo ? `${selVideo.label} MP4` : "video"}{clipOn && clip.ok && (clip.s != null || clip.e != null) ? " (part)" : ""}
            </button>
            {clip.ok && estSize > 0 && <span style={{ fontSize: 12, color: TT.textDim }}>~{fmtBytes(estSize)}</span>}
          </div>
          {startedAt > 0 && (
            <p style={{ fontSize: 12, color: TT.green, marginTop: 12, lineHeight: 1.5 }}>
              ✓ Download started in a new tab. It takes 10–30 seconds to begin, then saves to your Downloads folder.
              If something goes wrong, that tab shows the reason.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
