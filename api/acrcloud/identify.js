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
// "music check not enabled".
//
// NOTE: uses raw `res.statusCode` + `res.end()` (not res.status()/.json()/.send())
// — those Vercel helpers threw "invalid parameter format" on this runtime here.
// ═════════════════════════════════════════════════════════════════════════════

import crypto from "crypto";

export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },   // we need the raw audio bytes
  maxDuration: 30,
};

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: { type: "method_not_allowed", message: "Only POST is supported" } });
  }

  const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
  // Normalize the host: strip any protocol prefix, trailing slash, or accidental
  // path so `https://${host}/v1/identify` is always a valid URL.
  const host = clean(process.env.ACRCLOUD_HOST).replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const accessKey = clean(process.env.ACRCLOUD_ACCESS_KEY);
  const accessSecret = clean(process.env.ACRCLOUD_ACCESS_SECRET);

  if (!host || !accessKey || !accessSecret) {
    return send(res, 503, {
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
    if (!sample.length) return send(res, 400, { error: { type: "bad_request", message: "Empty audio sample." } });

    const ts = Math.floor(Date.now() / 1000).toString();
    const stringToSign = ["POST", "/v1/identify", accessKey, "audio", "1", ts].join("\n");
    const signature = crypto.createHmac("sha1", accessSecret).update(Buffer.from(stringToSign, "utf-8")).digest("base64");

    // Build multipart/form-data manually (no dependency on global FormData/Blob).
    const boundary = "----acrqc" + crypto.randomBytes(10).toString("hex");
    const field = (name, val) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`, "utf-8");
    const fileHead = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sample"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n`, "utf-8");
    const body = Buffer.concat([
      field("access_key", accessKey),
      field("data_type", "audio"),
      field("signature_version", "1"),
      field("signature", signature),
      field("sample_bytes", String(sample.length)),
      field("timestamp", ts),
      fileHead, sample, Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"),
    ]);

    const upstream = await fetch(`https://${host}/v1/identify`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const text = await upstream.text();
    return send(res, upstream.status || 200, text);
  } catch (e) {
    console.error("[api/acrcloud] upstream error:", e);
    return send(res, 502, { error: { type: "proxy_error", message: "Failed to reach ACRCloud: " + (e && e.message) } });
  }
}
