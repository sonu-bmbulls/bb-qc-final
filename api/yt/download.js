// GET /api/yt/download?url=<link>&type=video|mp3&res=<1080|2160…>&kbps=<128|192|320>&start=<1:30>&end=<2:10>&ui=1
//
// yt-dlp resolves the stream URLs, then ffmpeg pulls them straight from YouTube
// and streams the result to the browser — no temp files, so 4K works within the
// function's memory/disk limits:
//   video → best video at that resolution + best audio, remuxed (no re-encode) to fragmented MP4
//   mp3   → best audio, encoded to MP3 at the chosen bitrate
//   start/end (optional) → only that part of the video (video cuts land on the nearest keyframe)
import { spawn } from "node:child_process";
import {
  bins, getInfo, readParams, validUrl, parseTime, videoChoices, bestAudio, headersArg,
  friendlyError, safeFileName, fmtStamp,
} from "./_shared.js";

export const config = { runtime: "nodejs", maxDuration: 300 };

function fail(res, wantHtml, status, msg) {
  if (wantHtml) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const safe = String(msg).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
    return res.end(`<!doctype html><meta charset="utf-8"><title>Download failed</title><body style="background:#0a0608;color:#fff;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:460px;text-align:center;padding:24px"><div style="font-size:40px">⚠️</div><h2>Download failed</h2><p style="color:#fca5a5">${safe}</p><p style="color:#888;font-size:13px">Close this tab and try again.</p></div>`);
  }
  return res.status(status).json({ error: msg });
}

export default async function handler(req, res) {
  const q = readParams(req);
  const ui = q.ui === "1";
  if (req.method !== "GET") return fail(res, ui, 405, "Method not allowed");
  const url = validUrl(q.url);
  if (!url) return fail(res, ui, 400, "Please paste a valid YouTube link.");
  const type = q.type === "mp3" ? "mp3" : "video";
  const kbps = [128, 192, 256, 320].includes(Number(q.kbps)) ? Number(q.kbps) : 192;
  const start = parseTime(q.start);
  const end = parseTime(q.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return fail(res, ui, 400, "Start / end time must look like 1:30 or 01:02:03.");
  if (start != null && end != null && end <= start) return fail(res, ui, 400, "End time must be after start time.");

  let info;
  try {
    info = await getInfo(url, 60000);
  } catch (e) {
    console.error("[yt/download] info", e?.message);
    return fail(res, ui, 502, friendlyError(e));
  }
  const duration = info.duration || 0;
  if (start != null && duration && start >= duration) return fail(res, ui, 400, "Start time is past the end of the video.");
  const clipStart = start || 0;
  const clipEnd = end != null && duration ? Math.min(end, duration) : end;
  const clipDur = clipEnd != null ? clipEnd - clipStart : null;
  const isClip = start != null || end != null;

  const audio = bestAudio(info);
  const inputs = [];
  const maps = [];
  let outArgs, ext, mime, suffix;

  const addInput = (f) => {
    inputs.push(
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "5",
      ...headersArg(f),
      ...(clipStart ? ["-ss", String(clipStart)] : []),
      "-i", f.url,
    );
  };

  if (type === "mp3") {
    if (!audio) return fail(res, ui, 404, "This video has no audio track.");
    addInput(audio);
    maps.push("-map", "0:a:0");
    outArgs = ["-vn", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-metadata", `title=${info.title || ""}`, "-metadata", `artist=${info.uploader || ""}`, "-f", "mp3"];
    ext = "mp3"; mime = "audio/mpeg"; suffix = "";
  } else {
    const choices = videoChoices(info);
    if (!choices.length) return fail(res, ui, 404, "No downloadable video found.");
    const want = Number(q.res) || choices[0].res;
    const choice = choices.find((c) => c.res === want) || choices.find((c) => c.res < want) || choices[choices.length - 1];
    const v = choice._f;
    addInput(v);
    const muxed = v.acodec && v.acodec !== "none";
    if (muxed || !audio) {
      maps.push("-map", "0:v:0", "-map", "0:a:0?");
    } else {
      addInput(audio);
      maps.push("-map", "0:v:0", "-map", "1:a:0");
    }
    outArgs = ["-c", "copy", "-movflags", "frag_keyframe+empty_moov+default_base_moof+delay_moov", "-f", "mp4"];
    ext = "mp4"; mime = "video/mp4"; suffix = `_${choice.label}`;
  }

  const clipTag = isClip ? `_${fmtStamp(clipStart)}-${clipEnd != null ? fmtStamp(clipEnd) : "end"}` : "";
  const name = `${safeFileName(info.title)}${suffix}${clipTag}.${ext}`;
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...inputs,
    ...maps,
    ...(clipDur ? ["-t", String(clipDur)] : []),
    ...outArgs,
    "pipe:1",
  ];

  const ff = spawn(bins().ffmpeg, args, { env: { ...process.env, HOME: "/tmp" } });
  let started = false;
  let errTail = "";
  ff.stderr.on("data", (d) => { errTail = (errTail + d).slice(-2000); });

  ff.stdout.once("data", (first) => {
    started = true;
    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(first);
    ff.stdout.pipe(res);
  });

  ff.on("error", (e) => {
    console.error("[yt/download] spawn", e?.message);
    if (!started) fail(res, ui, 500, friendlyError(e)); else res.destroy(e);
  });
  ff.on("close", (code) => {
    if (code !== 0) console.error("[yt/download] ffmpeg exit", code, errTail);
    if (!started) fail(res, ui, 502, code === 0 ? "Nothing to download." : `Download failed: ${errTail.trim().split("\n").pop() || "ffmpeg error"}`);
  });
  res.on("close", () => { if (!res.writableEnded) ff.kill("SIGKILL"); });
}
