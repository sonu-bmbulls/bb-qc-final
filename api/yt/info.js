// GET /api/yt/info?url=<youtube link>
// Title, thumbnail, duration + every video quality (up to 4K/8K) and MP3 option.
import { getInfo, readParams, validUrl, videoChoices, bestAudio, friendlyError } from "./_shared.js";

export const config = { runtime: "nodejs", maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const url = validUrl(readParams(req).url);
  if (!url) return res.status(400).json({ error: "Please paste a valid YouTube link." });
  try {
    const info = await getInfo(url, 50000);
    if (info.is_live || info.live_status === "is_live" || info.live_status === "is_upcoming") {
      return res.status(400).json({ error: "Live streams / premieres can't be downloaded." });
    }
    const audio = bestAudio(info);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      id: info.id,
      title: info.title,
      author: info.uploader || info.channel || "",
      duration: info.duration || 0,
      thumbnail: info.thumbnail || null,
      video: videoChoices(info).map(({ _f, ...v }) => v),
      audio: audio ? { abr: Math.round(audio.abr || audio.tbr || 0), size: audio.filesize || audio.filesize_approx || 0 } : null,
    });
  } catch (e) {
    console.error("[yt/info]", e?.message);
    return res.status(502).json({ error: friendlyError(e) });
  }
}
