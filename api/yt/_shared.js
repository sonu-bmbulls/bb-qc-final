// Shared helpers for the YT Downloader serverless functions (yt-dlp + ffmpeg).
// Files starting with "_" are not exposed as routes by Vercel.
//
// Binaries:
//   yt-dlp → bin/yt-dlp (downloaded at build by scripts/fetch-ytdlp.mjs) | YTDLP_PATH | "yt-dlp" on PATH
//   ffmpeg → ffmpeg-static npm package | FFMPEG_PATH
// Optional env:
//   YT_COOKIES → Netscape cookies.txt contents (raw or base64) of a YouTube
//                account, used when YouTube bot-checks the server.
import { spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, chmodSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

const TMP = "/tmp";

// Vercel may drop the executable bit on bundled files — copy to /tmp + chmod if needed.
function executable(p, name) {
  if (!p || !existsSync(p)) return null;
  try { accessSync(p, constants.X_OK); return p; } catch { /* not executable */ }
  const dst = path.join(TMP, name);
  if (!existsSync(dst)) { copyFileSync(p, dst); chmodSync(dst, 0o755); }
  return dst;
}

let _bins = null;
export function bins() {
  if (_bins) return _bins;
  const ytdlp = executable(process.env.YTDLP_PATH, "yt-dlp")
    || executable(path.join(process.cwd(), "bin", "yt-dlp"), "yt-dlp")
    || "yt-dlp";
  const ffmpeg = executable(process.env.FFMPEG_PATH, "ffmpeg")
    || executable(ffmpegStatic, "ffmpeg")
    || "ffmpeg";
  _bins = { ytdlp, ffmpeg };
  return _bins;
}

function cookiesArgs() {
  const raw = process.env.YT_COOKIES;
  if (!raw) return [];
  const file = path.join(TMP, "yt-cookies.txt");
  if (!existsSync(file)) {
    const txt = /^\s*#|\t/.test(raw) ? raw : Buffer.from(raw, "base64").toString("utf8");
    writeFileSync(file, txt);
  }
  return ["--cookies", file];
}

const SPAWN_ENV = { ...process.env, HOME: TMP, XDG_CACHE_HOME: TMP, TMPDIR: TMP };

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: SPAWN_ENV });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timed out")); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split("\n").filter((l) => /ERROR/.test(l)).pop() || err.trim().slice(-400) || `exit ${code}`));
    });
  });
}

// Different YouTube clients get blocked at different times — try a few.
const CLIENT_ATTEMPTS = [
  [],
  ["--extractor-args", "youtube:player_client=tv,web_safari"],
  ["--extractor-args", "youtube:player_client=mweb,android_vr"],
];

export async function getInfo(url, budgetMs = 45000) {
  const { ytdlp } = bins();
  const base = [
    "-J", "--no-playlist", "--no-warnings", "--no-progress", "--no-cache-dir",
    "--socket-timeout", "15",
    "--js-runtimes", `node:${process.execPath}`,
    ...cookiesArgs(),
  ];
  const deadline = Date.now() + budgetMs;
  let lastErr;
  for (const extra of CLIENT_ATTEMPTS) {
    const left = deadline - Date.now();
    if (left < 5000) break;
    try {
      const json = await run(ytdlp, [...base, ...extra, "--", url], Math.min(left, 30000));
      return JSON.parse(json);
    } catch (e) {
      lastErr = e;
      // Only retry with another client for blocks / format problems.
      if (!/sign in|bot|confirm|403|format|player|unavailable|timed out/i.test(e.message)) break;
    }
  }
  throw lastErr || new Error("Lookup failed");
}

