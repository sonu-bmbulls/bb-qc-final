// Local seekable relay for YouTube stream URLs.
//
// ffmpeg needs to SEEK inside a stream to cut a segment, but YouTube rejects
// open-ended byte ranges (403). This tiny HTTP server on 127.0.0.1 answers
// ffmpeg's range requests by fetching the real URL in bounded chunks
// (≤ 10 MB, like yt-dlp does), so ffmpeg sees a normal seekable file.
import http from "node:http";

const CHUNK = 10 * 1024 * 1024;

export function startRelay(formats) {
  const sizes = new Map();
  const active = new Set();

  async function totalSize(i) {
    if (sizes.has(i)) return sizes.get(i);
    const f = formats[i];
    let total = Number(f.filesize) || 0;
    if (!total) {
      const r = await fetch(f.url, { headers: { ...(f.http_headers || {}), Range: "bytes=0-0" } });
      const cr = r.headers.get("content-range") || "";
      total = Number(cr.split("/")[1]) || 0;
      try { await r.body?.cancel(); } catch { /* ignore */ }
      if (!total) throw new Error(`size lookup failed (HTTP ${r.status})`);
      console.log("[yt/relay] size via range probe", i, total);
    }
    sizes.set(i, total);
    return total;
  }

  const server = http.createServer(async (req, res) => {
    const i = Number(req.url.slice(1));
    console.log("[yt/relay] req", req.method, req.url, req.headers.range || "(no range)");
    const f = formats[i];
    if (!f) { res.statusCode = 404; return res.end(); }
    const ac = new AbortController();
    active.add(ac);
    res.on("close", () => { ac.abort(); active.delete(ac); });
    try {
      const total = await totalSize(i);
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start >= total) { res.writeHead(416, { "Content-Range": `bytes */${total}` }); return res.end(); }
      res.writeHead(m ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        ...(m ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
      });
      if (req.method === "HEAD") return res.end();
      for (let pos = start; pos <= end && !ac.signal.aborted;) {
        const to = Math.min(pos + CHUNK - 1, end);
        const r = await fetch(f.url, { headers: { ...(f.http_headers || {}), Range: `bytes=${pos}-${to}` }, signal: ac.signal });
        if (r.status !== 206 && r.status !== 200) {
          const body = await r.text().catch(() => "");
          throw new Error(`YouTube HTTP ${r.status} for bytes=${pos}-${to} ${body.slice(0, 120)}`);
        }
        for await (const piece of r.body) {
          if (!res.write(piece)) await new Promise((ok) => res.once("drain", ok));
          pos += piece.length;
        }
      }
      res.end();
    } catch (e) {
      console.error("[yt/relay]", ac.signal.aborted ? "(aborted)" : "", e?.message);
      res.destroy();
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: (i) => `http://127.0.0.1:${port}/${i}`,
        close: () => { for (const ac of active) ac.abort(); server.close(); },
      });
    });
  });
}
