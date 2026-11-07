// GET /api/yt/download?url=<link>&type=video|mp3&res=<1080|2160…>&kbps=<128|192|320>&start=<1:30>&end=<2:10>&ui=1
//
// 1. yt-dlp extracts the video once (-J) → info saved to /tmp
// 2. yt-dlp downloads the chosen stream(s) from that info (--load-info-json,
//    chunked requests YouTube accepts) straight to a pipe
// 3. ffmpeg reads the pipe(s) and streams the result to the browser — no temp media files:
//      video → best video at that resolution + best audio, remuxed (no re-encode) to fragmented MP4
//      mp3   → best audio encoded to MP3 at the chosen bitrate
//      start/end (optional) → only that part (video cuts land on the nearest keyframe)
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  bins, getInfo, commonArgs, readParams, validUrl, parseTime, videoChoices, bestAudio,
  friendlyError, safeFileName, fmtStamp, SPAWN_ENV_EXPORT as SPAWN_ENV,
} from "./_shared.js";

export const config = { runtime: "nodejs", maxDuration: 300 };

function fail(res, wantHtml, status, msg) {
  if (res.headersSent) return res.destroy();
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

  // Pick the streams.
  const audio = bestAudio(info);
  const streams = [];          // formats to pull, in ffmpeg input order (pipe:3, pipe:4)
  let maps, outArgs, ext, mime, suffix;
  if (type === "mp3") {
    if (!audio) return fail(res, ui, 404, "This video has no audio track.");
    streams.push(audio);
    maps = ["-map", "0:a:0"];
    outArgs = ["-vn", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-metadata", `title=${info.title || ""}`, "-metadata", `artist=${info.uploader || ""}`, "-f", "mp3"];
    ext = "mp3"; mime = "audio/mpeg"; suffix = "";
  } else {
    const choices = videoChoices(info);
    if (!choices.length) return fail(res, ui, 404, "No downloadable video found.");
    const want = Number(q.res) || choices[0].res;
    const choice = choices.find((c) => c.res === want) || choices.find((c) => c.res < want) || choices[choices.length - 1];
    const v = choice._f;
    streams.push(v);
    if ((v.acodec && v.acodec !== "none") || !audio) {
      maps = ["-map", "0:v:0", "-map", "0:a:0?"];
    } else {
      streams.push(audio);
      maps = ["-map", "0:v:0", "-map", "1:a:0"];
    }
    outArgs = ["-c", "copy", "-movflags", "frag_keyframe+empty_moov+default_base_moof+delay_moov", "-f", "mp4"];
    ext = "mp4"; mime = "video/mp4"; suffix = `_${choice.label}`;
  }

  // Save the extracted info so the download step doesn't hit YouTube's page again.
  const infoPath = `/tmp/yt-${randomBytes(6).toString("hex")}.info.json`;
  writeFileSync(infoPath, JSON.stringify(info));
  const cleanup = () => { try { unlinkSync(infoPath); } catch { /* gone */ } };

  const { ytdlp, ffmpeg } = bins();
  const procs = [];
  const killAll = () => { for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* dead */ } } cleanup(); };

  const inputs = [];
  streams.forEach((f, i) => {
    inputs.push(...(clipStart ? ["-ss", String(clipStart)] : []), "-i", `pipe:${3 + i}`);
  });

  const clipTag = isClip ? `_${fmtStamp(clipStart)}-${clipEnd != null ? fmtStamp(clipEnd) : "end"}` : "";
  const name = `${safeFileName(info.title)}${suffix}${clipTag}.${ext}`;
  const ff = spawn(ffmpeg, [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...inputs, ...maps,
    ...(clipDur ? ["-t", String(clipDur)] : []),
    ...outArgs, "pipe:1",
  ], { env: SPAWN_ENV, stdio: ["ignore", "pipe", "pipe", ...streams.map(() => "pipe")] });
  procs.push(ff);

  let errTail = "";
  const note = (who) => (d) => { errTail = (errTail + `[${who}] ` + d).slice(-2500); };
  ff.stderr.on("data", note("ffmpeg"));

  // One yt-dlp per stream, writing into ffmpeg's extra pipes.
  streams.forEach((f, i) => {
    const dl = spawn(ytdlp, [
      "--load-info-json", infoPath, "-f", String(f.format_id),
      "-o", "-", "--no-part", "--quiet", "--http-chunk-size", "10M",
      ...commonArgs(),
    ], { env: SPAWN_ENV, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(dl);
    dl.stderr.on("data", note("yt-dlp"));
    const sink = ff.stdio[3 + i];
    sink.on("error", () => { /* ffmpeg stopped reading (e.g. clip end reached) */ });
    dl.stdout.pipe(sink);
    dl.on("close", (code) => { if (code && code !== 0 && code !== null) console.error("[yt/download] yt-dlp exit", code); });
  });

  let started = false;
  // Diagnostics: ?dryrun=1 runs the whole pipeline but only reports bytes/time.
  if (q.dryrun === "1") {
    const t0 = Date.now();
    let bytes = 0;
    ff.stdout.on("data", (d) => { bytes += d.length; });
    ff.on("close", (code) => {
      res.status(200).json({ ok: code === 0, code, bytes, seconds: (Date.now() - t0) / 1000, name, formats: streams.map((f) => f.format_id), err: code ? errTail.slice(-400) : undefined });
    });
    res.on("close", () => { if (!res.writableEnded) killAll(); });
    return;
  }
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
    killAll();
    if (!started) fail(res, ui, 500, friendlyError(e)); else res.destroy(e);
  });
  ff.on("close", (code) => {
    // ffmpeg is done (or hit the clip end) — stop any downloads still running.
    killAll();
    if (code !== 0) console.error("[yt/download] ffmpeg exit", code, errTail);
    if (!started && q.dryrun !== "1") {
      const line = errTail.trim().split("\n").filter(Boolean).pop() || "";
      fail(res, ui, 502, code === 0 ? "Nothing to download." : /403|forbidden/i.test(errTail) ? "YouTube refused the download this time. Please try again." : `Download failed: ${line.slice(0, 200) || "ffmpeg error"}`);
    }
  });
  res.on("close", () => { if (!res.writableEnded) killAll(); });
}
