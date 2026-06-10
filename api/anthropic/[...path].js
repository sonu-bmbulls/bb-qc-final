// ═════════════════════════════════════════════════════════════════════════════
// api/anthropic/[...path].js
//
// Vercel serverless function. Mirrors the dev-server proxy from vite.config.js
// in production. Without this file, deployed builds get 404s on every API
// call because the Vite proxy only runs during `npm run dev`.
//
// HOW VERCEL ROUTES THIS FILE:
//   The "[...path]" in the filename is Vercel's catch-all syntax. Any request
//   to /api/anthropic/anything/here/at/all routes to this handler, with the
//   trailing segments arriving as req.query.path = ["anything","here","at","all"].
//   We reconstruct the upstream URL from that array.
//
// WHY THE FRONTEND DOESN'T NEED TO CHANGE:
//   The frontend already calls fetch("/api/anthropic/v1/messages"). Locally,
//   Vite's proxy answers that. On Vercel, this function answers it. Same URL,
//   different runtime — the React code is identical in both environments.
// ═════════════════════════════════════════════════════════════════════════════

export const config = {
  runtime: 'nodejs',
  // Vision calls with 20 frames can take 30–45 seconds on Anthropic's side.
  // Default Vercel timeout is 10s on Hobby — bumping to 60s.
  // Note: 60s is the Pro-plan ceiling. On Hobby this caps at 10s regardless.
  // If you stay on Hobby, reduce FRAMES_TO_EXTRACT in src/App.jsx to ~8 so
  // analysis finishes inside 10s, or upgrade to Pro for the full 60s.
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      error: { type: 'method_not_allowed', message: 'Only POST is supported' },
    });
  }

  // ── Read + clean the API key ─────────────────────────────────────────────
  // Same defensive cleanup as the dev proxy: trim whitespace, strip matched
  // surrounding quotes, drop zero-width characters. Catches the common copy-
  // paste mistakes where you paste a key with a trailing newline or wrap it
  // in quotes in the Vercel dashboard.
  let apiKey = process.env.ANTHROPIC_API_KEY || '';
  apiKey = apiKey.trim();
  if (
    (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
    (apiKey.startsWith("'") && apiKey.endsWith("'"))
  ) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  apiKey = apiKey.replace(/[\u200B-\u200D\uFEFF]/g, '');

  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    return res.status(500).json({
      error: {
        type: 'configuration_error',
        message:
          "ANTHROPIC_API_KEY is missing or malformed in this Vercel " +
          "deployment's environment variables. Open the project on " +
          "vercel.com → Settings → Environment Variables, add " +
          "ANTHROPIC_API_KEY (must start with 'sk-ant-' and be active in " +
          'your Anthropic console), make sure it is enabled for the ' +
          'Production environment, then redeploy. Environment variables ' +
          'only take effect on new deployments — existing ones do not ' +
          'pick them up automatically.',
      },
    });
  }

  // ── Reconstruct the upstream path ────────────────────────────────────────
  // Frontend calls /api/anthropic/v1/messages → req.query.path = ["v1","messages"]
  // → upstreamUrl = https://api.anthropic.com/v1/messages
  const { path } = req.query;
  const upstreamPath = Array.isArray(path) ? path.join('/') : path || '';
  const upstreamUrl = `https://api.anthropic.com/${upstreamPath}`;

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // identity = no compression. Avoids the dev-environment compression
        // truncation issues; on Vercel it's just hygiene.
        'accept-encoding': 'identity',
      },
      // req.body is parsed by Vercel's default JSON body parser — re-stringify
      // for the upstream call. (We don't strip browser-fingerprint headers
      // here because they don't get forwarded by fetch() in the first place.)
      body: JSON.stringify(req.body),
    });

    // Pass status + content-type + body through verbatim so the frontend's
    // error handling sees Anthropic's actual response (including their 4xx
    // error JSON if something's wrong with the request).
    const text = await upstreamRes.text();
    res.status(upstreamRes.status);
    res.setHeader(
      'Content-Type',
      upstreamRes.headers.get('content-type') || 'application/json'
    );
    return res.send(text);
  } catch (e) {
    console.error('[api/anthropic] upstream forward error:', e);
    return res.status(502).json({
      error: {
        type: 'proxy_error',
        message: 'Failed to reach api.anthropic.com: ' + e.message,
      },
    });
  }
}
