// GET /api/yt/info?url=<youtube link>
// Returns the title, thumbnail, length and the downloadable formats.
import { yt, readVideoId, usableFormats, friendlyError } from "./_shared.js";

export const config = { runtime: "nodejs", maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const id = readVideoId(req);
  if (!id) return res.status(400).json({ error: "Please paste a valid YouTube link." });
  try {
    const info = await yt.getInfo(id);
    const d = info.videoDetails || {};
    const thumbs = d.thumbnails || [];
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      id: d.id,
      title: d.title,
      author: d.author?.name || "",
      lengthSeconds: Number(d.lengthSeconds) || 0,
      thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null,
      isLive: !!d.isLive,
      formats: d.isLive ? [] : usableFormats(info),
    });
  } catch (e) {
    console.error("[yt/info]", e?.code || "", e?.message);
    return res.status(502).json({ error: friendlyError(e) });
  }
}
