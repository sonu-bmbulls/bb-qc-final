// Web Worker: encodes PCM to MP3 off the main thread so the page stays smooth
// while a batch of 20-25 files converts.
//
// in:  { id, channels: Float32Array[] (1 or 2), sampleRate, kbps }
// out: { id, type: "progress", value }  |  { id, type: "done", buffer }  |  { id, type: "error", message }
import { Mp3Encoder } from "@breezystack/lamejs";

const FRAME = 1152;

function toInt16(src, from, to) {
  const out = new Int16Array(to - from);
  for (let i = from, j = 0; i < to; i++, j++) {
    const s = src[i] < -1 ? -1 : src[i] > 1 ? 1 : src[i];
    out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

self.onmessage = (e) => {
  const { id, channels, sampleRate, kbps } = e.data;
  try {
    const left = channels[0];
    const right = channels[1] || null;
    const enc = new Mp3Encoder(right ? 2 : 1, sampleRate, kbps);
    const parts = [];
    let bytes = 0;
    const total = left.length;
    let lastReport = 0;
    for (let i = 0; i < total; i += FRAME) {
      const end = Math.min(i + FRAME, total);
      const l = toInt16(left, i, end);
      const out = right ? enc.encodeBuffer(l, toInt16(right, i, end)) : enc.encodeBuffer(l);
      if (out.length) { const c = new Uint8Array(out); parts.push(c); bytes += c.length; }
      if (end - lastReport > sampleRate * 5) { lastReport = end; self.postMessage({ id, type: "progress", value: end / total }); }
    }
    const tail = enc.flush();
    if (tail.length) { const c = new Uint8Array(tail); parts.push(c); bytes += c.length; }
    const merged = new Uint8Array(bytes);
    let o = 0;
    for (const p of parts) { merged.set(p, o); o += p.length; }
    self.postMessage({ id, type: "done", buffer: merged.buffer }, [merged.buffer]);
  } catch (err) {
    self.postMessage({ id, type: "error", message: String(err?.message || err) });
  }
};
