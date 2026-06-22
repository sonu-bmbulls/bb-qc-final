// ═════════════════════════════════════════════════════════════════════════════
// api/acrcloud/identify.js
//
// Vercel serverless proxy for ACRCloud music identification (audio fingerprinting)
// for the pre-upload copyright-risk check. The frontend POSTs a short raw WAV
// sample as the request body; this function HMAC-signs the request with the
// secret ACRCloud access secret (which never reaches the browser), forwards the
// sample to ACRCloud's /v1/identify endpoint, and returns the JSON verbatim.
//
// Required env vars (Vercel → Project → Settings → Environment Variables):
//   ACRCLOUD_HOST           e.g. identify-eu-west-1.acrcloud.com  (your project's host)
//   ACRCLOUD_ACCESS_KEY
//   ACRCLOUD_ACCESS_SECRET
// Until all three are set, this returns 503 not_configured and the UI shows
// "music check not enabled" — exactly like the ElevenLabs flow.
// ═════════════════════════════════════════════════════════════════════════════

import crypto from "crypto";

export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },   // we need the raw audio bytes
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { type: "method_not_allowed", message: "Only POST is supported" } });
  }

  const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
  const host = clean(process.env.ACRCLOUD_HOST);
  const accessKey = clean(process.env.ACRCLOUD_ACCESS_KEY);
  const accessSecret = clean(process.env.ACRCLOUD_ACCESS_SECRET);

  if (!host || !accessKey || !accessSecret) {
    return res.status(503).json({
      error: {
        type: "not_configured",
        message:
          "Music copyright check is not configured. Add ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY " +
          "and ACRCLOUD_ACCESS_SECRET under Vercel → Settings → Environment Variables, then redeploy.",
      },
    });
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const sample = Buffer.concat(chunks);
    if (!sample.length) return res.status(400).json({ error: { type: "bad_request", message: "Empty audio sample." } });

    const ts = Math.floor(Date.now() / 1000).toString();
    const stringToSign = ["POST", "/v1/identify", accessKey, "audio", "1", ts].join("\n");
    const signature = crypto.createHmac("sha1", accessSecret).update(Buffer.from(stringToSign, "utf-8")).digest("base64");

    const form = new FormData();
    form.append("access_key", accessKey);
    form.append("sample_bytes", String(sample.length));
    form.append("sample", new Blob([sample], { type: "audio/wav" }), "sample.wav");
    form.append("data_type", "audio");
    form.append("signature_version", "1");
    form.append("timestamp", ts);
    form.append("signature", signature);

    const upstream = await fetch(`https://${host}/v1/identify`, { method: "POST", body: form });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    console.error("[api/acrcloud] upstream error:", e);
    return res.status(502).json({ error: { type: "proxy_error", message: "Failed to reach ACRCloud: " + e.message } });
  }
}
