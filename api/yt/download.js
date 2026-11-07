// GET /api/yt/download?url=<youtube link>&itag=<format id>
// Streams the chosen format back to the browser as a file download.
import { yt, readVideoId, usableFormats, findFormat, friendlyError, safeFileName } from "./_shared.js";

export const config = { runtime: "nodejs", maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const id = readVideoId(req);
  const itag = Number((req.query || {}).itag);
  if (!id) return res.status(400).json({ error: "Please paste a valid YouTube link." });
  if (!itag) return res.status(400).json({ error: "Missing format." });

  let info;
  try {
    info = await yt.getInfo(id);
  } catch (e) {
    console.error("[yt/download] info", e?.code || "", e?.message);
    return res.status(502).json({ error: friendlyError(e) });
  }

  const pick = usableFormats(info).find((f) => f.itag === itag);
  const format = pick && findFormat(info, itag);
  if (!format) return res.status(400).json({ error: "That format isn't available for this video." });

  const name = `${safeFileName(info.videoDetails?.title)}.${pick.container}`;
  const type = pick.kind === "video" ? "video/mp4" : pick.container === "m4a" ? "audio/mp4" : "audio/webm";

  let stream;
  try {
    stream = yt.download(info, { format });
  } catch (e) {
    console.error("[yt/download] start", e?.code || "", e?.message);
    return res.status(502).json({ error: friendlyError(e) });
  }

  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (format.contentLength) res.setHeader("Content-Length", String(format.contentLength));
  res.setHeader("Cache-Control", "no-store");

  stream.on("error", (e) => {
    console.error("[yt/download] stream", e?.code || "", e?.message);
    if (!res.headersSent) {
      res.removeHeader("Content-Length");
      res.removeHeader("Content-Disposition");
      res.status(502).json({ error: friendlyError(e) });
    } else {
      res.destroy(e);
    }
  });
  res.on("close", () => { if (!res.writableEnded) stream.destroy(); });
  stream.pipe(res);
}
