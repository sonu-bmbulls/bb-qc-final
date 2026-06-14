// ═════════════════════════════════════════════════════════════════════════════
// api/elevenlabs/v1/speech-to-text.js
//
// Vercel serverless proxy for ElevenLabs Scribe (speech-to-text). The frontend
// POSTs a multipart/form-data body (file=<wav> + model_id=scribe_v1) to
// /api/elevenlabs/v1/speech-to-text; this function forwards the RAW body to
// api.elevenlabs.io verbatim and injects the secret xi-api-key header so the key
// never reaches the browser. Mirrors api/anthropic/v1/messages.js. In dev, the
// Vite proxy (vite.config.js) answers the same path.
//
// bodyParser is disabled so we get the exact multipart bytes (boundary intact)
// and can pipe them straight through — no server-side multipart parsing needed.
// ═════════════════════════════════════════════════════════════════════════════

export const config = {
  runtime: 'nodejs',
  api: { bodyParser: false },
  // Scribe is faster-than-realtime, but allow headroom for a ~90s audio chunk.
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      error: { type: 'method_not_allowed', message: 'Only POST is supported' },
    });
  }

  let apiKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  if ((apiKey.startsWith('"') && apiKey.endsWith('"')) ||
      (apiKey.startsWith("'") && apiKey.endsWith("'"))) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  apiKey = apiKey.replace(/[​-‍﻿]/g, '');

  if (!apiKey) {
    return res.status(500).json({
      error: {
        type: 'configuration_error',
        message:
          'ELEVENLABS_API_KEY is missing in this deployment. Add it under the ' +
          'Vercel PROJECT -> Settings -> Environment Variables (Production), ' +
          'then redeploy. Env vars only take effect on new deployments.',
      },
    });
  }

  try {
    // Read the raw multipart body (bodyParser is off).
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        // Preserve the exact multipart content-type (it carries the boundary).
        'content-type': req.headers['content-type'] || 'multipart/form-data',
        'accept-encoding': 'identity',
      },
      body,
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (e) {
    console.error('[api/elevenlabs] upstream forward error:', e);
    return res.status(502).json({
      error: { type: 'proxy_error', message: 'Failed to reach api.elevenlabs.io: ' + e.message },
    });
  }
}
