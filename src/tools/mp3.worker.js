// Web Worker: encodes PCM to MP3 off the main thread.
// Uses LAME compiled to WebAssembly (wasm-media-encoders) — several times
// faster than pure-JS lamejs, which stays as a fallback.
//
// in:  { id, channels: Float32Array[] (1 or 2), sampleRate, kbps }
// out: { id, type: "progress", value } | { id, type: "done", buffer, engine } | { id, type: "error", message }
import { createEncoder } from "wasm-media-encoders";
import mp3WasmUrl from "wasm-media-encoders/wasm/mp3?url";

const BLOCK = 1152 * 128; // samples per encode() call

let wasmEnc = null;
async function getWasmEncoder() {
  if (wasmEnc === null) {
    wasmEnc = createEncoder("audio/mpeg", mp3WasmUrl).catch((e) => {
      console.warn("[mp3 worker] WASM encoder unavailable, using lamejs", e);
      return false;
    });
  }
  return wasmEnc;
}

function concat(parts, bytes) {
  const out = new Uint8Array(bytes);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function encodeWasm(enc, { id, channels, sampleRate, kbps }) {
  enc.configure({ channels: channels.length, sampleRate, bitrate: kbps });
  const total = channels[0].length;
  const parts = [];
  let bytes = 0, lastReport = 0;
  for (let i = 0; i < total; i += BLOCK) {
    const end = Math.min(i + BLOCK, total);
    const out = enc.encode(channels.map((c) => c.subarray(i, end)));
    if (out.length) { parts.push(out.slice()); bytes += out.length; } // copy out of WASM memory
    if (end - lastReport > sampleRate * 10) { lastReport = end; self.postMessage({ id, type: "progress", value: end / total }); }
  }
  const tail = enc.finalize();
  if (tail.length) { parts.push(tail.slice()); bytes += tail.length; }
  return concat(parts, bytes);
}

async function encodeLame({ id, channels, sampleRate, kbps }) {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const FRAME = 1152;
  const toInt16 = (src, from, to) => {
    const out = new Int16Array(to - from);
    for (let i = from, j = 0; i < to; i++, j++) {
      const s = src[i] < -1 ? -1 : src[i] > 1 ? 1 : src[i];
      out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  };
  const [left, right] = channels;
  const enc = new Mp3Encoder(right ? 2 : 1, sampleRate, kbps);
  const parts = [];
  let bytes = 0, lastReport = 0;
  for (let i = 0; i < left.length; i += FRAME) {
    const end = Math.min(i + FRAME, left.length);
    const l = toInt16(left, i, end);
    const out = right ? enc.encodeBuffer(l, toInt16(right, i, end)) : enc.encodeBuffer(l);
    if (out.length) { const c = new Uint8Array(out); parts.push(c); bytes += c.length; }
    if (end - lastReport > sampleRate * 10) { lastReport = end; self.postMessage({ id, type: "progress", value: end / left.length }); }
  }
  const tail = enc.flush();
  if (tail.length) { const c = new Uint8Array(tail); parts.push(c); bytes += c.length; }
  return concat(parts, bytes);
}

self.onmessage = async (e) => {
  const job = e.data;
  try {
    const enc = await getWasmEncoder();
    const out = enc ? await encodeWasm(enc, job) : await encodeLame(job);
    self.postMessage({ id: job.id, type: "done", buffer: out.buffer, engine: enc ? "wasm" : "lamejs" }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id: job.id, type: "error", message: String(err?.message || err) });
  }
};
