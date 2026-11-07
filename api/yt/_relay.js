// Local seekable relay for YouTube stream URLs.
//
// ffmpeg needs to SEEK inside a stream to cut a segment, but YouTube rejects
// open-ended byte ranges (403). This tiny server on 127.0.0.1 answers ffmpeg's
// range requests by fetching the real URL in bounded chunks (≤ 10 MB, like
// yt-dlp does), so ffmpeg sees a normal seekable file.
//
// Built on raw `net` sockets on purpose: Vercel's Node runtime hijacks
// http.createServer(), so an http server would never receive ffmpeg's requests.
import net from "node:net";

const CHUNK = 10 * 1024 * 1024;

export function startRelay(formats) {
  const sizes = new Map();
  const live = new Set();

  async function totalSize(i, signal) {
    if (sizes.has(i)) return sizes.get(i);
    const f = formats[i];
    let total = Number(f.filesize) || 0;
    if (!total) {
      const r = await fetch(f.url, { headers: { ...(f.http_headers || {}), Range: "bytes=0-0" }, signal });
      total = Number((r.headers.get("content-range") || "").split("/")[1]) || 0;
      try { await r.body?.cancel(); } catch { /* ignore */ }
      if (!total) throw new Error(`size lookup failed (HTTP ${r.status})`);
    }
    sizes.set(i, total);
    return total;
  }

  async function serve(sock, head) {
    const ac = new AbortController();
    live.add(ac);
    const done = () => { ac.abort(); live.delete(ac); };
    sock.on("close", done);
    sock.on("error", done);
    try {
      const [reqLine, ...lines] = head.split("\r\n");
      const [method, path] = reqLine.split(" ");
      const headers = Object.fromEntries(lines.filter(Boolean).map((l) => {
        const k = l.indexOf(":");
        return [l.slice(0, k).trim().toLowerCase(), l.slice(k + 1).trim()];
      }));
      const i = Number((path || "").slice(1));
      if (!formats[i]) { sock.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
      const f = formats[i];
      const total = await totalSize(i, ac.signal);
      const m = /bytes=(\d*)-(\d*)/.exec(headers.range || "");
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start >= total) {
        sock.end(`HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */${total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        return;
      }
      sock.write(
        `HTTP/1.1 ${m ? "206 Partial Content" : "200 OK"}\r\n` +
        "Content-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\n" +
        `Content-Length: ${end - start + 1}\r\n` +
        (m ? `Content-Range: bytes ${start}-${end}/${total}\r\n` : "") +
        "Connection: close\r\n\r\n",
      );
      if (method === "HEAD") { sock.end(); return; }
      for (let pos = start; pos <= end && !ac.signal.aborted;) {
        const to = Math.min(pos + CHUNK - 1, end);
        const r = await fetch(f.url, { headers: { ...(f.http_headers || {}), Range: `bytes=${pos}-${to}` }, signal: ac.signal });
        if (r.status !== 206 && r.status !== 200) {
          const body = await r.text().catch(() => "");
          throw new Error(`YouTube HTTP ${r.status} for bytes=${pos}-${to} ${body.slice(0, 120)}`);
        }
        for await (const piece of r.body) {
          if (sock.destroyed) break;
          if (!sock.write(piece)) await new Promise((ok) => { sock.once("drain", ok); sock.once("close", ok); });
          pos += piece.length;
        }
      }
      sock.end();
    } catch (e) {
      if (!ac.signal.aborted) console.error("[yt/relay]", e?.message);
      sock.destroy();
    }
  }

  const server = net.createServer((sock) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString("latin1");
      const k = buf.indexOf("\r\n\r\n");
      if (k === -1) { if (buf.length > 16384) sock.destroy(); return; }
      sock.off("data", onData);
      sock.pause();
      serve(sock, buf.slice(0, k));
    };
    sock.on("data", onData);
    sock.on("error", () => { /* ffmpeg hung up */ });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: (i) => `http://127.0.0.1:${port}/${i}`,
        close: () => { for (const ac of live) ac.abort(); server.close(); },
      });
    });
  });
}
