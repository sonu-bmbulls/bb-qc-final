import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  let apiKey = env.ANTHROPIC_API_KEY;
  const rawLength = apiKey?.length ?? 0;

  // ─── Defensive key cleanup ────────────────────────────────────────────────
  // 401 errors with a "valid-looking" key are almost always caused by one of
  // these subtle .env parsing issues:
  //   1. trailing newline or whitespace from a copy-paste
  //   2. surrounding quotes (ANTHROPIC_API_KEY="sk-ant-...")
  //   3. zero-width characters / BOM
  if (apiKey) {
    apiKey = apiKey.trim();
    // strip matched surrounding quotes
    if ((apiKey.startsWith('"') && apiKey.endsWith('"')) ||
        (apiKey.startsWith("'") && apiKey.endsWith("'"))) {
      apiKey = apiKey.slice(1, -1).trim();
    }
    // strip zero-width characters and BOM that sometimes sneak in via copy/paste
    apiKey = apiKey.replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  const keyLooksValid = !!apiKey && apiKey.startsWith('sk-ant-') && apiKey.length >= 40;
  const charsTrimmed = rawLength - (apiKey?.length ?? 0);

  // ─── Startup banner ───────────────────────────────────────────────────────
  console.log('\n┌────────────────────────────────────────────────────────────────────┐');
  console.log('│  BB QC Studio — dev server starting                                │');
  console.log('├────────────────────────────────────────────────────────────────────┤');
  if (keyLooksValid) {
    const masked = `${apiKey.slice(0, 11)}…${apiKey.slice(-6)}`;
    console.log(`│  ✓ ANTHROPIC_API_KEY loaded: ${masked.padEnd(36)}│`);
    console.log(`│    length: ${String(apiKey.length).padEnd(56)}│`);
    if (charsTrimmed > 0) {
      console.log(`│    cleaned: stripped ${charsTrimmed} char(s) of whitespace/quotes${' '.repeat(15)}│`);
    }
  } else if (apiKey) {
    console.log('│  ⚠ ANTHROPIC_API_KEY is set but looks WRONG:                       │');
    console.log(`│    starts with: ${JSON.stringify(apiKey.slice(0, 10)).padEnd(50)}│`);
    console.log(`│    length:      ${String(apiKey.length).padEnd(50)}│`);
    console.log('│    A valid Anthropic key starts with "sk-ant-" and is ~100 chars   │');
    console.log('│    long. Double-check you copied the full key from                 │');
    console.log('│    https://console.anthropic.com/settings/keys                     │');
  } else {
    console.log('│  ✗ ANTHROPIC_API_KEY is MISSING                                    │');
    console.log('│    1. cp .env.example .env                                         │');
    console.log('│    2. open .env and paste your full key                            │');
    console.log('│    3. Ctrl+C and `npm run dev` again — Vite only reads .env on    │');
    console.log('│       startup                                                      │');
  }
  console.log('└────────────────────────────────────────────────────────────────────┘\n');

  return {
    plugins: [react()],
    server: {
      port: 5173,
      open: true,
      proxy: {
        '/api/anthropic': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
          timeout: 180000,
          proxyTimeout: 180000,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              // ── Strip browser-fingerprint headers ──────────────────────────
              // Vite's changeOrigin only rewrites the Host header. The browser
              // still sends Origin: http://localhost:5173 and Referer through,
              // and Vite's proxy faithfully forwards them. When Anthropic sees
              // an Origin header on an inbound request, it treats it as a
              // CORS-from-browser call and demands the
              // 'anthropic-dangerous-direct-browser-access' opt-in header.
              //
              // We're not actually a browser — we're a Node.js proxy running
              // server-side. Stripping these headers makes the request look
              // like the server-to-server call it actually is, and Anthropic
              // stops asking for the browser-direct opt-in.
              proxyReq.removeHeader('origin');
              proxyReq.removeHeader('referer');
              proxyReq.removeHeader('cookie');
              // Sec-Fetch-* / Sec-Ch-* are modern browser fingerprinting
              // headers that also signal browser origin. Strip them all.
              const allHeaders = proxyReq.getHeaders();
              for (const name of Object.keys(allHeaders)) {
                if (/^sec-/i.test(name)) proxyReq.removeHeader(name);
              }

              // ── Force identity (uncompressed) responses ────────────────────
              // The Vite dev proxy can interact poorly with compressed
              // (gzip/br) responses: if any middleware reads or modifies the
              // body, the Content-Length stops matching the compressed bytes
              // and the browser closes the connection early, leaving you with
              // truncated JSON ("Unexpected end of JSON input"). Forcing
              // identity encoding sidesteps the whole class of problem —
              // dev-only, so the bandwidth cost is irrelevant.
              proxyReq.removeHeader('accept-encoding');
              proxyReq.setHeader('accept-encoding', 'identity');

              if (keyLooksValid) {
                // Remove any browser-set auth header first to avoid conflicts
                proxyReq.removeHeader('authorization');
                proxyReq.removeHeader('x-api-key');
                proxyReq.setHeader('x-api-key', apiKey);
                proxyReq.setHeader('anthropic-version', '2023-06-01');
              }
            });

            // ── Defensive: strip stale encoding/length headers from response.
            // With accept-encoding: identity above this should never trigger,
            // but if anything upstream sets Content-Encoding on a body we've
            // forced to be uncompressed, the browser will try to decompress
            // plain JSON and fail. Belt-and-braces.
            proxy.on('proxyRes', (proxyRes) => {
              if (proxyRes.headers['content-encoding'] === 'identity' ||
                  !proxyRes.headers['content-encoding']) {
                // nothing to do
              } else {
                // Unexpected: server ignored our accept-encoding. Drop the
                // header so the client treats the body as-is rather than
                // trying to decompress something already decompressed by
                // some middle layer.
                delete proxyRes.headers['content-encoding'];
              }
            });

            // Capture and log the response body when Anthropic returns an error.
            // This is the key change — Anthropic's 401 response usually says exactly
            // what's wrong ("invalid x-api-key", "key deactivated", etc.) but the
            // old proxy was swallowing that detail.
            proxy.on('proxyRes', (proxyRes, req) => {
              if (proxyRes.statusCode >= 400) {
                const chunks = [];
                proxyRes.on('data', (chunk) => chunks.push(chunk));
                proxyRes.on('end', () => {
                  const body = Buffer.concat(chunks).toString('utf8');
                  console.error(`\n[proxy] ${req.method} ${req.url} → ${proxyRes.statusCode}`);
                  console.error('[proxy] Anthropic response body:');
                  console.error(body);
                  if (proxyRes.statusCode === 401) {
                    console.error('\n[proxy] 401 troubleshooting:');
                    console.error('  • Open https://console.anthropic.com/settings/keys');
                    console.error('  • Confirm the key is ACTIVE (not deactivated)');
                    console.error('  • Click the key, view the prefix — does it match what');
                    console.error(`    the banner above shows? (${keyLooksValid ? `${apiKey.slice(0, 11)}…${apiKey.slice(-6)}` : 'no valid key loaded'})`);
                    console.error('  • If they don\'t match, you have the wrong key in .env');
                    console.error('  • If they match, try regenerating the key');
                  }
                  console.error('');
                });
              }
            });

            proxy.on('error', (err, _req, res) => {
              console.error('\n[proxy] network error:', err.message);
              if (res && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }));
              }
            });
          },
        },
      },
    },
  };
});
