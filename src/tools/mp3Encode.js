// Browser-side MP3 helpers (no server, no upload).
//   decodeToAudioBuffer(file)       → AudioBuffer resampled to 44.1 kHz
//   encodeInWorker(buffer, kbps, …) → Blob (audio/mpeg), encoded in a Web Worker

const TARGET_RATE = 44100;

export async function decodeToAudioBuffer(file) {
  const bytes = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("This browser can't decode audio. Use Chrome or Edge.");
  let ctx;
  try { ctx = new Ctx({ sampleRate: TARGET_RATE }); } catch { ctx = new Ctx(); }
  try {
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(bytes, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
  } catch {
    throw new Error("No readable audio in this file (or the format isn't supported by the browser).");
  } finally {
    ctx.close?.();
  }
}

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./mp3.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const { id, type } = e.data;
    const job = pending.get(id);
    if (!job) return;
    if (type === "progress") job.onProgress?.(e.data.value);
    else if (type === "done") { pending.delete(id); job.resolve(new Blob([e.data.buffer], { type: "audio/mpeg" })); }
    else if (type === "error") { pending.delete(id); job.reject(new Error(e.data.message)); }
  };
  worker.onerror = (e) => {
    for (const job of pending.values()) job.reject(new Error(e.message || "Encoder crashed."));
    pending.clear();
    worker?.terminate(); worker = null;
  };
  return worker;
}

export function encodeInWorker(buffer, kbps, onProgress) {
  const rate = buffer.sampleRate;
  if (![32000, 44100, 48000].includes(rate)) return Promise.reject(new Error(`Unsupported sample rate ${rate} Hz.`));
  const n = Math.min(2, buffer.numberOfChannels || 1);
  // Copy channel data so it can be transferred to the worker.
  const channels = Array.from({ length: n }, (_, c) => buffer.getChannelData(c).slice());
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, channels, sampleRate: rate, kbps }, channels.map((c) => c.buffer));
  });
}

export function cancelAllEncoding() {
  for (const job of pending.values()) job.reject(new DOMException("Cancelled", "AbortError"));
  pending.clear();
  worker?.terminate();
  worker = null;
}
