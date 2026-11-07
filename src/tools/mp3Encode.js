// Browser-side MP3 encoding helpers (no server, no upload).
//   decodeToAudioBuffer(file) → AudioBuffer (works for mp4/mov/webm/wav/m4a/mp3…
//                                whatever the browser can decode)
//   encodeMp3(buffer, kbps, onProgress, signal) → Blob (audio/mpeg)
import { Mp3Encoder } from "@breezystack/lamejs";

const TARGET_RATE = 44100;     // lame supports 32k / 44.1k / 48k input
const FRAME = 1152;            // samples per MP3 frame
const FRAMES_PER_YIELD = 200;  // hand control back to the UI this often

export async function decodeToAudioBuffer(file) {
  const bytes = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("This browser can't decode audio. Try Chrome or Edge.");
  let ctx;
  try { ctx = new Ctx({ sampleRate: TARGET_RATE }); } catch { ctx = new Ctx(); }
  try {
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(bytes, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
  } catch {
    throw new Error("Couldn't read audio from this file. It may have no audio track, or the format isn't supported by your browser.");
  } finally {
    ctx.close?.();
  }
}

function floatTo16(src, from, to) {
  const out = new Int16Array(to - from);
  for (let i = from, j = 0; i < to; i++, j++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export async function encodeMp3(buffer, kbps = 192, onProgress, signal) {
  const channels = Math.min(2, buffer.numberOfChannels || 1);
  const rate = buffer.sampleRate;
  if (![32000, 44100, 48000].includes(rate)) {
    throw new Error(`Unsupported sample rate ${rate} Hz.`);
  }
  const left = buffer.getChannelData(0);
  const right = channels > 1 ? buffer.getChannelData(1) : null;
  const total = left.length;
  const enc = new Mp3Encoder(channels, rate, kbps);
  const parts = [];

  let frames = 0;
  for (let i = 0; i < total; i += FRAME) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const end = Math.min(i + FRAME, total);
    const l = floatTo16(left, i, end);
    const out = right ? enc.encodeBuffer(l, floatTo16(right, i, end)) : enc.encodeBuffer(l);
    if (out.length) parts.push(new Uint8Array(out));
    if (++frames % FRAMES_PER_YIELD === 0) {
      onProgress?.(end / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  onProgress?.(1);
  return new Blob(parts, { type: "audio/mpeg" });
}