// ── URL / input helpers ─────────────────────────────────────────────────────
const YT_RE = /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com\/(watch\?|shorts\/|live\/|embed\/)|youtu\.be\/)[\w\-?=&#%./]+$/i;
export function readParams(req) {
  return req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
}
export function validUrl(u) {
  u = String(u || "").trim();
  return u.length < 500 && YT_RE.test(u) ? u : null;
}
// "90", "1:30", "01:02:03", "1:30.5" → seconds (or null)
export function parseTime(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const parts = String(v).trim().split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((s, p) => s * 60 + Number(p), 0);
}

// ── Format selection ────────────────────────────────────────────────────────
const OK_PROTO = new Set(["https", "http", "m3u8", "m3u8_native"]);
const usable = (f) => f.url && OK_PROTO.has(f.protocol) && !f.has_drm && f.ext !== "mhtml";
const isVideoOnly = (f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none");
const isAudioOnly = (f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none");
const isMuxed = (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none";
const shortSide = (f) => Math.min(f.width || f.height || 0, f.height || f.width || 0);
const codecRank = (vc = "") => (vc.startsWith("avc1") ? 3 : vc.startsWith("vp09") || vc.startsWith("vp9") ? 2 : vc.startsWith("av01") ? 1 : 0);
const sizeOf = (f, dur) => f.filesize || f.filesize_approx || (f.tbr && dur ? Math.round((f.tbr * 1000 / 8) * dur) : 0);

export function bestAudio(info) {
  const auds = (info.formats || []).filter((f) => usable(f) && isAudioOnly(f) && !/drc/i.test(f.format_id || "") && (f.language_preference ?? 0) >= -1);
  const pick = (list) => list.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  return pick(auds.filter((f) => f.ext === "m4a" || /mp4a/.test(f.acodec || ""))) || pick(auds) || null;
}

// For each resolution: best video stream (prefers H.264 for compatibility, then higher fps/bitrate).
export function videoChoices(info) {
  const dur = info.duration || 0;
  const byRes = new Map();
  for (const f of info.formats || []) {
    if (!usable(f) || !(isVideoOnly(f) || isMuxed(f))) continue;
    const res = shortSide(f);
    if (!res || res < 144) continue;
    const cur = byRes.get(res);
    const score = (x) => [codecRank(x.vcodec), x.fps || 0, x.protocol.startsWith("http") ? 1 : 0, x.tbr || 0];
    if (!cur || cmp(score(f), score(cur)) > 0) byRes.set(res, f);
  }
  const audio = bestAudio(info);
  return [...byRes.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([res, f]) => ({
      res,
      label: `${res}p${f.fps > 30 ? Math.round(f.fps) : ""}`,
      badge: res >= 2160 ? "4K" : res >= 1440 ? "2K" : res >= 1080 ? "HD" : "",
      codec: (f.vcodec || "").split(".")[0],
      size: sizeOf(f, dur) + (isMuxed(f) ? 0 : sizeOf(audio || {}, dur)),
      _f: f,
    }));
}
function cmp(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

export function headersArg(f) {
  const h = f?.http_headers || {};
  const s = Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  return s ? ["-headers", s + "\r\n"] : [];
}

// ── Errors / names ──────────────────────────────────────────────────────────
export function friendlyError(e) {
  const m = String(e?.message || e || "");
  if (/sign in to confirm|not a bot|bot/i.test(m)) return "YouTube blocked the server this time (bot check). Please try again in a minute.";
  if (/private video/i.test(m)) return "This video is private.";
  if (/age|inappropriate/i.test(m)) return "This video is age-restricted and can't be downloaded.";
  if (/members/i.test(m)) return "This video is for channel members only.";
  if (/unavailable|removed|does not exist|not found/i.test(m)) return "This video is unavailable.";
  if (/live event|is live|premieres/i.test(m)) return "Live streams / premieres can't be downloaded.";
  if (/timed out/i.test(m)) return "YouTube took too long to respond. Please try again.";
  if (/ENOENT/.test(m)) return "Downloader is not installed on the server (yt-dlp / ffmpeg missing).";
  return m.replace(/^ERROR:\s*/, "").slice(0, 220) || "Something went wrong.";
}

export function safeFileName(s) {
  return (String(s || "video").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim() || "video").slice(0, 110);
}

export function fmtStamp(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}h` : "") + `${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
}
