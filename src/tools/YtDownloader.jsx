import { useState } from "react";
import { TT, ToolHeader, btnPrimary, inputStyle, panel, fmtBytes, fmtDuration } from "./theme.jsx";

// YT Downloader — paste a link, pick a format, download.
// Server side: api/yt/info.js (lookup) + api/yt/download.js (stream).
export default function YtDownloader({ onBack }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState(null);

  const lookup = async () => {
    const u = url.trim();
    if (!u) return;
    setLoading(true); setError(""); setInfo(null);
    try {
      const r = await fetch(`/api/yt/info?url=${encodeURIComponent(u)}`);
      const isJson = (r.headers.get("content-type") || "").includes("application/json");
      if (!isJson) throw new Error("The downloader server isn't reachable right now. Please try again later.");
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Lookup failed (${r.status})`);
      if (!data.formats?.length) throw new Error("No downloadable formats found for this video.");
      setInfo({ ...data, url: u });
    } catch (e) {
      setError(e?.message || "Lookup failed.");
    } finally {
      setLoading(false);
    }
  };

  const dlHref = (itag) => `/api/yt/download?url=${encodeURIComponent(info.url)}&itag=${itag}`;
  const videos = info?.formats.filter((f) => f.kind === "video") || [];
  const audios = info?.formats.filter((f) => f.kind === "audio") || [];

  return (
    <div className="fade-in" style={{ maxWidth: 820, margin: "0 auto", paddingBottom: 48 }}>
      <ToolHeader icon="📥" title="YT Downloader" subtitle="Paste a YouTube link to download the video or its audio." onBack={onBack} />

      <div style={panel}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") lookup(); }}
            placeholder="https://www.youtube.com/watch?v=…"
            style={{ ...inputStyle, flex: "1 1 360px" }}
          />
          <button type="button" onClick={lookup} disabled={!url.trim() || loading} style={btnPrimary(!!url.trim() && !loading)}>
            {loading ? "Fetching…" : "Get video"}
          </button>
        </div>
        <p style={{ fontSize: 11, color: TT.textDim, marginTop: 10, lineHeight: 1.5 }}>
          Only download videos you own or have permission to use (e.g. our own channel content).
        </p>
        {error && <p style={{ marginTop: 12, fontSize: 13, color: TT.redLight }}>⚠️ {error}</p>}
      </div>

      {info && (
        <div className="pop-in" style={{ ...panel, marginTop: 16 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {info.thumbnail && (
              <img src={info.thumbnail} alt="" style={{ width: 240, maxWidth: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 12, border: `1px solid ${TT.border}` }} />
            )}
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <p style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.35 }}>{info.title}</p>
              <p style={{ fontSize: 13, color: TT.textDim, marginTop: 6 }}>
                {info.author}{info.lengthSeconds ? ` · ${fmtDuration(info.lengthSeconds)}` : ""}
              </p>
            </div>
          </div>

          <FormatList title="Video (with sound)" items={videos} href={dlHref} />
          <FormatList title="Audio only" items={audios} href={dlHref} />

          <p style={{ fontSize: 11, color: TT.textDim, marginTop: 16, lineHeight: 1.5 }}>
            YouTube only provides a single file with picture + sound up to 360p. Need an MP3? Download the audio,
            then run it through the MP3 Converter.
          </p>
        </div>
      )}
    </div>
  );
}

function FormatList({ title, items, href }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <p style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: TT.textMute, marginBottom: 10 }}>{title}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((f) => (
          <div key={f.itag} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 14px", borderRadius: 12, background: "rgba(255,255,255,0.03)", border: `1px solid ${TT.border}` }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{f.label}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 11, color: TT.textDim, fontFamily: "DM Mono, monospace" }}>{fmtBytes(f.size)}</span>
              <a href={href(f.itag)} style={{ padding: "7px 14px", borderRadius: 9, background: TT.gradient, color: "white", fontSize: 12, fontWeight: 800, textDecoration: "none" }}>⬇ Download</a>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
