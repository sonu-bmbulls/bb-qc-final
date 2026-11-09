// Browser-side MP3 helpers (no server, no upload).
//   decodeToAudioBuffer(file)       → AudioBuffer resampled to 44.1 kHz (native decoder)
//   encodeInWorker(buffer, kbps, …) → Blob (audio/mpeg), encoded by a pool of Web Workers
//   PARALLEL                        → how many files the converter runs at once

const TARGET_RATE = 44100;
const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
export const PARALLEL = Math.max(2, Math.min(4, cores - 1));

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

// ── Worker pool ──────────────────────────────────────────────────────────────
let seq = 0;
const pool = [];      // { worker, busy }
const waiting = [];   // resolvers waiting for a free worker
const pending = new Map();

function makeWorker() {
  const w = new Worker(new URL("./mp3.worker.js", import.meta.url), { type: "module" });
  const slot = { worker: w, busy: false };
  w.onmessage = (e) => {
    const { id, type } = e.data;
    const job = pending.get(id);
    if (!job) return;
    if (type === "progress") { job.onProgress?.(e.data.value); return; }
    pending.delete(id);
    release(slot);
    if (type === "done") job.resolve(new Blob([e.data.buffer], { type: "audio/mpeg" }));
    else job.reject(new Error(e.data.message));
  };
  w.onerror = (e) => {
    for (const [id, job] of pending) if (job.slot === slot) { pending.delete(id); job.reject(new Error(e.message || "Encoder crashed.")); }
    w.terminate();
    pool.splice(pool.indexOf(slot), 1);
    waiting.shift()?.();
  };
  pool.push(slot);
  return slot;
}

function acquire() {
  const free = pool.find((s) => !s.busy) || (pool.length < PARALLEL ? makeWorker() : null);
  if (free) { free.busy = true; return Promise.resolve(free); }
  return new Promise((ok) => waiting.push(() => ok(acquire())));
}
function release(slot) { slot.busy = false; waiting.shift()?.(); }

export async function encodeInWorker(buffer, kbps, onProgress) {
  const rate = buffer.sampleRate;
  if (![32000, 44100, 48000].includes(rate)) throw new Error(`Unsupported sample rate ${rate} Hz.`);
  const n = Math.min(2, buffer.numberOfChannels || 1);
  // Copy channel data so it can be transferred (zero-copy) to the worker.
  const channels = Array.from({ length: n }, (_, c) => buffer.getChannelData(c).slice());
  const slot = await acquire();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress, slot });
    slot.worker.postMessage({ id, channels, sampleRate: rate, kbps }, channels.map((c) => c.buffer));
  });
}

export function cancelAllEncoding() {
  for (const job of pending.values()) job.reject(new DOMException("Cancelled", "AbortError"));
  pending.clear();
  for (const s of pool) s.worker.terminate();
  pool.length = 0;
  waiting.length = 0;
}
