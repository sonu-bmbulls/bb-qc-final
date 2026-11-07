// Downloads the standalone yt-dlp Linux binary into bin/yt-dlp at build time
// (Vercel build). The YT Downloader functions bundle it via vercel.json
// "includeFiles". Skipped on non-Linux machines (local Windows/Mac dev uses a
// yt-dlp from PATH or YTDLP_PATH instead) and when the binary already exists.
import { createWriteStream, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const OUT = "bin/yt-dlp";
const URL_ = process.env.YTDLP_DOWNLOAD_URL || "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

if (process.platform !== "linux" && !process.env.FORCE_YTDLP_FETCH) {
  console.log("[fetch-ytdlp] not linux — skipping (local dev uses yt-dlp from PATH)");
  process.exit(0);
}
if (existsSync(OUT) && statSync(OUT).size > 1_000_000 && !process.env.VERCEL) {
  console.log("[fetch-ytdlp] bin/yt-dlp already present");
  process.exit(0);
}
try {
  mkdirSync("bin", { recursive: true });
  const r = await fetch(URL_, { redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(OUT));
  chmodSync(OUT, 0o755);
  console.log(`[fetch-ytdlp] downloaded yt-dlp (${(statSync(OUT).size / 1e6).toFixed(1)} MB)`);
} catch (e) {
  console.error("[fetch-ytdlp] FAILED:", e.message, "— YT Downloader will not work in this build");
  if (process.env.VERCEL) process.exit(1);
}
