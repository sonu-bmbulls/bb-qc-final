// ═════════════════════════════════════════════════════════════════════════════
// api/anthropic/v1/messages.js
//
// Vercel serverless function. Mirrors the dev-server proxy from vite.config.js
// in production. The frontend calls fetch("/api/anthropic/v1/messages"); locally
// Vite's proxy answers, on Vercel this file answers — same URL, both environments.
//
// This replaces the previous catch-all "[...path].js". Square-bracket filenames
// are fragile to commit/route (especially from Windows) and the app only ever
// hits this one path, so a concrete file at the exact route is more reliable.
// ═════════════════════════════════════════════════════════════════════════════

export const config = {
  runtime: 'nodejs',
  // Vision calls with many frames can take 30–45 seconds on Anthropic's side.
  // 60s is the Pro-plan ceiling. On the Hobby (free) plan this caps at 10s
  // regardless — if you stay on Hobby, keep FRAMES_TO_EXTRACT low (~8) in
  // src/App.jsx so analysis finishes inside 10s, or upgrade to Pro.
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
  // Trim whitespace, strip matched surrounding quotes, drop zero-width chars.
  // Catches the common copy-paste mistakes when pasting the key into Vercel.
  let apiKey = process.env.ANTHROPIC_API_KEY || '';
  apiKey = apiKey.trim();
  if (
    (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
    (apiKey.startsWith("'") && apiKey.endsWith("'"))
  ) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  apiKey = apiKey.replace(/[​-‍﻿]/g, '');

  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    return res.status(500).json({
      error: {
        type: 'configuration_error',
        message:
          "ANTHROPIC_API_KEY is missing or malformed in this Vercel " +
          "deployment's environment variables. Open the PROJECT on " +
          'vercel.com -> Settings -> Environment Variables (not the account-' +
          'wide page), add ANTHROPIC_API_KEY (must start with "sk-ant-"), ' +
          'enable it for Production, then redeploy. Env vars only take ' +
          'effect on new deployments.',
      },
    });
  }

  try {
    const upstreamRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify(req.body),
    });

    // Pass status + content-type + body through verbatim so the frontend sees
    // Anthropic's actual response (including their 4xx error JSON).
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
