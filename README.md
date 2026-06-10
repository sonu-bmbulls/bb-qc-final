# BB QC Studio

Video quality control dashboard that **actually reads your video** using Claude's vision API. Extracts frames, runs OCR + spell-check on visible on-screen text, and flags safe-zone violations.

## What's different from the previous version

The old version generated plausible-sounding issues from the filename without ever looking at the video — that's why it couldn't catch real typos like "Stuudio" or "Exxxxpo". This version:

1. **Extracts ~12 frames** from your video using the browser's `<video>` + `<canvas>` APIs
2. **Sends them to Claude's vision API** as one batched request
3. **Claude reads every word** on-screen and flags spelling errors (especially repeated-letter typos), grammar issues, capitalization problems, and safe-zone violations
4. **Returns timestamped findings** that you can click to scrub to in the preview

It's slower than the demo version (real work is happening — expect 20-40 seconds depending on video length) but the findings are real.

## Requirements

- **Node.js 18+** (check with `node --version`)
- **An Anthropic API key** with credit — get one at https://console.anthropic.com/

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
#   On Windows PowerShell: Copy-Item .env.example .env

# 3. Open .env and paste your real key
#    ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
npm run dev
```

Opens http://localhost:5173 in your browser.

**The dev server prints a banner on startup that tells you whether your API key was picked up.** If you see "✗ ANTHROPIC_API_KEY is MISSING", stop and fix `.env` before continuing — analysis will fail without the key.

You'll also see a green/red dot in the top-right of the app showing live API status.

## How it works

```
Upload video
    ↓
[Extract Frames]     ← browser-side: <video> + <canvas>
    ↓                  ~12 frames at 1024px wide, JPEG quality 0.78
[Send to Claude]     ← single API call with all frames as base64 images
    ↓                  plus a detailed prompt about what to look for
[Parse + Validate]   ← strict JSON validation, normalize timestamps
    ↓
Display findings     ← timeline markers + clickable issue cards
```

The whole pipeline is in `src/videoAnalysis.js` if you want to inspect or tune it.

## Cost per analysis

Roughly **$0.05–$0.15 per video** depending on resolution and number of issues found. The model is `claude-sonnet-4-20250514` by default — you can swap it in `src/videoAnalysis.js` (`API_MODEL`) for a cheaper model like `claude-haiku-4-5` if cost is a concern (but vision quality may suffer).

## Tuning

In `src/videoAnalysis.js`:
- **`MAX_WIDTH`** (default 1024) — lower it to reduce cost/latency; raise it if Claude misses small text
- **Frame count** — controlled by `FRAMES_TO_EXTRACT` in `src/App.jsx` (default 12). More frames = better coverage but more cost
- **The prompt** — the prompt in `analyzeFrames()` is where to tune what Claude looks for. It's currently aggressive about repeated-letter typos because that was the original test case.

## What this WON'T catch

- **Audio issues** — no audio analysis is performed. Audio levels, clipping, music sync etc. are not flagged.
- **Technical metadata** — bitrate, codec, resolution, color space etc. are not measured (you'd need FFmpeg/MediaInfo on a backend for that).
- **Issues that don't appear in the sampled frames** — if you only have 12 sample points across a 5-minute video, things between samples are invisible. Increase `FRAMES_TO_EXTRACT` if needed.
- **Things outside the model's reading ability** — very small text, heavy stylization, unusual fonts, or text in languages the model handles poorly.

## Troubleshooting

**"API not reachable" banner on upload screen**
- Check the terminal — the startup banner shows whether the key was loaded
- Restart the dev server after editing `.env` (`Ctrl+C`, then `npm run dev`)
- Verify your key starts with `sk-ant-` and has credit at console.anthropic.com

**"Could not extract any frames from video"**
- Your browser can't decode the format. Try converting to MP4/H.264 first
- HEVC/H.265 sometimes fails depending on hardware support
- MKV containers usually don't work in browsers

**"Analysis failed: API 401"**
- Invalid API key. Check `.env` and restart

**"Analysis failed: API 429"**
- You hit a rate limit. Wait a minute and try again, or upgrade your usage tier

**Analysis takes forever**
- Vision calls with many frames can take 30-60 seconds. Watch the terminal for proxy logs
- If it's been over 2 minutes, click Cancel and try with a shorter video

**Claude misses obvious errors**
- The model only sees the ~12 sampled frames. If your error appears between samples, it's invisible.
- Increase `FRAMES_TO_EXTRACT` in `App.jsx` (try 18 or 24)
- Make sure on-screen text is large/clear enough — very small text at low resolution may be unreadable

**Claude flags things that are correct**
- Brand names, foreign words, and technical terms can be misread as typos. This is a known limitation of OCR.
- The prompt asks Claude to be conservative — but it's not perfect.

## Files

```
bb-qc-studio/
├── index.html              # HTML entry + fonts + global CSS
├── package.json
├── vite.config.js          # Dev proxy that injects ANTHROPIC_API_KEY
├── .env.example
├── .gitignore
└── src/
    ├── main.jsx            # React mount
    ├── App.jsx             # UI components + state
    └── videoAnalysis.js    # Frame extraction + Claude vision API call
