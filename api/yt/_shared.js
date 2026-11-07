// Shared helpers for the YT Downloader serverless functions.
// (Files starting with "_" are not exposed as routes by Vercel.)
// Uses @distube/ytdl-core v5 (needs Node 22.22.2+ / 24.15+; Vercel project runs 24.x).
import { Ytdl, YtdlError, parseVideoId } from "@distube/ytdl-core";

// One instance per warm function: it caches the solved player script.
export const yt = new Ytdl();

// Returns the 11-char video id for a valid YouTube link, else null.
export function readVideoId(req) {
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  const raw = String(q.url || "").trim();
  if (!raw || raw.length > 500) return null;
  try { return parseVideoId(raw) || null; } catch { return null; }
}

// Formats a user can download as ONE file:
//  • "video" = progressive MP4 with picture + sound (YouTube serves these up to ~360p)
//  • "audio" = audio-only streams (m4a / webm)
export function usableFormats(info) {
  const out = [];
  for (const f of info.formats || []) {
    if (f.isDrm || f.isOtf || f.isHLS || f.isLive || f.isDrc) continue;
    const size = Number(f.contentLength) || null;
    if (f.hasVideo && f.hasAudio && f.container === "mp4") {
      out.push({ itag: f.itag, kind: "video", label: `${f.qualityLabel || "Video"} MP4 (video + audio)`, container: "mp4", size, rank: f.height || 0 });
    } else if (!f.hasVideo && f.hasAudio) {
      const ext = f.container === "mp4" ? "m4a" : f.container || "webm";
      const kbps = f.audioBitrate ? ` ${f.audioBitrate} kbps` : "";
      out.push({ itag: f.itag, kind: "audio", label: `Audio${kbps} (${ext.toUpperCase()})`, container: ext, size, rank: f.audioBitrate || 0 });
    }
  }
  const seen = new Set();
  return out
    .filter((f) => (seen.has(f.itag) ? false : (seen.add(f.itag), true)))
    .sort((a, b) => (a.kind === b.kind ? b.rank - a.rank : a.kind === "video" ? -1 : 1))
    .map(({ rank, ...f }) => f);
}

// Find the exact format object for an itag (first, non-DRC, original track).
export function findFormat(info, itag) {
  return (info.formats || []).find((f) => f.itag === itag && !f.isDrc && !f.isDrm && !f.isOtf) || null;
}

const MESSAGES = {
  INVALID_URL: "Please paste a valid YouTube link.",
  NOT_FOUND: "This video doesn't exist or was removed.",
  PRIVATE: "This video is private.",
  AGE_RESTRICTED: "This video is age-restricted and can't be downloaded.",
  MEMBERS_ONLY: "This video is for channel members only.",
  PREMIUM_ONLY: "This video needs YouTube Premium.",
  REGION_BLOCKED: "This video isn't available in the server's region.",
  NOT_STARTED: "This premiere / live stream hasn't started yet.",
  BOT_CHECK: "YouTube blocked this server request (bot check). Try again in a few minutes.",
  RATE_LIMITED: "YouTube is rate-limiting the server. Try again in a few minutes.",
  NO_FORMAT: "No downloadable format found for this video.",
};

export function friendlyError(e) {
  if (YtdlError.is?.(e) && MESSAGES[e.code]) return MESSAGES[e.code];
  const m = String(e?.message || e || "");
  return m.slice(0, 200) || "Something went wrong.";
}

export function safeFileName(s) {
  return (String(s || "video").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim() || "video").slice(0, 120);
}