```

## Production build

```bash
npm run build
npm run preview
```

## Deploying to Vercel

The repo already includes a Vercel serverless function at `api/anthropic/[...path].js` that does the same job as the Vite dev-server proxy — accepts requests from the React app at `/api/anthropic/*`, injects your API key from environment variables server-side, and forwards to `api.anthropic.com`. **Your API key never reaches the browser.**

**One-time setup on Vercel:**

1. Import the repo into Vercel (Add New → Project → Import Git Repository)
2. **Settings → Environment Variables** → add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your `sk-ant-...` key
   - Environments: check **Production** (and Preview/Development if you want those branches to work too)
3. Click **Save**
4. Trigger a fresh deployment — **existing deployments do NOT pick up new environment variables automatically**. Either push a new commit, or go to Deployments → click the three-dot menu on the latest → Redeploy.

**Verifying it works:**

After redeploying, open the deployed URL. The status dot in the top-right of the app should turn green within a second or two ("API connected"). If it stays red ("API not reachable"):

- Hover the dot — the tooltip shows the error detail returned by the function
- Check Vercel → your project → Logs → look at the most recent invocation of `api/anthropic/[...path]`. The function logs the actual error from Anthropic if the key is wrong, expired, or has no credit.

**Known plan-tier gotchas:**

- **Hobby plan caps function runtime at 10 seconds.** A 20-frame vision call typically takes 25–45 seconds, which exceeds that. Symptom: the dot goes green (probe succeeds), but actual analysis fails with a 504 / "FUNCTION_INVOCATION_TIMEOUT" after ~10s. Workarounds: upgrade to Pro (60s ceiling, configured in this repo's `vercel.json`), **or** reduce `FRAMES_TO_EXTRACT` in `src/App.jsx` from 20 to 8 — fewer frames means a faster call that fits inside 10s.
- **Request body size limit is 4.5 MB on all plans.** 20 frames at 1600 px JPEG can occasionally push past this on dense scenes (base64 inflates the payload by ~33%). Symptoms: 413 Payload Too Large. Workarounds: drop `MAX_FRAME_WIDTH` to 1200 in `src/App.jsx`, or reduce frame count.

**If you change Anthropic's API key later:**

Update the env var in Vercel Settings, then redeploy. The env var change does not propagate to running deployments — a fresh build is required for the new value to take effect.

## A note on what this can and can't do

This is real multimodal vision analysis — Claude is looking at your actual video frames — but it's a sampling approach. ~20 evenly-spaced frames across the whole video. If a defect appears between samples, it's invisible. To catch everything you'd need a backend that does frame-by-frame OCR (FFmpeg + Tesseract) and then sends only frames with text to the LLM for spell-checking.
