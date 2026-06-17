// ═════════════════════════════════════════════════════════════════════════════
// BB QC STUDIO — App.jsx
//
// Single-file React app. Everything lives here:
//   1. CONFIG + THEME           — constants, colors
//   2. HELPERS                  — fmt, validation
//   3. ANALYSIS PIPELINE        — frame extraction + Claude vision API
//   4. UI COMPONENTS            — nav, upload, analyzing, results, timeline
//   5. MAIN APP                 — state machine + rendering
//
// The four hard rules baked into this build:
//   • TIMESTAMPS are integer seconds, captured from video.currentTime AFTER
//     each seek completes (so they reflect the actual frame on canvas, not
//     the requested time). First frame is forced to t=0 so the opening
//     reliably reads as 0:00.
//   • CLAUDE NEVER GUESSES timestamps. Each frame carries a [FRAME_METADATA]
//     block with locked index + timestamp; the prompt explicitly forbids
//     modification and the app's parser uses frameIndex for the canonical
//     timestamp lookup.
//   • REFERENCE BRIEF is injected into the system prompt verbatim when the
//     user fills the textarea on the upload screen.
//   • CONSISTENCY: temperature=0 in the API call + an EXHAUSTIVE-PASS
//     PROTOCOL section in the prompt that mandates the same scanning
//     routine on every run.
// ═════════════════════════════════════════════════════════════════════════════

import { useState, useRef, useCallback, useEffect, useMemo } from "react";

// ═════════════════════════════════════════════════════════════════════════════
// 1. CONFIG + THEME
// ═════════════════════════════════════════════════════════════════════════════

const API_URL = "/api/anthropic/v1/messages";
const API_TEMPERATURE = 0;               // 0 = deterministic-ish output; the single biggest
                                         // lever for run-to-run consistency
const DEFAULT_MODEL = "claude-sonnet-4-6"; // used by the connectivity probe + as a fallback

// ── SPEED MODES (the user picks one BEFORE scanning) ──────────────────────────
// Each mode is a pure data record that drives the WHOLE pipeline: which model,
// how densely to sample frames, how many parallel timeline segments to cut, the
// per-call response-token budget, whether to run the creative pass, and the HARD
// wall-clock cap that powers the live countdown + the abort guardrail.
//
// Model note: this app calls the Anthropic API (the /api/anthropic proxy), so the
// fast/cheap tier is Claude Haiku 4.5 and the high-intelligence tier is Claude
// Sonnet 4.6 — the current vision-capable IDs.
const MODES = {
  urgent: {
    id: "urgent",
    label: "Urgent Pass",
    icon: "⚡",
    blurb: "Objective errors only — spelling, grammar, safe-zones. Fast & cheap.",
    model: "claude-haiku-4-5",
    coverageFps: 1,            // sparse sampling = fewer frames = faster
    maxSegments: 3,
    maxTokens: 2048,           // small JSON payload → lower latency
    runCreative: false,        // skip creative/retention entirely
    priceIn: 1.0,              // Haiku 4.5 $/1M input
    priceOut: 5.0,             // Haiku 4.5 $/1M output
    capFormula: (dur) => Math.max(60_000, Math.round(dur) * 2_000),   // 60s → 120s cap
  },
  deep: {
    id: "deep",
    label: "Deep Audit",
    icon: "🔬",
    blurb: "Full audit — typos PLUS hooks, pacing, branding & creative retention.",
    model: "claude-sonnet-4-6",
    coverageFps: 2,
    maxSegments: 4,
    maxTokens: 8192,
    runCreative: true,
    priceIn: 3.0,              // Sonnet 4.6 $/1M input
    priceOut: 15.0,            // Sonnet 4.6 $/1M output
    capFormula: (dur) => Math.max(180_000, Math.round(dur) * 6_000),  // 60s → 360s cap
  },
};
const DEFAULT_MODE = "urgent";

// ── Divide & Conquer config ───────────────────────────────────────────────────
const SEGMENT_TARGET_SEC = 20;   // aim for ~20s per timeline segment (60s video → 3 segments)
const SEGMENT_OVERLAP_SEC = 1;   // 1s overlap so a caption on a seam isn't sliced in half
const SEGMENT_TIMEOUT_PAD = 1.4; // a segment's watchdog = its share of the cap × this

// ── Exhaustive scan config ───────────────────────────────────────────────────
// Within each segment we scan DENSELY and send frames in small BATCHES across
// parallel API calls. Small batches keep every call under the Vercel Hobby 10s
// limit AND the 4.5MB body limit. Duplicate findings (same caption across
// near-identical frames, or across the 1s segment overlaps) are merged by
// dedupeIssues after everything returns.
const COVERAGE_FPS = 2;          // default fps (each MODE overrides this per scan)
const MAX_TOTAL_FRAMES = 600;    // hard cap so very long videos don't explode cost/time
const BATCH_SIZE = 4;            // frames per API call — small = fast, fits Hobby 10s & 4.5MB
const BATCH_CONCURRENCY = 4;     // batches in flight at once (raised now segments run in parallel)
const BATCH_MAX_RETRIES = 5;     // retry 429 / 5xx / 504 per batch so NOTHING is silently dropped
const CREATIVE_FRAME_COUNT = 12; // sparse, evenly-spaced frames for the holistic creative pass
const MAX_FRAME_WIDTH = 1600;    // px; higher = clearer OCR. Small batches keep payloads safe
const FRAME_JPEG_QUALITY = 0.85; // higher = better OCR on small/stylized text

// ── Audio / speech-to-text (ElevenLabs Scribe) ────────────────────────────────
const STT_URL = "/api/elevenlabs/v1/speech-to-text";
const STT_MODEL = "scribe_v1";    // ElevenLabs Scribe batch model (90+ languages incl. Hindi)
const AUDIO_SAMPLE_RATE = 16000;  // mono 16kHz is plenty for ASR and keeps WAV small
const AUDIO_CHUNK_SEC = 90;       // 90s mono-16k WAV ≈ 2.9MB, under Vercel's 4.5MB body cap

// ── Animation verification ────────────────────────────────────────────────────
const VERIFY_WINDOW_SEC = 1.5;    // seconds of frames BEFORE a finding to include when verifying
const VERIFY_FORWARD_SEC = 6;     // seconds AHEAD to look — captions reveal progressively and lag
                                  // the voiceover, so the "missing" text often appears a few
                                  // seconds later; we must look far enough ahead to see it

// ── Review playback ───────────────────────────────────────────────────────────
// Clicking an issue lands this many seconds BEFORE the flagged frame (then plays)
// so the reviewer gets lead-in context — caption animation + audio — instead of
// landing exactly on the (possibly mid-animation) error frame. ~0.6s ≈ 3–5 frames
// at 24–30fps, within the requested 0.5–1s window.
const ISSUE_PREROLL_SEC = 0.6;

// ── Cost calculator (shown on the confirm screen before scanning) ─────────────
// Vision token usage is estimated from image dimensions: tokens ≈ (w × h) / 750.
// Per-mode $/1M pricing lives on each MODE above.
const PROMPT_TOKENS_PER_CALL = 2600; // approx tokens for the QC instruction text per call
const OUTPUT_TOKENS_PER_CALL = 350;  // rough average findings output per call

const CHECKS = [
  { id: "grammar",  label: "Grammar & Spelling",   icon: "✍️", desc: "Captions, titles, on-screen text" },
  { id: "safezone", label: "Safe Zone Compliance", icon: "📐", desc: "Text & logos within safe zones" },
  { id: "quality",  label: "Video Quality",        icon: "🎬", desc: "Resolution, motion, sharpness" },
  { id: "color",    label: "Color & Brand",        icon: "🎨", desc: "Color grading & cast detection" },
  { id: "audio",    label: "Audio Levels",         icon: "🔊", desc: "Not analyzed in vision mode" },
  { id: "metadata", label: "Metadata & Tags",      icon: "🏷️", desc: "Not analyzed in vision mode" },
];

const VALID_CHECK_IDS = new Set(["grammar", "safezone", "quality", "audio", "color", "metadata"]);
const VALID_SEVERITIES = new Set(["error", "warning", "info"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
// Where a finding's text lives: an intentional caption/subtitle/title overlay
// added in the edit, vs incidental text filmed in the shot (iPad/notebook
// handwriting, whiteboard, slide/document, app UI, signage). In "captions only"
// scope we drop "visual" findings so rough notes never read as QC errors.
const VALID_TEXT_SOURCE = new Set(["caption", "visual"]);
const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };
// Only HIGH-confidence defects may be shown as "error". Medium caps at "warning",
// low caps at "info" — graded down, never hidden. Keeps the report trustworthy.
function gateSeverityByConfidence(severity, confidence) {
  const cap = confidence === "high" ? "error" : confidence === "medium" ? "warning" : "info";
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[cap] ? severity : cap;
}

// ── Importance / triage (Frame.io-style) ──────────────────────────────────────
const VALID_PRIORITY = new Set(["required", "optional", "ignore"]);
const PRIORITY = {
  required: { label: "Required Fix", short: "REQUIRED", color: "#ef4444" },
  optional: { label: "Optional",     short: "OPTIONAL", color: "#f59e0b" },
  ignore:   { label: "Unnecessary",  short: "IGNORE",   color: "#94a3b8" },
};
// A finding's importance: the model's priority if valid, else derived from the
// confidence-gated severity. Drives the report's filters and the score.
function issuePriority(it) {
  if (it && VALID_PRIORITY.has(it.priority)) return it.priority;
  if (!it) return "optional";
  if (it.severity === "error") return "required";
  if (it.severity === "warning") return "optional";
  return "ignore";
}

// ── Three-tier classification (the report's primary axis) ─────────────────────
//   mistake — confirmed, must-fix (spelling/typo, trading term, brand, meaning-
//             changing wrong word). Only these affect the score.
//   review  — AI is NOT sure: uncertain audio mismatch, progressive caption
//             split, OCR misread of stylized text, medium/low confidence.
//   style   — client/editor choice: capitalization, all-caps vs Title Case,
//             lowercase Hinglish openings, romanization variants, consistency.
const VALID_TIER = new Set(["mistake", "review", "style"]);
const TIER = {
  mistake: { label: "Actual Mistake",  short: "MISTAKE", color: "#ef4444" },
  review:  { label: "Needs Review",    short: "REVIEW",  color: "#f59e0b" },
  style:   { label: "Optional Style",  short: "STYLE",   color: "#94a3b8" },
};
// Capitalization / case / opening-word findings are STYLE, never a hard mistake.
function isCapitalizationFinding(it) {
  if (it && it.kind === "caps") return true;
  const m = `${it?.msg || ""} ${it?.why || ""}`.toLowerCase();
  return /capitaliz|capital letter|uppercase|lower ?case|all[- ]?caps|title case|sentence case|opening word|first word .*(capital|upper|lower)|should be capitalized|styling( treatment)?/.test(m);
}
// Single source of truth for a finding's tier. Works with OR without it.tier
// (so older saved reports re-sort correctly). Deterministic overrides win over
// the model's own tier so the user's specific complaints are always honored.
function issueTier(it) {
  if (!it) return "review";
  if (it.category === "creative_retention") return it.tier && VALID_TIER.has(it.tier) ? it.tier : "review";
  // 1) STYLE — capitalization, romanization variants, consistency, pure style
  if (it.kind === "consistency") return "style";
  if (isCapitalizationFinding(it)) return "style";
  if (isStyleVariant(it)) return "style";
  if (it.priority === "ignore") return "style";
  // 2) MISTAKE — a confirmed trading-term error always counts
  if (matchTradingTerm(it.captionText, `${it.msg || ""} ${it.fix || ""}`)) return "mistake";
  // 3) REVIEW — anything uncertain
  if (isOcrSuspect(it)) return "review";
  if (it.kind === "audio_mismatch") {
    const m = `${it.msg || ""} ${it.why || ""}`.toLowerCase();
    const uncertain = /missing|incomplete|omit|not spoken|does ?n.?t|word order|already shown|extra |only the|unclear/.test(m);
    return (uncertain || it.confidence !== "high") ? "review" : "mistake";
  }
  if (it.confidence === "low" || it.confidence === "medium") return "review";
  // 4) honor an explicit model tier of review/style if it set one
  if (it.tier === "review" || it.tier === "style") return it.tier;
  // 5) default — a high-confidence objective defect is a mistake
  if (it.priority === "required" || it.severity === "error") return "mistake";
  return "review";
}
const TIER_ORDER = { mistake: 0, review: 1, style: 2 };

// ── Devanagari scrubber ───────────────────────────────────────────────────────
// Output is LATIN HINGLISH ONLY, but Devanagari occasionally leaks into a field
// (most often audioText, e.g. "ऑफिशियल कन्फर्मेशन नहीं की है (official ... hai)").
// The prompt forbids it; this is the deterministic safety net. Strip the
// Devanagari run, keep the romanized remainder, and tidy the leftovers
// (empty quotes/parens, doubled spaces, space-before-punctuation).
function hasDevanagari(s) { return typeof s === "string" && /[ऀ-ॿ]/.test(s); }
function scrubDevanagari(s) {
  if (typeof s !== "string" || !hasDevanagari(s)) return s;
  return s
    .replace(/[ऀ-ॿ]+/g, "")
    .replace(/[“"'(]\s*[”")']/g, "")        // emptied quote/paren pairs
    .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")")
    .replace(/\s+([.,;:!?)])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Soft / non-actionable findings: the model admits the text matches the audio or
// is likely intentional, then raises a "verify…" concern. These are noise (the
// editor can't act on "verify intent"). Kept separate from isNonIssue so the two
// intents stay readable.
function isSoftNonActionable(it) {
  const m = `${it.msg || ""} ${it.why || ""} ${it.fix || ""}`.toLowerCase();
  return /matches (the )?audio but|text matches audio but|may be intentional|verify intent|confirm.*(stylistic|intent)|verify if .*(should|is )|intentional animation reveal|animation reveal or caption hold|missing subject|context from (the )?(prior|previous) frame|incomplete without the subject|while technically correct|technically correct,? but|stands out in a hinglish|consider consistency with/i.test(m);
}

// Style / romanization variants and pure formatting prefs never change meaning,
// so they are never "required" — cap them at "optional". Precise triggers only,
// so genuine English typos (e.g. "operationa"→"operations") are NOT downgraded.
function isStyleVariant(it) {
  const m = `${it.msg || ""} ${it.why || ""}`.toLowerCase();
  return /\bvariant\b|non[- ]standard|informal|stylistic|romaniz|abbreviat|missing vowel|double[- ]letter|single[- ]e\b|one word|single word|compound word|two words|split by a space|should be joined|word segmentation/i.test(m);
}

// ── Trading-domain glossary ───────────────────────────────────────────────────
// This is a trading-EDUCATION brand: terms like "breakout" are core vocabulary,
// not generic words, so a split / joined / mis-hyphenated trading term is a
// REQUIRED brand-accuracy fix — never optional. Used two ways:
//   1. injected into the prompt so the model knows the domain vocabulary; and
//   2. a deterministic ESCALATOR (matchTradingTerm) that forces a matched finding
//      to "required", overriding the style-variant downgrade — so these are caught
//      CONSISTENTLY, not at the model's run-to-run discretion.
// `bad` = wrong forms seen in captions; `good` = the canonical/approved spelling.
const TRADING_TERMS = [
  { good: "BREAKOUT",     bad: ["break out"] },
  { good: "BREAKDOWN",    bad: ["break down"] },
  { good: "FAKEOUT",      bad: ["fake out"] },
  { good: "PULLBACK",     bad: ["pull back"] },
  { good: "RETEST",       bad: ["re test", "re-test"] },
  { good: "TRENDLINE",    bad: ["trend line"] },
  { good: "CANDLESTICK",  bad: ["candle stick"] },
  { good: "N-SHAPE",      bad: ["n shape", "n=shape", "n =shape", "n= shape"] },
];
// Flat vocabulary the model must treat as KNOWN-correct domain terms — it must
// NOT "fix" one of these when it is already spelled correctly.
const TRADING_VOCAB = [
  "breakout", "breakdown", "fakeout", "pullback", "retest", "trendline",
  "candlestick", "candle", "wick", "support", "resistance", "entry", "target",
  "stoploss", "scalping", "swing", "price action", "N-SHAPE pattern", "PE", "CE",
];
// Returns the canonical term object when a finding is about a WRONG trading-term
// form — the bad form is visible in the caption AND the fix/headline proposes the
// canonical one (so a legit verb phrase like "break out of the range", with no
// "breakout" correction, does NOT escalate). Else null.
function matchTradingTerm(captionText, correctionText) {
  const cap = ` ${(captionText || "").toLowerCase().replace(/\s+/g, " ")} `;
  const corr = (correctionText || "").toLowerCase().replace(/\s+/g, " ");
  for (const t of TRADING_TERMS) {
    for (const b of t.bad) {
      const re = new RegExp(`(^|[^a-z0-9])${reEsc(b.toLowerCase())}([^a-z0-9]|$)`, "i");
      if (re.test(cap) && corr.includes(t.good.toLowerCase())) return t;
    }
  }
  return null;
}

const T = {
  bg:        "#0a0608",
  bgPanel:   "rgba(255,255,255,0.025)",
  border:    "rgba(255,255,255,0.07)",
  borderHot: "rgba(220,38,38,0.35)",
  red:       "#dc2626",
  redBright: "#ef4444",
  redDeep:   "#991b1b",
  redLight:  "#fca5a5",
  redTint:   "rgba(220,38,38,0.08)",
  // Purple/violet accent — reserved for Creative & Retention findings so they
  // visually separate from the red QC technical findings without breaking the
  // dark-mode brand.
  purple:       "#a855f7",
  purpleBright: "#c084fc",
  purpleLight:  "#e9d5ff",
  purpleTint:   "rgba(168,85,247,0.08)",
  borderPurple: "rgba(168,85,247,0.35)",
  textDim:   "rgba(255,255,255,0.4)",
  textMute:  "rgba(255,255,255,0.6)",
  gradient:  "linear-gradient(135deg,#dc2626,#7f1d1d)",
  gradientPurple: "linear-gradient(135deg,#a855f7,#6b21a8)",
  gradientText: "linear-gradient(90deg,#ef4444,#fca5a5)",
};

const SEV = {
  error:   { dot: "#ef4444", badge: "rgba(239,68,68,0.15)",   badgeText: "#fca5a5", border: "rgba(239,68,68,0.3)",  bg: "rgba(239,68,68,0.06)",  label: "ERROR"   },
  warning: { dot: "#f59e0b", badge: "rgba(245,158,11,0.15)",  badgeText: "#fcd34d", border: "rgba(245,158,11,0.3)", bg: "rgba(245,158,11,0.06)", label: "WARN"    },
  info:    { dot: "#10b981", badge: "rgba(16,185,129,0.15)",  badgeText: "#6ee7b7", border: "rgba(16,185,129,0.3)", bg: "rgba(16,185,129,0.06)", label: "INFO"    },
};

// Two top-level categories. qc_technical = objective mistakes (typos, grammar,
// safe-zone). creative_retention = performance/creative-direction suggestions
// (pacing, hooks, missing animation, b-roll suggestions). Each finding belongs
// to exactly one category and is shown in the matching tab on the results page.
const CATEGORIES = {
  qc_technical: {
    label: "QC Baseline",
    icon: "⚠️",
    accent: "#ef4444",
    accentTint: "rgba(239,68,68,0.1)",
    border: "rgba(239,68,68,0.3)",
    desc: "Objective errors — typos, grammar, alignment",
  },
  creative_retention: {
    label: "Creative & Retention",
    icon: "💡",
    accent: "#c084fc",
    accentTint: "rgba(168,85,247,0.1)",
    border: "rgba(168,85,247,0.35)",
    desc: "Performance ideas — hooks, pacing, animation",
  },
};
const VALID_CATEGORIES = new Set(Object.keys(CATEGORIES));

// One-click brief presets. The user can still freely edit after applying one.
const PRESETS = [
  {
    id: "everything",
    icon: "✨",
    label: "Check Everything",
    text: "Perform an exhaustive, multi-pass QC review. Scan frame-by-frame for any spelling typos (especially in English/Hinglish overlays), awkward grammar, cut-off text, and safe-zone violations.",
  },
  {
    id: "subtitles",
    icon: "✍️",
    label: "Subtitles Audit",
    text: "Strictly focus on burned-in captions. Check for double-letter typos, incorrect sentence structures, missing punctuation, and layout alignment errors.",
  },
  {
    id: "retention",
    icon: "🎬",
    label: "Retention Mode",
    text: "Act as a creative director. Audit the first 3 seconds for a strong hook. Flag any sections longer than 2.5 seconds without a text animation, zoom, or cut to keep retention high.",
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// 2. HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function fmtTs(sec) {
  if (sec == null || !isFinite(sec)) return "—";
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Sort issues chronologically; null timestamps sink to the bottom.
function sortByTs(list) {
  return [...list].sort((a, b) => {
    if (a.ts == null && b.ts == null) return 0;
    if (a.ts == null) return 1;
    if (b.ts == null) return -1;
    return a.ts - b.ts;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// LOCAL WORKSPACE — per-user login (localStorage) + scan history (IndexedDB)
// No backend: the current user's name lives in localStorage; each scan (metadata
// + findings + the video blob) is stored in IndexedDB so reports reopen WITH
// playback. Everything older than 7 days is purged. History is per-browser.
// ═════════════════════════════════════════════════════════════════════════════
const USER_KEY = "bbqc_user";
const IDB_NAME = "bbqc";
const IDB_STORE = "scans";
const SCAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // reports kept for 7 days

function loadUser() { try { return localStorage.getItem(USER_KEY) || ""; } catch { return ""; } }
function storeUser(name) { try { localStorage.setItem(USER_KEY, name); } catch { /* ignore */ } }
function clearStoredUser() { try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ } }
// Identity key: "sonu", "Sonu", "SONU", " soNu " all map to the SAME workspace.
function normalizeUser(name) { return (name || "").trim().replace(/\s+/g, " ").toLowerCase(); }

// ── QC MEMORY — per-user "learned corrections" (localStorage, no DB) ──────────
// Works exactly like a spell-checker's custom dictionary: a correction the editor
// teaches ONCE is injected into EVERY future scan's prompt (and, for the
// allow-list, enforced deterministically in code). Keyed by the SAME normalized
// identity as scans, so sonu / Sonu / SONU share one memory. Two lists:
//   • allow — words/phrases confirmed CORRECT → never flagged again ("Learn word")
//   • typos — wrong→right pairs the AI MISSED before → actively watched for
const MEMORY_KEY = "bbqc_memory";
const MEMORY_LIMIT = 200;                       // cap each list so the prompt stays small
const EMPTY_MEMORY = { allow: [], typos: [] };
function loadAllMemory() {
  try { return JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}") || {}; } catch { return {}; }
}
function loadMemory(user) {
  const m = loadAllMemory()[normalizeUser(user)] || {};
  return { allow: Array.isArray(m.allow) ? m.allow : [], typos: Array.isArray(m.typos) ? m.typos : [] };
}
function saveMemory(user, mem) {
  if (!user) return;
  try {
    const all = loadAllMemory();
    all[normalizeUser(user)] = {
      allow: (mem.allow || []).slice(-MEMORY_LIMIT),
      typos: (mem.typos || []).slice(-MEMORY_LIMIT),
    };
    localStorage.setItem(MEMORY_KEY, JSON.stringify(all));
  } catch { /* ignore quota */ }
}
function normTerm(s) { return (s || "").trim().toLowerCase(); }
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ── Admin (same-device) ───────────────────────────────────────────────────────
// Name-based gate, consistent with the name-only login. NOT real security — any
// device where someone logs in as "sonu" is admin on THAT browser. Harden later
// with a PIN if needed. Admin sees every scan stored in THIS browser's IndexedDB.
const ADMIN_USERS = new Set(["sonu"]);
function isAdmin(user) { return ADMIN_USERS.has(normalizeUser(user)); }

// ── QC feedback log (same-device; localStorage) ───────────────────────────────
// The model-improvement signal: every admin correction is appended here so QC
// quality can be reviewed and the glossary/memory tuned over time.
const FEEDBACK_KEY = "bbqc_feedback";
const FEEDBACK_LIMIT = 2000;
const FEEDBACK_TYPES = [
  { id: "confirmed",       label: "Correct issue",   color: "#10b981" },
  { id: "false_positive",  label: "False positive",  color: "#ef4444" },
  { id: "missed",          label: "Missed issue",    color: "#f59e0b" },
  { id: "wrong_severity",  label: "Wrong severity",  color: "#a855f7" },
  { id: "wrong_timestamp", label: "Wrong timestamp", color: "#0ea5e9" },
];
const FEEDBACK_LABEL = Object.fromEntries(FEEDBACK_TYPES.map((t) => [t.id, t]));
function loadFeedback() {
  try { const a = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function logFeedback(entry) {
  try {
    const all = loadFeedback();
    all.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), ...entry });
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(all.slice(-FEEDBACK_LIMIT)));
  } catch { /* ignore quota */ }
  return loadFeedback();
}
function clearFeedback() { try { localStorage.removeItem(FEEDBACK_KEY); } catch { /* ignore */ } }

// Deterministic allow-list guard: should this finding be suppressed because the
// editor already confirmed the word is correct? CONSERVATIVE on purpose — only
// touches "is this spelled/written right" kinds (never audio-mismatch / layout /
// creative), and only when an allowed term appears as a whole word in the caption.
// This means a real typo ("namsate") is still flagged even if "namaste" is allowed.
const ALLOWLIST_KINDS = new Set(["spelling", "grammar", "caps", "truncation", "consistency", "punctuation"]);
function isAllowlisted(issue, allow) {
  if (!issue || !allow || !allow.length) return false;
  if (issue.category === "creative_retention") return false;
  if (issue.kind && !ALLOWLIST_KINDS.has(issue.kind)) return false;
  const cap = normTerm(issue.captionText);
  if (!cap) return false;
  return allow.some((a) => {
    const t = normTerm(a.term);
    if (!t) return false;
    if (t.includes(" ")) return cap.includes(t);                         // phrase → substring
    return new RegExp(`(^|[^a-z0-9])${reEsc(t)}([^a-z0-9]|$)`, "i").test(cap); // word → whole-token
  });
}
function filterAllowlisted(issues, allow) {
  return (allow && allow.length) ? (issues || []).filter((i) => !isAllowlisted(i, allow)) : (issues || []);
}

function fmtDate(ms) {
  try { return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return "—"; }
}
function fmtClock(ms) {
  try { return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
  catch { return "—"; }
}
function daysLeft(ms) {
  return Math.max(0, Math.ceil((ms + SCAN_RETENTION_MS - Date.now()) / (24 * 60 * 60 * 1000)));
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const os = db.createObjectStore(IDB_STORE, { keyPath: "id" });
        os.createIndex("user", "user", { unique: false });
        os.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbTx(mode, fn) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const store = tx.objectStore(IDB_STORE);
    let out;
    const r = fn(store);
    if (r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => { db.close(); resolve(out); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}
const idbGetAll = () => idbTx("readonly", (s) => s.getAll());
const idbGet = (id) => idbTx("readonly", (s) => s.get(id));
const idbDelete = (id) => idbTx("readwrite", (s) => s.delete(id));

async function saveScan(rec) {
  try { await idbTx("readwrite", (s) => s.put(rec)); return true; }
  catch (e) {
    // Quota exceeded (big video blob) → retry report-only so history still works.
    if (rec.blob) { try { await idbTx("readwrite", (s) => s.put({ ...rec, blob: null })); return true; } catch { /* */ } }
    console.warn("[BB QC] could not save scan:", e?.message);
    return false;
  }
}

// Export the report as a print-ready page (user saves as PDF). Opens a SEPARATE
// window with its own clean stylesheet — the live web report is never touched.
// Issues are ordered pending-first, then Mistake → Needs Review → Optional Style.
function exportReportPDF({ fileName, issues, doneIds, durationSec, score }) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const done = doneIds || new Set();
  const counts = { mistake: 0, review: 0, style: 0, done: 0 };
  for (const i of issues) { if (done.has(i.id)) counts.done++; else counts[issueTier(i)]++; }
  const rows = [...issues].sort((a, b) => {
    const da = done.has(a.id) ? 1 : 0, db = done.has(b.id) ? 1 : 0;
    if (da !== db) return da - db;                                  // pending first
    const pa = TIER_ORDER[issueTier(a)], pb = TIER_ORDER[issueTier(b)];
    if (pa !== pb) return pa - pb;                                  // mistake → review → style
    return (a.ts ?? 1e9) - (b.ts ?? 1e9);
  }).map((i) => {
    const t = issueTier(i), isDone = done.has(i.id);
    const status = isDone ? "DONE" : TIER[t].short;
    const col = isDone ? "#16a34a" : TIER[t].color;
    return `<tr class="${isDone ? "done" : ""}">
      <td class="ts">${esc(fmtTs(i.ts))}</td>
      <td><span class="pill" style="background:${col}22;color:${col};border:1px solid ${col}66">${status}</span></td>
      <td>
        <div class="msg">${esc(i.msg)}</div>
        ${i.captionText ? `<div class="sub"><b>Caption:</b> “${esc(i.captionText)}”</div>` : ""}
        ${i.audioText ? `<div class="sub"><b>Voiceover:</b> “${esc(i.audioText)}”</div>` : ""}
        ${i.why ? `<div class="sub"><b>Why:</b> ${esc(i.why)}</div>` : ""}
        ${i.fix ? `<div class="fix"><b>Fix:</b> ${esc(i.fix)}</div>` : ""}
      </td>
    </tr>`;
  }).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>QC Report — ${esc(fileName)}</title>
  <style>
    *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;margin:0;padding:32px}
    h1{font-size:22px;margin:0 0 4px} .meta{color:#666;font-size:12px;margin-bottom:18px}
    .cards{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
    .card{border:1px solid #e5e5e5;border-radius:10px;padding:10px 16px;min-width:84px}
    .card .n{font-size:22px;font-weight:800} .card .l{font-size:11px;color:#666}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{text-align:left;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #eee;padding:8px}
    td{border-bottom:1px solid #f0f0f0;padding:10px 8px;vertical-align:top}
    td.ts{font-family:monospace;color:#444;white-space:nowrap;width:48px}
    .pill{font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;white-space:nowrap}
    .msg{font-weight:600;margin-bottom:3px} .sub{color:#555;margin-top:2px} .fix{color:#b91c1c;margin-top:2px}
    tr.done{opacity:.5} tr.done .msg{text-decoration:line-through}
    @media print{body{padding:0}}
  </style></head><body>
    <h1>QC Report</h1>
    <div class="meta">${esc(fileName)} · ${esc(fmtTs(durationSec))} · ${issues.length} findings · generated ${new Date().toLocaleString()}</div>
    <div class="cards">
      <div class="card"><div class="n">${score}</div><div class="l">Score</div></div>
      <div class="card"><div class="n" style="color:#ef4444">${counts.mistake}</div><div class="l">Actual Mistakes</div></div>
      <div class="card"><div class="n" style="color:#f59e0b">${counts.review}</div><div class="l">Needs Review</div></div>
      <div class="card"><div class="n" style="color:#94a3b8">${counts.style}</div><div class="l">Optional Style</div></div>
      <div class="card"><div class="n" style="color:#16a34a">${counts.done}</div><div class="l">Done</div></div>
    </div>
    <table><thead><tr><th>Time</th><th>Status</th><th>Issue</th></tr></thead><tbody>${rows}</tbody></table>
    <script>window.onload=function(){setTimeout(function(){window.print();},300);};</script>
  </body></html>`;

  const w = window.open("", "_blank");
  if (!w) { alert("Please allow pop-ups for this site to export the PDF report."); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

// List a user's scans (newest first) and purge anything past the 7-day window.
async function listUserScans(user) {
  let all = [];
  try { all = await idbGetAll(); } catch { return []; }
  const cutoff = Date.now() - SCAN_RETENTION_MS;
  for (const r of all) if (r.createdAt < cutoff) { try { await idbDelete(r.id); } catch { /* */ } }
  const key = normalizeUser(user);
  return all
    .filter((r) => r.createdAt >= cutoff && normalizeUser(r.user) === key)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ADMIN: every scan in THIS browser (all users), newest first. Purges expired.
async function listAllScans() {
  let all = [];
  try { all = await idbGetAll(); } catch { return []; }
  const cutoff = Date.now() - SCAN_RETENTION_MS;
  for (const r of all) if (r.createdAt < cutoff) { try { await idbDelete(r.id); } catch { /* */ } }
  return all.filter((r) => r.createdAt >= cutoff).sort((a, b) => b.createdAt - a.createdAt);
}

// Pending Mistake / Review / Style counts for a saved report (excludes items the
// editor already marked done). Derives from the stored issues + doneIds via the
// tier classifier, so older reports re-sort into the new tiers automatically.
function scanTierCounts(rec) {
  const done = new Set(rec.doneIds || []);
  const c = { mistake: 0, review: 0, style: 0, done: 0 };
  for (const it of rec.issues || []) {
    if (done.has(it.id)) { c.done++; continue; }
    c[issueTier(it)]++;
  }
  return c;
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. ANALYSIS PIPELINE
//
// This section was previously in src/videoAnalysis.js. Inlined here to keep
// everything in one file per the workflow request.
// ═════════════════════════════════════════════════════════════════════════════

// Seek a <video> element to a specific time and resolve when 'seeked' fires.
function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      video.removeEventListener("seeked", onSeeked);
      reject(new Error("Seek timeout"));
    }, 5000);
    const onSeeked = () => {
      clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.05));
  });
}

/**
 * Extract N evenly-spaced frames from a video file as base64 JPEGs.
 *
 * RULE 1 of this build: timestamps are INTEGER SECONDS captured from
 * video.currentTime AFTER each seek completes. We round DOWN (floor)
 * rather than to-nearest so the first frame (currentTime ≈ 0.0) reliably
 * lands on second 0, not second 1.
 *
 * The first sample point is forced to t = 0 so the very opening frame is
 * always part of the analysis — title cards live there.
 */
async function extractFrames(file, coverageFps = COVERAGE_FPS, onProgress = () => {}) {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Video metadata timeout — browser may not support this format")),
      15000
    );
    video.onloadedmetadata = () => { clearTimeout(timeout); resolve(); };
    video.onerror = () => { clearTimeout(timeout); reject(new Error("Browser could not decode this video file")); };
  });

  const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : 60;

  // Downscale to MAX_FRAME_WIDTH. Higher resolution = better OCR on small/
  // stylized text but more tokens/cost. Small batches let us keep this high.
  const scale = video.videoWidth > MAX_FRAME_WIDTH ? MAX_FRAME_WIDTH / video.videoWidth : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext("2d");

  // ── DENSE sampling ──────────────────────────────────────────────────────
  // Sample COVERAGE_FPS frames per second so every distinct on-screen text
  // state is captured (capped at MAX_TOTAL_FRAMES for very long videos). The
  // first sample is forced to t=0 and the last lands near the end; the rest
  // are evenly spaced. Timestamps are kept at sub-second (2-decimal) precision
  // so frames within the same second stay distinct.
  const idealFrames = Math.ceil(duration * (coverageFps || COVERAGE_FPS));
  const targetFrames = Math.max(8, Math.min(MAX_TOTAL_FRAMES, idealFrames));
  const lastTs = Math.max(0.1, duration - 0.2);
  const requestedTimestamps = [];
  if (targetFrames === 1) {
    requestedTimestamps.push(0);
  } else {
    for (let i = 0; i < targetFrames; i++) {
      requestedTimestamps.push((lastTs * i) / (targetFrames - 1));
    }
  }

  // ── DETERMINISTIC capture ───────────────────────────────────────────────────
  // Label every frame with its FIXED TARGET timestamp (rounded to 2 decimals),
  // NOT the decoder-snapped video.currentTime. The snapped value drifts slightly
  // each run (decode timing), which changed the frame set and made the SAME video
  // produce DIFFERENT findings run-to-run. A fixed grid + fixed labels makes the
  // frame set identical on every run → far more consistent QC output.
  const frames = [];
  for (let i = 0; i < requestedTimestamps.length; i++) {
    const target = Math.max(0, Math.round(requestedTimestamps[i] * 100) / 100);
    onProgress({ phase: "extracting", current: i + 1, total: requestedTimestamps.length });
    try {
      await seekTo(video, target);
      // Wait for the decoded frame to actually paint before grabbing it.
      await new Promise(r => setTimeout(r, 80));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY);
      frames.push({ ts: target, data: dataUrl.split(",")[1] });
    } catch (e) {
      console.warn(`Frame at ${target.toFixed(2)}s failed:`, e.message);
    }
  }

  URL.revokeObjectURL(url);
  video.remove();

  if (frames.length === 0) throw new Error("Could not extract any frames from video");
  return { frames, duration };
}

// ── AUDIO → SPEECH-TO-TEXT (ElevenLabs Scribe) ───────────────────────────────
// Decode the file's audio to mono 16kHz in the browser, chunk it (Vercel 4.5MB
// body cap), and transcribe each chunk through the /api/elevenlabs proxy.
// Returns { text, words:[{text,start}] } with ABSOLUTE timestamps, or null if the
// file has no decodable audio track (we then just skip the audio cross-check).
async function decodeToMono(file, targetRate) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const arrayBuf = await file.arrayBuffer();
  const tmp = new AC();
  let decoded;
  try { decoded = await tmp.decodeAudioData(arrayBuf.slice(0)); }
  finally { try { tmp.close(); } catch { /* ignore */ } }
  const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, length, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();   // mono AudioBuffer @ targetRate
}

// Encode a Float32 sample array as a 16-bit PCM mono WAV Blob.
function encodeWavMono(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); ws(8, "WAVE"); ws(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ws(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

async function transcribeAudio(file, signal, onProgress = () => {}) {
  let rendered;
  try { rendered = await decodeToMono(file, AUDIO_SAMPLE_RATE); }
  catch (e) { console.warn("[BB QC] audio decode failed (skipping STT):", e.message); return null; }
  if (!rendered) return null;

  const sr = AUDIO_SAMPLE_RATE;
  const all = rendered.getChannelData(0);
  const chunkLen = AUDIO_CHUNK_SEC * sr;
  const nChunks = Math.max(1, Math.ceil(all.length / chunkLen));
  const words = [];
  let fullText = "";

  for (let c = 0; c < nChunks; c++) {
    if (signal?.aborted) break;
    const start = c * chunkLen;
    const slice = all.subarray(start, Math.min(all.length, start + chunkLen));
    const offsetSec = start / sr;
    const wav = encodeWavMono(slice, sr);

    const fd = new FormData();
    fd.append("model_id", STT_MODEL);
    fd.append("file", wav, `audio_${c}.wav`);
    try {
      const res = await fetch(STT_URL, { method: "POST", body: fd, signal });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.warn(`[BB QC] STT chunk ${c} failed ${res.status}: ${t.slice(0, 160)}`);
        continue;
      }
      const data = await res.json();
      if (data.text) fullText += (fullText ? " " : "") + data.text;
      for (const w of data.words || []) {
        if (w.type && w.type !== "word") continue;
        if (typeof w.text !== "string" || !w.text.trim()) continue;
        words.push({ text: w.text, start: (Number(w.start) || 0) + offsetSec });
      }
    } catch (e) {
      if (e.name === "AbortError") break;
      console.warn(`[BB QC] STT chunk ${c} error:`, e.message);
    }
    onProgress({ current: c + 1, total: nChunks });
  }

  if (!fullText && words.length === 0) return null;
  return { text: fullText.trim(), words };
}

// Build a compact, timestamped transcript string for the prompt, limited to the
// [loTs, hiTs] window (± 1s slack) so each batch only sees the audio overlapping
// its frames. Lines look like: "[m:ss] word word word…".
function transcriptWindow(transcript, loTs, hiTs) {
  if (!transcript) return "";
  const lo = loTs - 1, hi = hiTs + 1;
  const ws = (transcript.words || []).filter((w) => w.start >= lo && w.start <= hi);
  if (ws.length === 0) {
    return transcript.text && transcript.text.length < 600 ? transcript.text : "";
  }
  const lines = [];
  for (let i = 0; i < ws.length; i += 10) {
    const group = ws.slice(i, i + 10);
    lines.push(`[${fmtTs(group[0].start)}] ${group.map((w) => w.text).join(" ")}`);
  }
  return lines.join("\n");
}

/**
 * Send extracted frames to Claude with the strict QC prompt.
 *
 * Rules 2, 3, 4 of this build are enforced here:
 *   • Each frame is prefixed with a [FRAME_METADATA] text block holding the
 *     locked index + timestamp. The prompt forbids any modification.
 *   • Reference brief is injected verbatim into a dedicated prompt section
 *     when non-empty.
 *   • temperature=0 + an EXHAUSTIVE-PASS PROTOCOL section in the prompt
 *     mandate the same scanning routine every run.
 */

// Abort-aware sleep used by the retry backoff.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
    const cleanup = () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); };
    signal?.addEventListener("abort", onAbort);
  });
}

// POST to the messages API, retrying transient failures (429 rate-limit, 5xx,
// 504 Vercel-function-timeout, network blips) with exponential backoff that
// honours the server's Retry-After header. This is THE fix for silently
// dropped batches: a rate-limited call now waits and retries instead of
// vanishing. Throws on a non-retryable error or once retries are exhausted, so
// the caller can count the failure rather than pretend it found nothing.
async function postMessages(body, signal, maxRetries = BATCH_MAX_RETRIES) {
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (attempt >= maxRetries) throw e;       // network error — retry
      await sleep(Math.min(1000 * 2 ** attempt, 20000) + Math.round(attempt * 137), signal);
      attempt++;
      continue;
    }

    if (res.ok) return res;

    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      const retryAfter = parseFloat(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(1500 * 2 ** attempt, 30000) + Math.round(attempt * 137);
      await sleep(waitMs, signal);
      attempt++;
      continue;
    }
    return res; // non-retryable, or out of retries — caller surfaces the error
  }
}

async function analyzeFrames(frames, duration, signal, referenceBrief = "", pass = "technical", opts = {}) {
  if (!frames || frames.length === 0) throw new Error("No frames to analyze");

  const model = opts.model || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens || 4096;
  const briefClean = (referenceBrief || "").trim();
  const hasBrief = briefClean.length > 0;
  const isCreative = pass === "creative";
  const transcript = opts.transcript || null;
  const captionScope = opts.captionScope === "all" ? "all" : "captions"; // default: captions only
  const memRaw = opts.memory || null;
  const memory = (!isCreative && memRaw && ((memRaw.allow?.length || 0) + (memRaw.typos?.length || 0) > 0)) ? memRaw : null;
  const loTs = frames[0]?.ts ?? 0;
  const hiTs = frames[frames.length - 1]?.ts ?? loTs;
  const audioText = (!isCreative && transcript) ? transcriptWindow(transcript, loTs, hiTs) : "";

  // VOLATILE — which text gets QC'd this pass. Kept in the USER message so the
  // big static system block stays byte-identical and prompt-cache-stable.
  const scopeBlock = captionScope === "all"
    ? `═══════════════════════════════════════════════════════════════════════════
TEXT SCOPE FOR THIS PASS = ALL ON-SCREEN TEXT (user opted in)
═══════════════════════════════════════════════════════════════════════════
Check EVERY visible piece of text — captions/subtitles AND incidental in-shot text
(iPad/notebook handwriting, whiteboard, slide/document, app UI, charts, signage).
Set "textSource" correctly on each finding ("caption" or "visual").`
    : `═══════════════════════════════════════════════════════════════════════════
TEXT SCOPE FOR THIS PASS = CAPTIONS / SUBTITLES ONLY (default)
═══════════════════════════════════════════════════════════════════════════
Evaluate ONLY intentional caption / subtitle / title-card overlays. IGNORE
incidental in-shot text — handwriting on an iPad or notebook, whiteboard or rough
planning notes, slide / document text, app or website UI, chart labels, and
background signage. Do NOT emit ANY finding (spelling, grammar, punctuation,
capitalization, or audio mismatch) on that text — unless the audit instructions
below explicitly ask for it. Every finding you DO emit must have
"textSource": "caption". See the SCOPE GUARD rule in the system instructions.`;

  // VOLATILE — the editor's learned corrections (allow-list + known typos). Kept
  // in the USER message so the cached system block stays byte-identical. Functions
  // like a spell-checker's custom dictionary fed back to the model every scan.
  const memoryBlock = memory ? `═══════════════════════════════════════════════════════════════════════════
EDITOR'S LEARNED CORRECTIONS — AUTHORITATIVE, APPLY ON EVERY PASS
═══════════════════════════════════════════════════════════════════════════
The editor has manually corrected this QC system before. Honor it exactly.${memory.allow?.length ? `

ALWAYS-CORRECT TEXT — confirmed correct by the editor. Treat these EXACTLY like
dictionary words: NEVER flag them as spelling / grammar / typo errors, even inside
Hinglish. (A genuinely different misspelling of the same word is still an error.)
${memory.allow.map((a) => `  • "${a.term}"${a.note ? ` — ${a.note}` : ""}`).join("\n")}` : ""}${memory.typos?.length ? `

KNOWN MISTAKES TO CATCH — the editor reported these were MISSED in earlier scans.
If the WRONG (left) form appears on screen, you MUST flag it as an "error" and give
the right (corrected) form as the fix:
${memory.typos.map((t) => `  • "${t.wrong}" → "${t.right}"`).join("\n")}` : ""}` : "";

  // ── PASS DIRECTIVE ──────────────────────────────────────────────────────────
  // VOLATILE — tells the model which job THIS call is doing. Lives in the USER
  // message, never in the cached system block (req #4).
  const directive = isCreative
    ? `═══════════════════════════════════════════════════════════════════════════
THIS PASS = CREATIVE / RETENTION ONLY
═══════════════════════════════════════════════════════════════════════════
These frames are evenly sampled across the ENTIRE video so you can judge pacing,
hooks and retention holistically. For THIS pass, emit ONLY "creative_retention"
findings (pacing, hook strength, CTA, visual variety). Do NOT emit spelling/
grammar/typo/safe-zone findings — a separate exhaustive text pass handles those.`
    : `═══════════════════════════════════════════════════════════════════════════
THIS PASS = TECHNICAL TEXT QC ONLY
═══════════════════════════════════════════════════════════════════════════
These frames are a small CONSECUTIVE SLICE of a longer video being scanned
exhaustively. For THIS pass, emit ONLY objective "qc_technical" findings
(spelling, repeated-letter typos, grammar, punctuation, capitalization, line
breaks, layout/safe-zone, visual artifacts, consistency). Do NOT comment on
pacing, hooks, retention or whole-video creative direction — a separate creative
pass handles that. Scan every word in every frame.`;

  // ── Content array ─────────────────────────────────────────────────────────
  // content[0] = VOLATILE per-call header (directive + frame count + duration +
  // optional user brief). Frames are appended after it. The big STATIC ruleset
  // goes in `system` below so it is cached, not re-sent, on every batch (req #4).
  const content = [];
  content.push({
    type: "text",
    text: `${directive}

${scopeBlock}${memoryBlock ? `

${memoryBlock}` : ""}

You will receive a sequence of ${frames.length} frames (video total duration ${Math.round(duration)} seconds). Each frame is immediately preceded by a [FRAME_METADATA] block containing its locked frame index and timestamp — copy them verbatim.${hasBrief ? `

═══════════════════════════════════════════════════════════════════════════
USER-PROVIDED AUDIT INSTRUCTIONS — CROSS-REFERENCE STRICTLY
═══════════════════════════════════════════════════════════════════════════
Cross-reference every frame against these instructions IN ADDITION to every
standard QC rule. If the user indicates a number of errors, or that errors
definitely exist, do an exhaustive, highly rigorous pass — re-read every frame
and keep scanning until every defect is catalogued. Choose the right category
per the brief (creative direction / retention / hooks / pacing → creative_retention;
typos / grammar / specific words → qc_technical; both → split). Wrong prices,
names or dates → "error", qc_technical. Tone/phrasing deviations → "warning",
qc_technical. In the "fix" field, explicitly reference the user's instruction.

THE USER'S INSTRUCTIONS (authoritative for this video):
<user_instructions>
${briefClean}
</user_instructions>` : ""}${audioText ? `

═══════════════════════════════════════════════════════════════════════════
AUDIO TRANSCRIPT (voiceover — speech-to-text, THIS time window)
═══════════════════════════════════════════════════════════════════════════
What the VOICEOVER actually says, time-aligned. It may be Hindi (Devanagari) or
romanized and may contain minor ASR errors. Use it ONLY for the AUDIO vs
ON-SCREEN TEXT cross-check described in the rules.

${audioText}` : ""}`,
  });

  // ── STATIC instruction block (cached) ───────────────────────────────────────
  // Identical bytes on every call → prompt-cache hit after the first write
  // (req #4). NO per-call variables in here. (The glossary lines below are built
  // from module-level constants, so the bytes are still identical every call.)
  const tradingRules = TRADING_TERMS.map((t) => `  • "${t.bad.join('" / "')}" → "${t.good}"`).join("\n");
  const tradingVocabLine = TRADING_VOCAB.join(", ");
  const systemText = `You are an eagle-eyed Post-Production QC Specialist for SOCIAL MEDIA video content — reels, shorts, brand promos, real-estate spots, paid-social ads. Your reviewers are CD-level finicky. Editors send you their export expecting you to catch every text mistake they missed at 2am during their final render.

The user message states which pass this is (technical text QC, or creative / retention) and how many frames you are receiving. Each frame is immediately preceded by a [FRAME_METADATA] block containing its locked frame index and timestamp.

═══════════════════════════════════════════════════════════════════════════
LANGUAGE OF OUTPUT — LATIN HINGLISH ONLY (ABSOLUTE)
═══════════════════════════════════════════════════════════════════════════
Every finding ("msg" and "fix") MUST be written in LATIN script only. NEVER
output Devanagari / Hindi characters anywhere — no शब्दों, no फॉरेक्स, no
मज़बूत, none. Always transliterate Hindi to Latin Hinglish instead:
  • शब्दों → "shabdon"    • फॉरेक्स → "forex"    • मज़बूत → "mazboot"
  • नींव → "neev"         • रिज़र्व → "reserves"  • माने → "maane"
This applies to quoting the AUDIO too: write what the voiceover says in Latin
Hinglish, never in Devanagari. A finding that contains any Devanagari character
is INVALID.

═══════════════════════════════════════════════════════════════════════════
TIMESTAMP RULE — NON-NEGOTIABLE
═══════════════════════════════════════════════════════════════════════════
Each frame has a hardcoded, designated timestamp metadata property in its
[FRAME_METADATA] block. You are STRICTLY FORBIDDEN from estimating,
modifying, calculating, or guessing any timestamp.

Your JSON response MUST use the exact, identical timestamp provided in the
[FRAME_METADATA] block of the frame where the issue is visually captured.
Copy it verbatim from the metadata. If [FRAME_METADATA] says "timestamp=12.33",
your JSON's "timestamp" field for any finding in that frame is exactly 12.33.
Do not round it, do not change it — copy the exact value, decimals and all.

Also include the frameIndex from the metadata block, verbatim, for every
finding. The pair (frameIndex, timestamp) must match an actual metadata
block you were given — do not invent combinations.

═══════════════════════════════════════════════════════════════════════════
LANGUAGES YOU MUST SCAN — ESPECIALLY HINGLISH
═══════════════════════════════════════════════════════════════════════════
A lot of the content is HINGLISH (Hindi in English script — "Jab palm
Jebel Ali complete hoga", "Studio start karenge", "Maan lo koi", "Entry
kaise milegi"). Scan Hinglish text with EXACTLY the same rigor as English.

Critical: an English-spelled word inside a Hinglish sentence MUST still
be spelled correctly in English. If the line is "Jab palm Jebel Ali
compaaaete hoga", "compaaaete" is an English misspelling of "complete"
and you flag it — the surrounding Hinglish does NOT excuse it.

═══════════════════════════════════════════════════════════════════════════
CAPTION / SUBTITLE TEXT vs INCIDENTAL VISUAL TEXT — SCOPE GUARD (READ FIRST)
═══════════════════════════════════════════════════════════════════════════
A frame often contains text that is NOT a caption: handwriting on an iPad or
notebook, whiteboard notes, rough planning text, slide / PDF / document text,
app or website UI, chart labels, product packaging, and background signage. This
is part of the VISUAL CONTENT being filmed — it is NOT the subtitle/caption layer
the editor burned in for the viewer, and it is usually rough by nature.

The USER MESSAGE states the TEXT SCOPE for this pass:
  • "captions only" (DEFAULT) → evaluate ONLY intentional caption / subtitle /
    title-card overlays. Do NOT treat handwriting, iPad / notebook writing,
    whiteboard content, slide / document text, app UI text, chart labels, or
    background text as a QC error — say NOTHING about it (no spelling, grammar,
    punctuation, capitalization, or audio-mismatch finding on incidental text),
    UNLESS the user's audit instructions explicitly ask you to check that text.
  • "all on-screen text" → evaluate every visible piece of text in the frame.

HOW TO TELL A CAPTION APART (use these cues):
  • Placement — captions sit as a dedicated lower-third / center overlay band, or
    a styled title card; not handwritten inside a device or on paper.
  • Styling — captions use a consistent edit font / box / stroke / shadow added in
    post; incidental text wears the native look of its surface (handwriting, a UI
    font, a slide template, printed packaging).
  • Source — if the text lives INSIDE a filmed object (an iPad screen, a notebook
    page, a whiteboard, a laptop window, a poster), it is incidental visual text.
  • Intent — a caption restates / supports the voiceover for the viewer;
    incidental text is just whatever happened to be in the shot.
When genuinely unsure, and the text is NOT a clean lower-third / title overlay,
default to treating it as incidental and do NOT flag it — this is what prevents
rough notes and explanation text from becoming false errors.

For every finding, set "textSource": "caption" for caption / subtitle / title
overlay text, or "visual" for incidental in-shot text. In "captions only" scope
you should normally emit ZERO "visual" findings.

═══════════════════════════════════════════════════════════════════════════
REPEATED-LETTER TYPOS — FLAG THE REAL ONES, NOT OCR MISREADS
═══════════════════════════════════════════════════════════════════════════
A word with 3+ consecutive identical letters is normally a typo — flag it:

  • "Stuudio"       → "Studio"
  • "Exxxxpo"       → "Expo"
  • "laaaaunch"     → "launch"
  • "compaaaete"    → "complete"
  • "Receeive"      → "Receive"
  • "Buuuilding"    → "Building"

BUT — READ THE TEXT, DO NOT HALLUCINATE A DOUBLED LETTER. Stylized overlay text
(bold, white-outlined, drop-shadow, italic, motion/compression blur) is easily
MISREAD, and an extra repeated letter is the #1 OCR artifact: "PATTERN" read as
"PATTTERN", "ENTRY" as "ENTTRY". Before flagging a repeated-letter typo:
  • Read the simplest correctly-spelled word the glyphs could be. If the text is
    plausibly a normal correctly-spelled word (PATTERN, ENTRY, TARGET, BREAKOUT),
    that is almost certainly what it says — do NOT invent an extra letter.
  • Only flag if the extra letter is UNMISTAKABLE and clearly visible. If a letter
    is just bold/blurred/outlined and you are not certain it is genuinely repeated,
    treat the word as correct and emit NOTHING.
  • When you do flag one on a stylized caption and any doubt remains, set
    confidence "medium" (not "high") so it is verified before it counts as an error.
Minimum severity for a confirmed repeated-letter typo: "warning"; "error" only
when the doubled letter is unambiguous AND the intended word is obvious.

═══════════════════════════════════════════════════════════════════════════
AUDIO vs ON-SCREEN TEXT CROSS-CHECK
═══════════════════════════════════════════════════════════════════════════
When the user message includes an AUDIO TRANSCRIPT, it is what the voiceover
actually says (speech-to-text, time-aligned). Use it to catch captions that
contradict the spoken word.

STEP 1 — NORMALIZE: the transcript may be in Hindi (Devanagari) or romanized,
while the on-screen captions are usually romanized Hinglish (or English).
Mentally transliterate the transcript into the SAME script/register as the
caption so the two are comparable (e.g. "मज़बूत" ≈ "mazboot", "नींव" ≈ "neev").

STEP 2 — COMPARE each caption against the time-aligned audio. Flag a finding
ONLY when a caption word is a REAL but WRONG word that does not match what the
audio says AND the difference changes meaning. The classic case:
  • audio says "mazboot" (strong) but the caption reads "mazboor" (forced) →
    "error". msg format: Audio mismatch: caption "mazboor" but voiceover says
    "mazboot" → "mazboot". Use checkId "grammar", severity "error".

ONLY FLAG SUBSTITUTIONS — never "missing" text:
  • Flag ONLY a wrong/substituted word that IS visible on screen (mazboor for
    mazboot). NEVER flag because the caption shows LESS than the audio, is
    "incomplete", "does not progress", or is "missing" the rest of the spoken
    phrase. Captions reveal PROGRESSIVELY and LAG behind the voiceover — the
    remaining words appear in LATER frames that THIS slice cannot see.
  • A caption that shows a correct SUBSET of what the audio says is CORRECT.
  • You only see a few frames — NEVER claim a caption "does not progress" or
    "does not show X in any frame". You cannot know what the other frames show.

BE CONSERVATIVE — speech-to-text is imperfect and timing can drift:
  • Do NOT flag normal Hinglish spelling variants, filler words, or rephrasings
    that don't change meaning.
  • Do NOT flag when the audio is unclear or simply worded differently.
  • If NO AUDIO TRANSCRIPT is provided, skip this section entirely.

═══════════════════════════════════════════════════════════════════════════
HINGLISH PHONETIC CONFUSIONS — CHECK THESE EVERY TIME
═══════════════════════════════════════════════════════════════════════════
These near-identical Hinglish pairs change MEANING. Whenever the caption shows
the LEFT-type form, confirm it against the audio/context — if the right form is
intended, flag it (kind "audio_mismatch" if the audio confirms it, else
"spelling"; severity "error" when meaning clearly flips):
  • mazboor (forced/helpless)   vs  mazboot (strong)
  • mane (accepted)             vs  maane (meaning / "are considered")
  • niv / niw                   vs  neev (foundation)
  • hai (is, singular)          vs  hain (are, plural)
  • pesa                        vs  paisa (money)
  • saal (year)                 vs  sahal/sal  (verify intent)
  • karo                        vs  karoge / karenge (tense/person)
  • bina (without)              vs  bin / binaa  (verify intent)
This is a checklist, NOT the limit — any meaning-changing Hinglish homophone
counts. Apply it identically on every run for consistent results.

═══════════════════════════════════════════════════════════════════════════
TRADING TERMINOLOGY — DOMAIN GLOSSARY (HIGHEST PRIORITY)
═══════════════════════════════════════════════════════════════════════════
This is a TRADING-EDUCATION brand. Trading terms are core brand vocabulary, NOT
generic words — a split, joined, or mis-hyphenated trading term is a professional
accuracy error the editor MUST fix. Scan EVERY caption (including big stylized
title overlays — a caps title is still a caption) for these, with zero tolerance.

CANONICAL SPELLINGS — if a caption shows the LEFT (wrong) form, flag the RIGHT one:
${tradingRules}

For ANY trading-term error like the above, emit the finding as:
  • checkId "grammar", kind "spelling"
  • severity "error", confidence "high", priority "required"  ← NEVER "optional"
  • msg:  Trading terminology error: caption "<wrong>" should be "<correct>"
  • why:  "<correct>" is the standard trading term; the wrong form looks
          unprofessional / can change the meaning.
  • fix:  Change "<wrong>" to "<correct>"
These are NOT optional polish — they are required brand-accuracy fixes and are the
single most important thing this QC pass catches.

KNOWN-CORRECT TERMS — treat these as a dictionary; do NOT "fix" one that is already
spelled correctly: ${tradingVocabLine}.
("PE" = put option, "CE" = call option — both correct as-is. "Breakout pe" /
"Breakout PE" is correct: one word "breakout" + the term/particle.)

═══════════════════════════════════════════════════════════════════════════
OTHER DEFECTS TO CATCH
═══════════════════════════════════════════════════════════════════════════
1. Spelling — missing/extra/transposed letters, homophones, wrong-word
   substitutions ("there"/"their"). INCLUDING context-driven near-homophone
   typos: a word spelled as a real but WRONG word that the surrounding meaning
   rules out — e.g. "mazboor" (forced/helpless) where "mazboot" (strong) is
   clearly intended in "mazboor neev hote hain" → "mazboot neev" (a foundation
   is strong, not forced). Flag as "error" and give the corrected word. (This
   tool sees only the on-screen TEXT, not the audio — judge intent from the
   meaning of the visible sentence.)
2. Grammar — ONLY within a single, clearly COMPLETE on-screen sentence:
   subject-verb disagreement, wrong tense, genuine run-on captions. Do NOT
   flag a caption for being a fragment, "incomplete", or "missing a verb /
   subject / predicate" — kinetic captions reveal text a word/phrase at a
   time, so a single frame showing "control", "Using", or "it allows you" is
   an ANIMATION STATE, not a grammar error. See DO NOT FLAG.
3. Punctuation — missing terminal punctuation, missing commas, stray
   or doubled punctuation.
4. Capitalization — inconsistent across frames, random mid-word capitals,
   ALL CAPS where Title Case was intended.
5. Line breaks — within a complete caption, text broken at an awkward point
   (an article split from its noun). Do NOT treat an animated single-word
   reveal as a widow/orphan.
6. Layout — text touching/crossing the title-safe boundary (outer 5%),
   text overlapping other graphics, illegible from low contrast.
7. Consistency — same word or brand spelled/styled differently across
   frames within this video.
8. Word segmentation — a single compound word that has been SPLIT by a space,
   or two words wrongly JOINED. This catches stylized titles where each token
   is individually a real word so the spell-check above does NOT fire:
     • "BREAK OUT PE"  → "BREAKOUT PE"   (breakout is one noun)
     • "log in" (noun) → "login"   • "set up" (noun) → "setup"
     • "Followus"      → "Follow us"  (wrongly joined)
   Apply this to styled centre-screen / title-card overlays too — a big
   decorative caps title is still a caption and IS in scope. BE CONSERVATIVE:
   only flag when the joined/split form is clearly the correct one in context.
   This is a polish issue, not a hard error: kind "spelling", confidence
   "medium" (or "low" if it might be a deliberate style choice), priority
   "optional" — NEVER "required". A genuine verb phrase ("break out of the
   range") is correct as two words — do not flag it.

═══════════════════════════════════════════════════════════════════════════
DO NOT FLAG
═══════════════════════════════════════════════════════════════════════════
• Verified brand names and place names ("Jebel Ali", "Dubai", "Expo City",
  "Raw District"). When in doubt about a proper noun, do not flag.
• Hinglish words spelled correctly for Hinglish ("hoga", "kaise", "mein",
  "karenge", "Maan lo") — these are the register, not typos.
• Clearly intentional stylistic choices (artistic kerning, decorative
  all-caps for emphasis on a single word).
• ANIMATION FRAGMENTS — THE #1 FALSE POSITIVE, ZERO TOLERANCE. Captions in
  this content animate IN and OUT one word or phrase at a time, so any single
  frame can show a PARTIAL sentence ("control", "Using", "Using PropFirm
  Leverage", "it allows you", "capital."). This is normal editing, never an
  error. NEVER emit a finding whose point is that the text is an "incomplete
  sentence", "sentence fragment", "standalone word", "missing subject / verb /
  predicate / object", "missing context or continuation", or that it "needs a
  complete clause". Only flag a defect that is WRONG INSIDE THE VISIBLE TEXT
  ITSELF: a misspelling, a repeated-letter typo, a wrong/near-homophone word,
  broken punctuation inside an otherwise-complete line, or a safe-zone/layout
  problem. A word that looks truncated mid-word (e.g. "econo" for "economy") is
  usually mid-ANIMATION: FIRST check the adjacent frames you were given — if the
  word completes in a nearby frame, it is an animation reveal, so say NOTHING.
  Only flag a truncated word if it does NOT complete in any frame you can see,
  or the AUDIO clearly speaks the full word (then report it as an AUDIO
  MISMATCH). Never flag a pure sentence fragment or standalone word, regardless.

═══════════════════════════════════════════════════════════════════════════
TWO CATEGORIES OF FINDING — KEEP THEM SEPARATE
═══════════════════════════════════════════════════════════════════════════
Every finding you emit belongs to EXACTLY ONE of two categories. Set the
"category" field on each finding accordingly. Do not put a finding in both.

CATEGORY 1 — "qc_technical"
  Objective, defensible mistakes that an editor must fix before delivery.
  Anything from the rules above lives here:
    • Spelling errors and repeated-letter typos
    • Grammar / sentence construction / punctuation
    • Capitalization
    • Line breaks and layout
    • Safe-zone violations
    • Visual / compression artifacts
    • Consistency mismatches across frames
  These are not opinions. They are wrong and need correcting.

CATEGORY 2 — "creative_retention"
  Performance-oriented creative-direction suggestions for social
  optimization. These are NOT errors — they are growth ideas. Examples:
    • "Hook is missing on-screen text in the first 2.5s — viewers scroll
       past silent openings"
    • "No visual change (cut, zoom, or text pop) between 0:08 and 0:13 —
       5s of static frame will drop retention in this format"
    • "Title card at 0:15 reads for 1.2s — too quick for the word count;
       extend to ~2s or shorten copy"
    • "End card holds 3s on the price without an arrow/CTA — add a
       directional element to drive tap-throughs"
    • "Pacing is consistently slow versus top-performing reels in this
       category — consider tighter cuts in the middle third"
    • "Opening frame is the talent's face with no text overlay — viewers
       in feed need to know the hook within 1s"

  Use severity "info" for creative suggestions by default, "warning"
  only when an opening-hook problem is severe enough to materially
  hurt retention (e.g. no hook text in the first 3 seconds).
  Use checkId "quality" for retention/pacing findings.

CRITICAL: Do NOT promote a creative_retention idea to a qc_technical
finding. "Add a zoom here" is never an error. Conversely, do NOT
demote a real typo to creative_retention. "Spelling: 'compaaaete'"
is never just a suggestion.

If the user message includes AUDIT INSTRUCTIONS, treat them as authoritative for
this video and cross-reference every frame against them in addition to all rules
above. (When provided, they appear in the user message — not here.)

═══════════════════════════════════════════════════════════════════════════
EXHAUSTIVE-PASS PROTOCOL — RUN THIS EVERY TIME
═══════════════════════════════════════════════════════════════════════════
For consistent results across runs, execute this exact protocol for
every analysis. Do not shortcut it.

  PASS 1 — Inventory:  For each frame, list every piece of visible
                       burned-in text (titles, captions, lower-thirds,
                       end-cards, sticker text, animated type).
  PASS 2 — Rules:      For each piece of text inventoried, apply every
                       rule above (typos, grammar, punctuation, caps,
                       line breaks, layout, consistency). Tag each
                       finding as qc_technical.
  PASS 3 — Brief:      If the user message included audit instructions, cross-
                       reference every frame against them and flag every
                       deviation, tagging the appropriate category. Otherwise
                       skip this pass.
  PASS 4 — Sweep:      Re-scan every frame one more time looking
                       specifically for repeated-letter typos. These
                       are the most-missed defect. Tag as qc_technical.
  PASS 5 — Creative:   Now switch hats. Walk through the frames in
                       sequence as a creative director. Identify
                       retention/pacing/hook issues. Tag these as
                       creative_retention. Be generous — most videos
                       have 2-5 legitimate creative suggestions.
  PASS 6 — Compile:    Emit one finding object per defect/suggestion.
                       Do not collapse multiple findings into one.
                       Do not omit findings to keep the list short.
  PASS 7 — Dedup:      Report each distinct defect EXACTLY ONCE. Do NOT file
                       the same problem from two angles — if a misspelled word
                       also makes the sentence a fragment (e.g. "is the only
                       skil"), emit ONE finding, the most specific/actionable
                       one (the spelling fix "skil" → "skill"), not a separate
                       spelling AND grammar finding for the same word. If the
                       identical caption is visible in several of these frames,
                       report it once and do NOT append notes like "(repeated
                       across frames 0-1)" — duplicates are merged downstream.
                       Distinct defects remain distinct findings; this only
                       forbids repeating the SAME defect.

═══════════════════════════════════════════════════════════════════════════
OUTPUT FORMAT — STRICT JSON, NO PROSE
═══════════════════════════════════════════════════════════════════════════
Return ONLY a JSON array. No markdown fences. No preamble. No commentary
before or after. Just the array.

Each finding is an object with EXACTLY these fields, in this order:

{
  "frameIndex":  <integer copied verbatim from the [FRAME_METADATA] block>,
  "timestamp":   <number copied verbatim from the [FRAME_METADATA] block>,
  "category":    "qc_technical" | "creative_retention",
  "checkId":     "grammar" | "safezone" | "quality" | "color",
  "kind":        "audio_mismatch" | "spelling" | "grammar" | "punctuation" | "caps" | "layout" | "truncation" | "consistency" | "creative",
  "severity":    "error" | "warning" | "info",
  "confidence":  "high" | "medium" | "low",
  "priority":    "required" | "optional" | "ignore",
  "textSource":  "caption" | "visual",
  "captionText": "<exact on-screen text involved, Latin Hinglish>",
  "audioText":   "<what the voiceover says here, Latin Hinglish; empty if not audio-related>",
  "msg":         "<one-line headline of the issue>",
  "why":         "<one short line: why it matters / what meaning changes>",
  "fix":         "<exact corrected text or concrete action>"
}

"kind" — classify precisely; this drives downstream handling, so be accurate:
  • "audio_mismatch" ONLY for a wrong VISIBLE word that contradicts the voiceover.
  • "truncation" ONLY for a word genuinely cut off that never completes anywhere.
  • otherwise the matching defect type (spelling / grammar / punctuation / ...).

"textSource" — REQUIRED on every finding (see the SCOPE GUARD above):
  • "caption" — the text is an intentional caption / subtitle / title-card overlay.
  • "visual"  — the text is incidental in-shot content (iPad / notebook handwriting,
    whiteboard, slide / document, app UI, chart, signage). In "captions only" scope
    do NOT emit "visual" findings at all.

"confidence" — how sure THIS is a real defect:
  • "high"   — unmistakable (clear typo, repeated-letter, clear audio mismatch).
  • "medium" — likely but the image/audio is slightly unclear.
  • "low"    — possible but uncertain (blurry text, ambiguous audio).
Reserve "error" severity for HIGH-confidence defects — only those are shown to
the user as Errors; medium/low are shown at lower severity.

"priority" — how much editor attention this needs (drives the report filters;
be STRICT to avoid noise):
  • "required" — must fix: meaning-changing typos, audio mismatches (wrong
    word), wrong numbers / names / prices, broken or illegible text.
  • "optional" — minor polish the editor MAY ignore: capitalization, line
    breaks, punctuation, "verify spelling" suggestions, stylistic consistency.
  • "ignore"   — acceptable as-is: valid Hinglish spelling variants, captions
    that already match the audio, animation reveal states.

  NEVER "required" (cap at "optional") when the issue does NOT change meaning:
    • Hinglish ROMANIZATION variants — krne/karne, mutabik/mutaabik, jissey/jisse,
      valli/wali, vahin/wahi, sawaal/sawal. The word is still understood.
    • Date / number FORMAT prefs — "JUN" vs "JUNE", "19 Jun" vs "19 June".
    • Capitalization, terminal punctuation, ALL-CAPS-vs-Title-Case styling.
  These are "optional" at most (often "ignore"). Reserve "required" for things
  that genuinely break meaning or readability (mazboor/mazboot, hai/hain, wrong
  price/name, a misspelling that yields a non-word).

═══════════════════════════════════════════════════════════════════════════
THREE-TIER CLASSIFICATION — SORT EVERY FINDING (READ CAREFULLY)
═══════════════════════════════════════════════════════════════════════════
The report sorts findings into three tiers. Encode the tier through "priority"
and "confidence" exactly as below so the finding lands in the right section:

  TIER 1 — ACTUAL MISTAKE  → priority "required", confidence "high"
    Confirmed, must-fix, defensible: a real spelling typo, a wrong trading term
    (BREAK OUT→BREAKOUT), a brand-name error (Anademy→Academy), an incomplete/
    misspelled word, or a wrong word that CHANGES MEANING. Only use this when you
    are genuinely sure.

  TIER 2 — NEEDS REVIEW    → confidence "medium" or "low" (priority "optional")
    You are NOT fully sure. Use this for: ANY audio mismatch you cannot be 100%
    certain of (the word might have been spoken, e.g. "balki"); a caption that
    might just be one frame of a PROGRESSIVE reveal; stylized/blurry text the OCR
    might have misread. When in doubt between Mistake and Review, choose REVIEW.

  TIER 3 — OPTIONAL STYLE  → priority "optional" or "ignore"
    Editor/client choice, never a hard error: capitalization, ALL-CAPS vs Title
    Case, a lowercase opening word, romanization variants, stylistic consistency.

CAPITALIZATION & CASE ARE STYLE — NOT ERRORS:
  • Do NOT flag a word for being ALL-CAPS, for not matching another word's case,
    or for a lowercase opening (ek / toh / aur / lekin / ko / ke). Short-form
    Hinglish captions routinely open lowercase and use all-caps titles by design.
  • Judge the video's OWN style: if titles are all-caps throughout, all-caps is
    CORRECT. If you mention capitalization at all, it is TIER 3 (never required).

AUDIO MISMATCH = MOSTLY "NEEDS REVIEW":
  • A caption shows ONE moment of a line that reveals progressively across frames;
    the rest appears in other frames. NEVER flag "missing"/"incomplete"/"omits".
  • Flag ONLY a clearly WRONG, visible, meaning-changing substituted word. If you
    are not certain the wrong word is actually on screen (ASR is imperfect), use
    confidence "medium" so it goes to Needs Review — do NOT assert a hard mistake.

MINIMALISM — DO NOT ADD NOISE (this is critical):
  • NEVER emit a finding just to say something is CORRECT or needs "no change"
    (e.g. "caption matches audio", "this is correct Hinglish", "no fix
    required", "no error detected"). If it is fine, emit NOTHING.
  • Do NOT repeat tiny spelling/capitalization nitpicks when the caption is
    clearly understandable — mark them "optional", or skip them.
  • Acceptable Hinglish variants (sawaal/sawal, roz/rozz) where the meaning is
    unchanged are NOT errors — "optional" at most, usually skip. Only flag a
    Hinglish word when the meaning clearly changes (mazboor vs mazboot).
  • A clean caption that matches the audio should produce ZERO findings.

Severity assignment (apply consistently):
  • Repeated-letter typo  → "warning" minimum, "error" preferred
  • Clear audio mismatch  → "error" (high confidence)
  • Other spelling error  → "warning" minimum
  • Brief deviation (factual mismatch like wrong price/name) → "error"
  • Safe-zone violation   → "error"
  • Grammar / punctuation → "warning"
  • Capitalization        → "warning"
  • Style / consistency   → "info" (only when truly stylistic, never wrong)
  • Creative suggestion   → "info" default, "warning" for hook problems

PREMIUM FORMAT — fill EVERY field so each finding reads like this:
  Timestamp 0:09 · Audio mismatch
  Caption says:   "mazboor neev hote hain"
  Voiceover says: "mazboot neev hote hain"
  Why it matters: meaning flips from "strong foundation" to "forced/helpless".
  Fix:            replace "mazboor" with "mazboot".
So: captionText = the exact on-screen text; audioText = what the voiceover says
(empty for non-audio issues); msg = short headline; why = one line on impact;
fix = the concrete correction. LATIN HINGLISH ONLY — never Devanagari.

If there are zero findings, return [].
The array order does not matter — the app sorts by timestamp.

Now read EVERY [FRAME_METADATA] block in the user message, copy each timestamp verbatim, and return ONLY the JSON array.`;

  // Append each frame as: [FRAME_METADATA] block, then the image itself.
  frames.forEach((f, i) => {
    content.push({
      type: "text",
      text: `[FRAME_METADATA] frameIndex=${i} timestamp=${f.ts} (LOCKED — DO NOT MODIFY)`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: f.data },
    });
  });

  const res = await postMessages({
    model,
    max_tokens: maxTokens,
    temperature: API_TEMPERATURE,   // 0 = deterministic; biggest lever for consistency
    // STATIC ruleset in `system` with a cache breakpoint → billed once, then read
    // from cache on every later batch (prompt caching, req #4). The volatile
    // header + frames sit in `messages`, AFTER the cached prefix.
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  }, signal);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let detail = "";
    try {
      const j = JSON.parse(errText);
      detail = j.error?.message || errText;
    } catch { detail = errText; }
    throw new Error(`API ${res.status}: ${detail || res.statusText}`);
  }

  const data = await res.json();
  if (data?.stop_reason === "max_tokens") {
    throw new Error(
      "Claude's response hit the output token limit before finishing. " +
      "Try lowering BATCH_SIZE or raise the mode's maxTokens in MODES."
    );
  }

  const text = data?.content?.map(b => b.text || "").join("").trim() || "";

  // Browser-console diagnostic. Open DevTools → Console after analysis to see
  // exactly what Claude returned. Useful when issue counts seem off.
  console.groupCollapsed(
    `%c[BB QC] Claude raw response (${text.length} chars, stop_reason=${data?.stop_reason})`,
    "color:#fca5a5;font-weight:600"
  );
  console.log(text);
  console.log("Usage:", data?.usage);
  console.groupEnd();

  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed;
  try { parsed = JSON.parse(stripped); }
  catch {
    const fullMatch = stripped.match(/\[[\s\S]*\]/);
    if (fullMatch) { try { parsed = JSON.parse(fullMatch[0]); } catch { /* fall through */ } }
    if (!parsed) {
      const start = stripped.indexOf("[");
      if (start >= 0) {
        const slice = stripped.slice(start);
        const lastComplete = slice.lastIndexOf("},");
        if (lastComplete > 0) {
          const repaired = slice.slice(0, lastComplete + 1) + "]";
          try { parsed = JSON.parse(repaired); } catch { /* fall through */ }
        }
      }
    }
    if (!parsed) {
      throw new Error(
        "Could not parse JSON from Claude's response. " +
        `First 200 chars: ${stripped.slice(0, 200)}`
      );
    }
  }

  if (!Array.isArray(parsed)) throw new Error("API response was not a JSON array");

  // Validate, sanitize, and lock timestamps from our metadata (not from Claude).
  // Claude is told to copy them verbatim, but we always use OUR frame.ts as the
  // canonical truth — defense in depth against any drift.
  const issues = [];
  let nextId = 1;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    if (!VALID_CHECK_IDS.has(item.checkId)) continue;
    if (!VALID_SEVERITIES.has(item.severity)) continue;
    if (typeof item.msg !== "string" || !item.msg.trim()) continue;

    const frameIdx = Number(item.frameIndex);
    let ts = null;
    if (Number.isFinite(frameIdx) && frameIdx >= 0 && frameIdx < frames.length) {
      ts = frames[frameIdx].ts;   // ← canonical timestamp from our metadata
    } else if (Number.isFinite(Number(item.timestamp))) {
      // Fallback: if Claude returned a timestamp but a bad frameIndex, snap to
      // the nearest known frame timestamp (frames now use sub-second floats).
      const claimedTs = Number(item.timestamp);
      let best = null, bestDiff = Infinity;
      for (const f of frames) {
        const d = Math.abs(f.ts - claimedTs);
        if (d < bestDiff) { bestDiff = d; best = f; }
      }
      if (best && bestDiff <= 0.6) ts = best.ts;
    }

    // SCOPE GUARD: in "captions only" mode, drop any finding the model tagged as
    // incidental in-shot text (iPad/whiteboard/slide/UI/background). Untagged →
    // treated as caption (kept), since the prompt already steers off visual text.
    const textSource = VALID_TEXT_SOURCE.has(item.textSource) ? item.textSource : "caption";
    if (captionScope !== "all" && textSource === "visual") continue;

    // clean() now also scrubs any leaked Devanagari, keeping the romanized text.
    const clean = (v, n) => {
      if (typeof v !== "string" || !v.trim()) return null;
      const out = scrubDevanagari(v.trim()).slice(0, n).trim();
      return out || null;
    };
    const msg = scrubDevanagari(String(item.msg).trim()).slice(0, 400).trim();
    if (!msg) continue;                                  // was all-Devanagari → nothing left to show
    const why = clean(item.why, 300);
    const captionText = clean(item.captionText, 300);
    const fix = clean(item.fix, 800);

    // DOMAIN ESCALATOR: a known trading term written wrong (bad form visible in the
    // caption AND the fix proposes the canonical one) is a REQUIRED brand-accuracy
    // error — it forces full severity and overrides the style-variant downgrade, so
    // these are caught CONSISTENTLY rather than at the model's run-to-run discretion.
    const tradingHit = isCreative ? null : matchTradingTerm(captionText, `${msg} ${fix || ""}`);
    const confidence = tradingHit ? "high" : (VALID_CONFIDENCE.has(item.confidence) ? item.confidence : "medium");
    // Gate severity by confidence so only high-confidence defects read as errors.
    const sev = tradingHit ? "error" : gateSeverityByConfidence(item.severity, confidence);
    let priority = VALID_PRIORITY.has(item.priority) ? item.priority
      : (sev === "error" ? "required" : sev === "warning" ? "optional" : "ignore");
    if (tradingHit) priority = "required";               // domain term → always required
    // Style / romanization variants don't change meaning → never "required"
    // (but a trading-term hit above already won, so this only catches non-domain splits).
    else if (priority === "required" && isStyleVariant({ msg, why })) priority = "optional";

    issues.push({
      id: nextId++,
      // This call was run in a single mode (technical batch OR creative pass),
      // so force the category to match the mode.
      category: isCreative ? "creative_retention" : "qc_technical",
      checkId: item.checkId,
      kind: clean(item.kind, 24) || (isCreative ? "creative" : "spelling"),
      confidence,
      priority,
      severity: sev,
      textSource,
      ts,
      captionText,
      audioText: clean(item.audioText, 300),
      msg,
      why,
      fix,
    });
  }

  return { issues, debugText: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXHAUSTIVE SCAN ORCHESTRATION
// Split the dense frame set into small batches, run them through Claude with
// limited concurrency (each call stays under the Vercel Hobby 10s/4.5MB limits),
// run one holistic creative pass, then merge + dedupe everything.
// ─────────────────────────────────────────────────────────────────────────────

function chunkFrames(frames, size) {
  const out = [];
  for (let i = 0; i < frames.length; i += size) out.push(frames.slice(i, i + size));
  return out;
}

// ── DIVIDE & CONQUER: cut the chronological timeline into N segments ──────────
// How many segments to cut: ~1 per SEGMENT_TARGET_SEC of video, clamped to the
// mode's maxSegments (and at least 1). 60s → 3 (urgent) / 3 (deep capped at 4).
function computeSegmentCount(durationSec, maxSegments) {
  const n = Math.round((durationSec || 0) / SEGMENT_TARGET_SEC) || 1;
  return Math.max(1, Math.min(maxSegments, n));
}

// Slice frames into `segCount` equal time windows. Each window (except the
// first) reaches `overlapSec` BACKWARDS into the previous one, so a caption that
// sits right on a seam appears in BOTH adjacent segments and can't be missed.
// Frames keep their absolute ts, so the reducer can sort the whole video back
// into one chronological timeline with no drift.
function segmentByTime(frames, segCount, overlapSec) {
  if (segCount <= 1 || frames.length === 0) return [frames];
  const dur = frames[frames.length - 1].ts || 0;
  const width = dur / segCount;
  const out = [];
  for (let s = 0; s < segCount; s++) {
    const lo = s === 0 ? -Infinity : s * width - overlapSec;        // overlap into previous
    const hi = s === segCount - 1 ? Infinity : (s + 1) * width;
    const slice = frames.filter((f) => f.ts >= lo && f.ts < hi);
    if (slice.length) out.push(slice);
  }
  return out.length ? out : [frames];
}

// Evenly sample N frames from the dense set for the holistic creative pass.
function sampleEvenly(frames, n) {
  if (frames.length <= n) return frames;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(frames[Math.round((frames.length - 1) * i / (n - 1))]);
  }
  // de-dup in case rounding collided
  return out.filter((f, i) => out.indexOf(f) === i);
}

// Run async tasks with a bounded number in flight at once. Calls onDone() as
// each task settles so the UI can show real progress. Rejects on abort.
async function runWithConcurrency(tasks, limit, onDone = () => {}) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
      onDone();
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// Merge findings from every batch and collapse duplicates. Two things produce
// repeated feedback for ONE real mistake:
//   1. The same caption spans adjacent frames that fall in different batches
//      (separate API calls), so each call flags it independently.
//   2. A single defect is reported from two angles — e.g. a misspelled word
//      flagged once as "Spelling" and again as a "Grammar fragment".
// Keying on the whole msg missed both: the wording drifts ("...(repeated
// across frames 0-1)") and the two angles use different checkIds. So we key on
// the EXACT on-screen text each finding quotes — the true signature of the
// mistake — and merge any same-category findings whose quoted spans overlap.

// Pull the quoted spans out of a finding's text. Claude is instructed to quote
// the exact wrong text, so these identify the defect independent of the
// advisory wording. Keep spans that are a phrase (contain a space) or 4+ chars,
// so short stopwords ("the", "are") never merge unrelated findings.
function quotedSpans(text) {
  const spans = new Set();
  if (!text) return spans;
  const re = /["'“”‘’]([^"'“”‘’]{2,}?)["'“”‘’]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = m[1].toLowerCase().replace(/\s+/g, " ").trim();
    if (s.length >= 4 || s.includes(" ")) spans.add(s);
  }
  return spans;
}

function dedupeIssues(issues) {
  // Of two findings for the same mistake, keep the most useful: prefer a
  // concrete replacement ("→"), then the earliest timestamp; carry over a fix
  // from the discarded one if the winner lacks it.
  const keepBetter = (a, b) => {
    const aArrow = /→|->/.test(a.msg) ? 1 : 0;
    const bArrow = /→|->/.test(b.msg) ? 1 : 0;
    let win, lose;
    if (aArrow !== bArrow) { [win, lose] = aArrow > bArrow ? [a, b] : [b, a]; }
    else {
      const aTs = a.ts == null ? Infinity : a.ts;
      const bTs = b.ts == null ? Infinity : b.ts;
      [win, lose] = aTs <= bTs ? [a, b] : [b, a];
    }
    // Keep the winner's identity but backfill any structured field it lacks
    // from the discarded duplicate, so no detail is lost on merge.
    const filled = { ...win };
    for (const k of ["fix", "why", "audioText", "captionText"]) {
      if (!filled[k] && lose[k]) filled[k] = lose[k];
    }
    return filled;
  };

  // One node per finding. Quote-less findings get a synthetic span from their
  // normalized msg so identical-wording dups still merge but distinct ones
  // never collide.
  const nodes = issues.map((it) => {
    // Prefer the structured captionText as the stable dedup signature; fall back
    // to quoted spans in the message. This keeps grouping consistent run-to-run.
    const spans = quotedSpans(`${it.msg} ${it.fix || ""} ${it.captionText || ""}`);
    if (it.captionText) {
      const c = it.captionText.toLowerCase().replace(/\s+/g, " ").trim();
      if (c.length >= 4 || c.includes(" ")) spans.add(c);
    }
    if (spans.size === 0) {
      spans.add("msg:" + it.msg.toLowerCase().replace(/\s+/g, " ").trim());
    }
    return { issue: it, cat: it.category, spans };
  });

  // Iteratively merge same-category nodes whose quoted spans intersect. Finding
  // counts per video are small, so the simple O(n²) sweep is fine and — unlike
  // a single pass — it merges transitively (A↔B, B↔C ⇒ A,B,C) regardless of
  // the order findings arrive in.
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < nodes.length && !merged; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[i].cat !== nodes[j].cat) continue;
        let overlap = false;
        for (const s of nodes[j].spans) {
          if (nodes[i].spans.has(s)) { overlap = true; break; }
        }
        if (overlap) {
          nodes[i].issue = keepBetter(nodes[i].issue, nodes[j].issue);
          for (const s of nodes[j].spans) nodes[i].spans.add(s);
          nodes.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }

  return nodes.map((n) => n.issue);
}

// Deterministically reject the "caption shows less than the audio" false
// positive (e.g. caption "kisi bhi desh ki economic security" while the audio
// continues "...currency stability aur global credibility"). Captions reveal
// progressively and lag the voiceover, so a caption that is a leading SUBSET of
// what the audio says is NOT an error. We drop these in code rather than trusting
// the model to always obey the prompt — this is what makes runs converge.
function isProgressiveCaptionFalsePositive(it) {
  const norm = (s) => (s || "").toLowerCase().replace(/[.,!?;:"'“”‘’]/g, "").replace(/\s+/g, " ").trim();
  const cap = norm(it.captionText), aud = norm(it.audioText);
  // caption is a leading subset of the spoken phrase → progressive reveal
  if (cap && aud && aud.length > cap.length + 3 && aud.startsWith(cap)) return true;
  // explicit "incomplete vs audio / does not progress / audio continues" wording
  const m = `${it.msg || ""} ${it.why || ""}`.toLowerCase();
  return /caption (text )?incomplete|incomplete[^.]*caption|shows only|only the first|first phrase|does ?n.?t progress|not progress|audio continues|caption (does not|doesn.?t) (show|progress)|partial sentence|continues with/.test(m);
}

// Drop pure "this is correct / no change needed" confirmations — they are noise,
// not findings (e.g. "caption matches audio", "correct Hinglish, no fix required").
function isNonIssue(it) {
  const m = `${it.msg || ""} ${it.fix || ""} ${it.why || ""}`.toLowerCase();
  return /no change required|no fix required|no error detected|caption is correct|is correct hinglish|already correct|matches the voiceover|caption matches audio|caption is grammatically sound|no change needed|correct as[- ]is/.test(m);
}

// ── REDUCER ───────────────────────────────────────────────────────────────────
// Combine the JSON outputs from every parallel segment (+ the creative pass)
// back into ONE chronological timeline: flatten → drop progressive-reveal & "no
// change" noise → dedupe → sort by absolute timestamp → renumber ids. Pure
// function of the checkpoint `plan`, so it can run progressively AND at the end.
function reducePlan(plan) {
  const allow = plan.memory?.allow;
  const all = [
    ...plan.segments.flatMap((s) => s.issues || []),
    ...(plan.creativeIssues || []),
  ].filter((it) => !isProgressiveCaptionFalsePositive(it) && !isNonIssue(it) && !isSoftNonActionable(it) && !isAllowlisted(it, allow));
  const merged = dedupeIssues(all);
  merged.sort((a, b) => {
    if (a.ts == null && b.ts == null) return 0;
    if (a.ts == null) return 1;
    if (b.ts == null) return -1;
    return a.ts - b.ts;
  });
  merged.forEach((it, i) => { it.id = i + 1; });

  const incomplete = plan.segments.filter((s) => s.status === "failed" || s.status === "aborted");
  return {
    issues: merged,
    failedSegments: incomplete.length,
    failedFrames: incomplete.reduce((n, s) => n + s.frames.length, 0),
    totalFrames: plan.frames.length,
    pendingRemain: plan.segments.some((s) => s.status !== "done"),
  };
}

// ── PARALLEL SEGMENT PIPELINE (Divide & Conquer + guardrails + checkpoint) ────
// Runs all NOT-YET-DONE segments concurrently. Each segment:
//   • batches its frames (BATCH_SIZE) and runs those batches with bounded
//     concurrency;
//   • has its OWN AbortController + watchdog timer — if the segment lags past
//     its share of the wall-clock cap, only THAT segment is cancelled, the rest
//     keep going (latency guardrail);
//   • is a checkpoint unit: on completion its status + issues are written back
//     to `plan` and surfaced via onSegmentDone, so finished work survives even
//     if a sibling fails. Resume = call this again with the same plan; only
//     pending/failed/aborted segments re-run.
// The plan object IS the resumable checkpoint (kept in component memory — no DB).
async function analyzeSegments(plan, signal, cb = {}) {
  const onProgress = cb.onProgress || (() => {});
  const onSegmentDone = cb.onSegmentDone || (() => {});
  const mode = MODES[plan.modeId] || MODES[DEFAULT_MODE];
  const { frames, duration, brief } = plan;

  const pending = plan.segments.filter((s) => s.status !== "done");

  // Per-segment guardrail: AbortController + watchdog. Each segment gets a share
  // of the cap (× a small pad) before its own requests are cancelled.
  const cap = mode.capFormula(duration);
  const perSegMs = Math.max(20_000, Math.round((cap / Math.max(1, pending.length)) * SEGMENT_TIMEOUT_PAD));
  pending.forEach((seg) => {
    seg.ac = new AbortController();
    seg.collected = [];
    seg.remaining = 0;
    seg.hadError = false;
    seg.done = false;
    seg._onAbort = () => seg.ac.abort();
    signal?.addEventListener("abort", seg._onAbort);
    seg.timer = setTimeout(() => seg.ac.abort(), perSegMs);
  });

  // Build the global, segment-tagged batch task list.
  const tagged = [];
  for (const seg of pending) {
    const batches = chunkFrames(seg.frames, BATCH_SIZE);
    seg.remaining = batches.length || 1;
    if (!batches.length) { seg.remaining = 0; }
    for (const batch of batches) tagged.push({ seg, batch });
  }

  const creativeUnit = (mode.runCreative && !plan.creativeDone) ? 1 : 0;
  const total = Math.max(1, tagged.length + creativeUnit);
  let units = 0;
  const tick = () => { units++; onProgress({ current: units, total }); };
  onProgress({ current: 0, total });

  const finalizeSeg = (seg) => {
    if (seg.done) return;
    if (seg.remaining > 0 && !seg.ac.signal.aborted) return;
    seg.done = true;
    seg.status = seg.ac.signal.aborted ? "aborted" : (seg.hadError ? "failed" : "done");
    seg.issues = seg.collected;
    clearTimeout(seg.timer);
    signal?.removeEventListener("abort", seg._onAbort);
    onSegmentDone({ id: seg.id, status: seg.status });
  };

  const runOne = async ({ seg, batch }) => {
    if (seg.ac.signal.aborted) { seg.remaining = Math.max(0, seg.remaining - 1); finalizeSeg(seg); return; }
    try {
      const r = await analyzeFrames(batch, duration, seg.ac.signal, brief, "technical",
        { model: mode.model, maxTokens: mode.maxTokens, transcript: plan.transcript, captionScope: plan.captionScope, memory: plan.memory });
      seg.collected.push(...r.issues);
    } catch (e) {
      if (e.name !== "AbortError") { seg.hadError = true; console.error("[BB QC] batch failed:", e.message); }
    } finally {
      seg.remaining = Math.max(0, seg.remaining - 1);
      tick();
      finalizeSeg(seg);
    }
  };

  // FIRE ALL CHUNKS IN PARALLEL. We warm the prompt cache with ONE call first
  // (so the big static system prompt is written once), THEN fan the rest out
  // concurrently — they read the cache instead of each re-writing it. Honors
  // "fire all chunks at once" while avoiding an N-way cache-write stampede.
  if (tagged.length) {
    await runOne(tagged[0]);                                       // warm the prompt cache (1 write)
    await runWithConcurrency(
      tagged.slice(1).map((t) => () => runOne(t)),                 // then fan the rest out in parallel
      Math.min(8, Math.max(2, tagged.length))                      // capped so we don't trip rate limits
    );
  }
  pending.forEach(finalizeSeg);   // settle any segment whose batches all early-returned

  // Holistic creative pass (Deep Audit only) — one call over evenly-spaced frames.
  if (mode.runCreative && !plan.creativeDone && !signal?.aborted) {
    try {
      const creativeFrames = sampleEvenly(frames, CREATIVE_FRAME_COUNT);
      const r = await analyzeFrames(creativeFrames, duration, signal, brief, "creative",
        { model: mode.model, maxTokens: mode.maxTokens, captionScope: plan.captionScope });
      plan.creativeIssues = r.issues;
      plan.creativeDone = true;
    } catch (e) {
      if (e.name !== "AbortError") console.warn("[BB QC] creative pass failed, continuing:", e.message);
    }
    tick();
  }

  return reducePlan(plan);
}

// ── ANIMATION VERIFICATION PASS ───────────────────────────────────────────────
// Kinetic captions reveal text over several frames, so a single frame can catch
// a word mid-animation ("econo" before "economy" finishes). The main pass can
// flag that as a truncation. Before trusting such a finding, we re-examine the
// CONSECUTIVE frames around its timestamp: if the word completes in a nearby
// frame, it was just animating → drop it. If it never completes (or the audio
// says the full word), keep it. Only truncation/incompleteness-type findings are
// checked — real typos, audio mismatches, and repeated-letter errors are trusted
// as-is, so this stays cheap.
function isAnimationSuspect(it) {
  // ONLY genuine truncation/progressive-reveal findings get re-verified against
  // neighbouring frames. Audio mismatches and spelling errors (which may contain
  // words like "missing" or "incomplete") must NEVER be routed here — that was
  // silently dropping real errors like "maane → mane (missing the second a)".
  if (it.kind) return it.kind === "truncation";
  const m = (it.msg || "").toLowerCase();   // legacy fallback when kind is absent
  return /truncat|cut[\s-]?off|mid-?word|does ?n.?t progress|not shown in any|incomplete caption/.test(m);
}

// 3+ identical letters in a row — the hallmark of an OCR doubled-letter artifact.
function hasRepeatedRun(s) { return /([A-Za-z])\1\1/.test(s || ""); }

// OCR-hallucination suspect: a spelling-family finding that looks like a doubled
// /repeated-letter misread of STYLIZED overlay text ("PATTERN"→"PATTTERN"). These
// are re-verified across neighbouring frames and dropped unless the misspelling is
// consistently visible — a correct caption must never read as a Required error.
function isOcrSuspect(it) {
  if (!it || it.category === "creative_retention") return false;
  if (it.kind && it.kind !== "spelling" && it.kind !== "consistency" && it.kind !== "caps") return false;
  const blob = `${it.msg || ""} ${it.why || ""} ${it.fix || ""}`.toLowerCase();
  if (/repeated[- ]?letter|consecutive identical|consecutive '?[a-z]'?|three consecutive|doubled letter|extra '?[a-z]'?\b|repeated '?[a-z]'?/.test(blob)) return true;
  // The flagged on-screen word itself contains a 3+ run (e.g. captionText "PATTTERN").
  if (hasRepeatedRun(it.captionText)) return true;
  return false;
}

async function verifyFinding(it, frames, transcript, signal, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const ts = it.ts ?? 0;
  const lo = ts - VERIFY_WINDOW_SEC, hi = ts + VERIFY_FORWARD_SEC;
  let window = frames.filter((f) => f.ts >= lo && f.ts <= hi);
  if (window.length < 2) return { real: true };   // not enough context to refute → keep
  if (window.length > 12) window = sampleEvenly(window, 12);

  const audio = transcript ? transcriptWindow(transcript, lo, hi) : "";
  const ocrMode = isOcrSuspect(it);
  const promptText = ocrMode
    ? `These ${window.length} frames are in chronological order, spanning ${fmtTs(lo)}–${fmtTs(hi)}. A previous QC pass flagged a SPELLING error here at ${fmtTs(ts)}:

FLAGGED: ${it.msg}

Stylized overlay text (bold, white-outlined, drop-shadow, italic, motion/compression blur) is easily MISREAD — an extra repeated letter (e.g. "PATTERN" read as "PATTTERN") is the #1 OCR artifact. Read the ACTUAL on-screen text CAREFULLY, using the CLEAREST frame available, then decide:
  • REAL only if the misspelling is CLEARLY and CONSISTENTLY visible — the wrong form genuinely appears on screen.
  • NOT real if the text actually reads as a normal, correctly-spelled word and the flagged typo was just a misread of stylized/blurry glyphs.
  • When uncertain, answer NOT real. A correct caption must never be flagged.
Output Latin-script Hinglish only (never Devanagari).

Return ONLY this JSON, nothing else:
{"real": true or false, "msg": "<refined finding if real, else empty>", "fix": "<fix if real, else empty>"}`
    : `These ${window.length} frames are in chronological order, spanning ${fmtTs(lo)}–${fmtTs(hi)} of a video whose captions animate IN progressively — one word/phrase at a time — and LAG behind the voiceover. A previous QC pass flagged this at ${fmtTs(ts)}:

FLAGGED: ${it.msg}

Judge against the caption's MOST COMPLETE state across ALL of these frames:
  • A word cut short early but that COMPLETES in a later frame ("econo"→"economy") is an animation reveal → NOT real.
  • Text the caption seems to be MISSING early but that APPEARS in a later frame (the sentence continuing, e.g. "currency stability aur global credibility") is progressive reveal → NOT real.
  • A caption showing a correct SUBSET of what the audio says is fine → NOT real.
  • REAL only if a clearly VISIBLE word is wrong/misspelled, OR the "missing" text NEVER appears in any of these frames.
Output Latin-script Hinglish only (never Devanagari).${audio ? `\n\nAUDIO (voiceover) for this window:\n${audio}` : ""}

Return ONLY this JSON, nothing else:
{"real": true or false, "msg": "<refined finding if real, else empty>", "fix": "<fix if real, else empty>"}`;
  const content = [{ type: "text", text: promptText }];
  window.forEach((f, i) => {
    content.push({ type: "text", text: `[FRAME ${i}] timestamp=${f.ts}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
  });

  try {
    const res = await postMessages({ model, max_tokens: 400, temperature: 0, messages: [{ role: "user", content }] }, signal);
    if (!res.ok) return { real: true };
    const data = await res.json();
    const text = (data?.content?.map((b) => b.text || "").join("") || "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { real: true };
    const v = JSON.parse(m[0]);
    return { real: !!v.real, msg: v.msg, fix: v.fix };
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return { real: true };   // verification failed → keep (never silently lose a real error)
  }
}

// Verify every animation-suspect finding (in parallel), drop the ones that turn
// out to be mid-animation reveals, refine the ones that are real, renumber ids.
async function verifyAnimationSuspects(issues, plan, signal, onProgress = () => {}) {
  const model = (MODES[plan.modeId] || MODES[DEFAULT_MODE]).model;
  // Verify both classes against neighbouring frames: animation/truncation reveals
  // AND OCR doubled-letter misreads of stylized captions ("PATTERN"→"PATTTERN").
  const suspects = issues.filter((it) => isAnimationSuspect(it) || isOcrSuspect(it));
  if (suspects.length === 0) return issues;

  const verdicts = new Map();
  let done = 0;
  const tasks = suspects.map((it) => async () => {
    if (signal?.aborted) return;
    const v = await verifyFinding(it, plan.frames, plan.transcript, signal, { model }).catch(() => ({ real: true }));
    verdicts.set(it.id, v);
    onProgress({ current: ++done, total: suspects.length });
  });
  await runWithConcurrency(tasks, 6);

  const out = [];
  for (const it of issues) {
    const v = verdicts.get(it.id);
    if (!v) { out.push(it); continue; }          // not a suspect → keep as-is
    if (!v.real) continue;                        // animation reveal → drop
    out.push(v.msg ? { ...it, msg: v.msg, fix: v.fix || it.fix } : it);
  }
  out.forEach((x, i) => { x.id = i + 1; });
  return out;
}

// Estimate frames, API calls, tokens, and dollars for THIS mode's scan — shown
// on the confirm screen BEFORE scanning. Vision tokens ≈ (w × h) / 750 per
// image. Prompt caching means only the FIRST call pays full instruction tokens;
// the rest read the cached prefix at ~0.1×, so we discount accordingly.
function estimateScanCost(durationSec, frameW, frameH, mode) {
  const cfg = mode || MODES[DEFAULT_MODE];
  const duration = durationSec > 0 ? durationSec : 60;
  const w = frameW > 0 ? frameW : 1280;
  const h = frameH > 0 ? frameH : 720;

  const frames = Math.max(8, Math.min(MAX_TOTAL_FRAMES, Math.ceil(duration * cfg.coverageFps)));
  const scaledW = Math.min(w, MAX_FRAME_WIDTH);
  const ratio = w > 0 ? scaledW / w : 1;
  const scaledH = Math.round(h * ratio);
  const tokensPerImage = Math.round((scaledW * scaledH) / 750);

  const techBatches = Math.ceil(frames / BATCH_SIZE);
  const creativeFrames = cfg.runCreative ? Math.min(frames, CREATIVE_FRAME_COUNT) : 0;
  const totalCalls = techBatches + (cfg.runCreative ? 1 : 0);

  // Instruction tokens: 1 full write + the rest at ~0.1× (cache reads).
  const promptTokens = PROMPT_TOKENS_PER_CALL * (1 + 0.1 * Math.max(0, totalCalls - 1));
  const inputTokens = promptTokens + (frames + creativeFrames) * tokensPerImage;
  const outputTokens = totalCalls * OUTPUT_TOKENS_PER_CALL;

  const cost =
    (inputTokens / 1e6) * cfg.priceIn +
    (outputTokens / 1e6) * cfg.priceOut;

  return { frames, calls: totalCalls, inputTokens, outputTokens, tokensPerImage, cost, model: cfg.model };
}

// Quick API connectivity probe used by the upload screen to show a status dot.
async function probeApi() {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 10,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => "");
    let detail = errText;
    try { detail = JSON.parse(errText)?.error?.message || errText; } catch {}
    return { ok: false, status: res.status, detail };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. UI COMPONENTS
// ═════════════════════════════════════════════════════════════════════════════

// Live countdown shown DURING analysis. Counts down from the mode's hard
// wall-clock cap (`capMs`) toward the `deadline` (epoch ms). The guardrail
// aborts lagging segments around this same cap, so the timer is a real promise
// to the user, not decoration.
function Countdown({ deadline, capMs }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadline]);
  if (!deadline) return null;
  const remMs = Math.max(0, deadline - now);
  const pct = capMs > 0 ? Math.max(0, Math.min(100, (remMs / capMs) * 100)) : 0;
  const danger = remMs <= capMs * 0.2;
  const over = remMs <= 0;
  const color = over ? T.redDeep : danger ? T.redBright : "#10b981";
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: T.textDim }}>{over ? "Time cap reached" : "Max time remaining"}</span>
        <span style={{ fontSize: 22, fontWeight: 800, fontFamily: "DM Mono, monospace", color, letterSpacing: "0.02em" }}>
          {fmtTs(Math.ceil(remMs / 1000))}
        </span>
      </div>
      <div style={{ height: 4, background: "rgba(255,255,255,0.07)", borderRadius: 4, overflow: "hidden", maxWidth: 320, margin: "0 auto" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 4, transition: "width 0.25s linear" }} />
      </div>
    </div>
  );
}

// Speed-mode picker shown on the confirm screen. Two mutually-exclusive cards.
function ModeSelector({ mode, setMode }) {
  return (
    <div style={{ width: "100%", maxWidth: 540, marginBottom: 20 }}>
      <div style={{ fontSize: 11, color: T.textMute, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>
        ⚙️ Speed mode
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {Object.values(MODES).map((m) => {
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              style={{
                textAlign: "left",
                padding: "14px 16px",
                borderRadius: 12,
                cursor: "pointer",
                background: active ? T.redTint : "rgba(255,255,255,0.025)",
                border: `1px solid ${active ? T.borderHot : T.border}`,
                boxShadow: active ? "0 4px 16px rgba(220,38,38,0.18)" : "none",
                transition: "all 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 18 }}>{m.icon}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: active ? "white" : T.textMute }}>{m.label}</span>
                {active && <span style={{ marginLeft: "auto", fontSize: 11, color: T.redLight }}>✓</span>}
              </div>
              <p style={{ fontSize: 11, color: T.textDim, lineHeight: 1.5, margin: 0 }}>{m.blurb}</p>
              <p style={{ fontSize: 10, color: T.textDim, marginTop: 8, fontFamily: "DM Mono, monospace" }}>
                {m.model.replace("claude-", "")} · {m.coverageFps} fps · {m.runCreative ? "full audit" : "objective only"}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Text-scope toggle: QC only the caption/subtitle layer (default) or every piece
// of on-screen text. Default avoids false errors from iPad notes, whiteboards,
// slide text and other incidental in-shot text.
function ScopeSelector({ scopeMode, setScopeMode }) {
  const opts = [
    { id: "captions", icon: "💬", label: "Check only captions", blurb: "Subtitles & title overlays only — ignores iPad notes, whiteboards, slides, app UI & background text" },
    { id: "all",      icon: "🔍", label: "Check all on-screen text", blurb: "Also QCs handwriting, whiteboards, documents & every other visible word" },
  ];
  return (
    <div style={{ width: "100%", maxWidth: 540, marginBottom: 20 }}>
      <div style={{ fontSize: 11, color: T.textMute, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>
        🎯 Text scope
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {opts.map((o) => {
          const active = scopeMode === o.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => setScopeMode(o.id)}
              style={{
                textAlign: "left", padding: "14px 16px", borderRadius: 12, cursor: "pointer",
                background: active ? T.redTint : "rgba(255,255,255,0.025)",
                border: `1px solid ${active ? T.borderHot : T.border}`,
                boxShadow: active ? "0 4px 16px rgba(220,38,38,0.18)" : "none",
                transition: "all 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 16 }}>{o.icon}</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: active ? "white" : T.textMute }}>{o.label}</span>
                {active && <span style={{ marginLeft: "auto", fontSize: 11, color: T.redLight }}>✓</span>}
              </div>
              <p style={{ fontSize: 11, color: T.textDim, lineHeight: 1.5, margin: 0 }}>{o.blurb}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ScoreRing({ score, size = 64 }) {
  const r = size * 0.4, circ = 2 * Math.PI * r;
  const color = score >= 80 ? "#10b981" : score >= 60 ? "#f59e0b" : T.redBright;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={size*0.08}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={size*0.08}
        strokeDasharray={`${(score/100)*circ} ${circ}`} strokeLinecap="round"
        style={{transform:"rotate(-90deg)",transformOrigin:"50% 50%",transition:"stroke-dasharray 1s ease"}}/>
      <text x="50%" y="54%" textAnchor="middle" fill={color} fontSize={size*0.22} fontWeight="700" fontFamily="DM Mono, monospace">{score}</text>
    </svg>
  );
}

function Timeline({ issues, currentTs, duration, doneIds, onSeek }) {
  const D = duration || 60;
  const done = doneIds || new Set();
  const timedIssues = issues.filter(i => i.ts != null && i.ts <= D);
  const step = D > 30 ? 10 : Math.max(1, Math.round(D / 9));
  const ticks = [];
  for (let t = 0; t <= D; t += step) ticks.push(t);

  return (
    <div style={{ userSelect: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: T.textDim, fontFamily: "DM Mono, monospace" }}>0:00</span>
        <span style={{ fontSize: 11, color: T.textDim, fontFamily: "DM Mono, monospace" }}>{fmtTs(Math.round(D))}</span>
      </div>
      <div
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          onSeek(Math.round(ratio * D));
        }}
        style={{ position: "relative", height: 44, background: "rgba(255,255,255,0.03)", borderRadius: 10, cursor: "crosshair", border: `1px solid ${T.border}` }}
      >
        {ticks.map(t => (
          <div key={t} style={{ position: "absolute", left: `${(t/D)*100}%`, top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.05)" }}>
            <span style={{ position: "absolute", bottom: -16, left: "50%", transform: "translateX(-50%)", fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: "DM Mono, monospace", whiteSpace: "nowrap" }}>{fmtTs(t)}</span>
          </div>
        ))}
        {timedIssues.map(issue => {
          const left = `${(issue.ts / D) * 100}%`;
          const s = SEV[issue.severity];
          const isActive = currentTs != null && Math.abs(currentTs - issue.ts) < 0.5;
          const isCreative = issue.category === "creative_retention";
          const isDone = done.has(issue.id);
          // Technical = solid dot (red/amber/green by severity); creative = hollow
          // purple ring; DONE = dimmed green dot. Spot the populations at a glance.
          return (
            <div
              key={issue.id}
              onClick={(e) => { e.stopPropagation(); onSeek(issue.ts); }}
              title={`${isDone ? "✓ done · " : ""}${fmtTs(issue.ts)} · ${isCreative ? "💡 " : ""}${issue.msg}`}
              style={{
                position: "absolute", left, top: "50%", transform: "translate(-50%,-50%)",
                width: isActive ? 16 : 11, height: isActive ? 16 : 11,
                borderRadius: "50%",
                background: isDone ? "#10b981" : (isCreative ? "transparent" : s.dot),
                opacity: isDone ? 0.45 : 1,
                cursor: "pointer",
                border: (isCreative && !isDone)
                  ? `2px solid ${T.purpleBright}`
                  : (isActive ? `2px solid white` : `2px solid rgba(0,0,0,0.5)`),
                boxShadow: isActive
                  ? `0 0 0 4px ${(isDone ? "#10b981" : isCreative ? T.purpleBright : s.dot)}55`
                  : "none",
                transition: "all 0.15s ease", zIndex: isActive ? 10 : 5,
              }}
            />
          );
        })}
        {currentTs != null && (
          <div style={{
            position: "absolute", left: `${(currentTs / D) * 100}%`, top: -4, bottom: -4,
            width: 2, background: "white", borderRadius: 2, pointerEvents: "none", zIndex: 20,
            boxShadow: "0 0 8px rgba(255,255,255,0.6)",
          }}>
            <div style={{ position: "absolute", top: -5, left: "50%", transform: "translateX(-50%)", width: 10, height: 10, borderRadius: "50%", background: "white" }} />
          </div>
        )}
      </div>
    </div>
  );
}

function IssueCard({ issue, isSelected, onClick, isDone, onToggleDone, onLearnCorrect, onFeedback }) {
  const [learning, setLearning] = useState(false);
  const [term, setTerm] = useState("");
  const [fbOpen, setFbOpen] = useState(false);
  const [fbType, setFbType] = useState(null);
  const [fbNote, setFbNote] = useState("");
  const [fbSent, setFbSent] = useState(false);
  const s = SEV[issue.severity];
  const check = CHECKS.find(c => c.id === issue.checkId);
  const isCreative = issue.category === "creative_retention";
  const tier = issueTier(issue);
  const tr = TIER[tier] || TIER.review;
  // Creative cards get a purple left-stripe; completed items go green + dimmed.
  const stripeColor = isDone ? "#10b981" : isCreative ? T.purpleBright : s.dot;
  const selectedBorder = isCreative ? T.purpleBright + "60" : s.dot + "60";
  const selectedBg = isCreative ? T.purpleTint : s.bg;
  return (
    <div
      onClick={() => onClick(issue)}
      style={{
        position: "relative",
        padding: "12px 14px 12px 18px",
        borderRadius: 10,
        background: isSelected ? selectedBg : "rgba(255,255,255,0.02)",
        border: `1px solid ${isSelected ? selectedBorder : T.border}`,
        cursor: "pointer",
        transition: "all 0.15s",
        opacity: isDone ? 0.55 : 1,
        boxShadow: isSelected && isCreative ? "0 0 24px rgba(168,85,247,0.15)" : "none",
      }}
    >
      <div style={{ position: "absolute", left: 0, top: 12, bottom: 12, width: 3, background: stripeColor, borderRadius: 2 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        {issue.ts != null && (
          <span style={{
            fontSize: 11,
            fontFamily: "DM Mono, monospace",
            color: isCreative ? T.purpleLight : T.redLight,
            fontWeight: 600,
          }}>
            ▶ {fmtTs(issue.ts)}
          </span>
        )}
        {isCreative ? (
          <span style={{
            fontSize: 9,
            padding: "2px 7px",
            borderRadius: 4,
            background: T.purpleTint,
            color: T.purpleLight,
            fontWeight: 800,
            letterSpacing: "0.06em",
            border: `1px solid ${T.borderPurple}`,
          }}>
            💡 IDEA
          </span>
        ) : (
          <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 4, background: s.badge, color: s.badgeText, fontWeight: 800, letterSpacing: "0.06em" }}>
            {s.label}
          </span>
        )}
        {!isCreative && issue.confidence && (
          <span title={`${issue.confidence} confidence`} style={{
            fontSize: 8.5, padding: "2px 6px", borderRadius: 4, fontWeight: 800,
            letterSpacing: "0.06em", textTransform: "uppercase",
            background: issue.confidence === "high" ? T.red : issue.confidence === "medium" ? "rgba(245,158,11,0.12)" : "rgba(255,255,255,0.06)",
            color: issue.confidence === "high" ? "white" : issue.confidence === "medium" ? "#fcd34d" : T.textDim,
            border: `1px solid ${issue.confidence === "high" ? T.red : issue.confidence === "medium" ? "rgba(245,158,11,0.3)" : T.border}`,
            boxShadow: issue.confidence === "high" ? "0 1px 6px rgba(220,38,38,0.4)" : "none",
          }}>
            {issue.confidence}
          </span>
        )}
        {!isCreative && (
          <span title={tr.label} style={{ fontSize: 8.5, padding: "2px 6px", borderRadius: 4, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: tr.color, background: `${tr.color}1a`, border: `1px solid ${tr.color}55` }}>
            {tr.short}
          </span>
        )}
        {!isCreative && issue.textSource === "visual" && (
          <span title="From incidental in-shot text (iPad / whiteboard / slide / UI), not the caption layer" style={{ fontSize: 8.5, padding: "2px 6px", borderRadius: 4, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#7dd3fc", background: "rgba(125,211,252,0.10)", border: "1px solid rgba(125,211,252,0.4)" }}>
            📺 Visual text
          </span>
        )}
        <span style={{ fontSize: 11, color: T.textDim, marginLeft: "auto" }}>
          {check?.icon} {check?.label}
        </span>
      </div>
      <p style={{ fontSize: 13, color: "white", lineHeight: 1.45, fontWeight: 600, textDecoration: isDone ? "line-through" : "none" }}>{issue.msg}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>
        {issue.captionText && (
          <p style={{ fontSize: 11.5, lineHeight: 1.5, margin: 0 }}>
            <span style={{ color: T.textDim }}>Caption: </span>
            <span style={{ color: "rgba(255,255,255,0.85)" }}>“{issue.captionText}”</span>
          </p>
        )}
        {issue.audioText && (
          <p style={{ fontSize: 11.5, lineHeight: 1.5, margin: 0 }}>
            <span style={{ color: T.textDim }}>🎙 Voiceover: </span>
            <span style={{ color: "rgba(255,255,255,0.85)" }}>“{issue.audioText}”</span>
          </p>
        )}
        {issue.why && (
          <p style={{ fontSize: 11, lineHeight: 1.5, margin: 0, color: T.textMute }}>
            <span style={{ color: T.textDim }}>Why: </span>{issue.why}
          </p>
        )}
        {issue.fix && (
          <p style={{ fontSize: 11, lineHeight: 1.5, margin: 0, color: T.redLight }}>
            <span style={{ color: T.textDim }}>Fix: </span>{issue.fix}
          </p>
        )}
      </div>
      {onToggleDone && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleDone(issue.id); }}
            style={{
              padding: "6px 12px", borderRadius: 8, cursor: "pointer",
              border: `1px solid ${isDone ? "rgba(16,185,129,0.5)" : T.border}`,
              background: isDone ? "rgba(16,185,129,0.12)" : "rgba(255,255,255,0.04)",
              color: isDone ? "#34d399" : T.textMute, fontSize: 11, fontWeight: 700,
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            {isDone ? "✓ Done — reopen" : "✓ Mark done"}
          </button>
          {onLearnCorrect && !isCreative && !learning && (
            <button
              onClick={(e) => { e.stopPropagation(); setTerm(issue.captionText || ""); setLearning(true); }}
              title="Tell the AI this is actually correct — it won't flag this word again on any video"
              style={{
                padding: "6px 12px", borderRadius: 8, cursor: "pointer",
                border: `1px solid ${T.border}`, background: "rgba(255,255,255,0.04)",
                color: T.textMute, fontSize: 11, fontWeight: 700,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              ✗ Not an error — learn
            </button>
          )}
        </div>
      )}
      {learning && (
        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "rgba(125,211,252,0.06)", border: "1px solid rgba(125,211,252,0.3)" }}>
          <p style={{ fontSize: 10.5, color: T.textDim, marginBottom: 6, lineHeight: 1.4 }}>
            Mark as correct — the AI will never flag this word again (on any video). Trim to just the correct word for best reuse.
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input
              value={term}
              autoFocus
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && term.trim()) { onLearnCorrect(issue, term.trim()); } if (e.key === "Escape") setLearning(false); }}
              placeholder="correct word or phrase"
              style={{ flex: 1, minWidth: 150, padding: "6px 10px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: `1px solid ${T.border}`, color: "white", fontSize: 11.5, outline: "none" }}
            />
            <button
              onClick={() => { const t = term.trim(); if (t) onLearnCorrect(issue, t); }}
              style={{ padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid rgba(125,211,252,0.5)", background: "rgba(125,211,252,0.14)", color: "#7dd3fc", fontSize: 11, fontWeight: 800 }}
            >
              ✓ Learn word
            </button>
            <button
              onClick={() => setLearning(false)}
              style={{ padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: `1px solid ${T.border}`, background: "rgba(255,255,255,0.04)", color: T.textDim, fontSize: 11, fontWeight: 700 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {onFeedback && !isCreative && (
        fbSent ? (
          <p style={{ marginTop: 8, fontSize: 10.5, color: "#34d399", fontWeight: 700 }}>✓ Feedback logged for QC review</p>
        ) : !fbOpen ? (
          <button
            onClick={(e) => { e.stopPropagation(); setFbOpen(true); }}
            title="Admin: rate this finding to improve QC"
            style={{ marginTop: 8, padding: "5px 10px", borderRadius: 8, cursor: "pointer", border: `1px dashed ${T.border}`, background: "rgba(255,255,255,0.03)", color: T.textDim, fontSize: 10.5, fontWeight: 700 }}
          >
            ⚑ QC feedback
          </button>
        ) : (
          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 8, padding: 10, borderRadius: 8, background: "rgba(168,85,247,0.06)", border: "1px solid rgba(168,85,247,0.3)" }}>
            <p style={{ fontSize: 10.5, color: T.textDim, marginBottom: 6 }}>Admin feedback — how did QC do on this finding?</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {FEEDBACK_TYPES.filter((t) => t.id !== "missed").map((t) => (
                <button key={t.id} onClick={() => setFbType(t.id)}
                  style={{ padding: "4px 9px", borderRadius: 7, cursor: "pointer", fontSize: 10.5, fontWeight: 700,
                    color: fbType === t.id ? "#fff" : t.color, background: fbType === t.id ? t.color : `${t.color}1a`,
                    border: `1px solid ${t.color}66` }}>{t.label}</button>
              ))}
            </div>
            <input value={fbNote} onChange={(e) => setFbNote(e.target.value)} placeholder="Note (optional)"
              style={{ width: "100%", padding: "6px 10px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: `1px solid ${T.border}`, color: "white", fontSize: 11, outline: "none", marginBottom: 8 }} />
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => { if (fbType) { onFeedback({ type: fbType, issueId: issue.id, caption: issue.captionText, msg: issue.msg, note: fbNote.trim() || null }); setFbSent(true); } }}
                disabled={!fbType}
                style={{ padding: "6px 12px", borderRadius: 8, cursor: fbType ? "pointer" : "not-allowed", border: "none", background: fbType ? T.gradientPurple : "rgba(255,255,255,0.06)", color: fbType ? "white" : T.textDim, fontSize: 11, fontWeight: 800 }}
              >
                Log feedback
              </button>
              <button onClick={() => { setFbOpen(false); setFbType(null); setFbNote(""); }} style={{ padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: `1px solid ${T.border}`, background: "rgba(255,255,255,0.04)", color: T.textDim, fontSize: 11, fontWeight: 700 }}>Cancel</button>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function Nav({ apiStatus, user, onLogout, isAdminUser, onAdmin }) {
  const dotColor = !apiStatus.probed ? "#94a3b8" : apiStatus.ok ? "#10b981" : T.redBright;
  const dotLabel = !apiStatus.probed ? "Checking API…" : apiStatus.ok ? "API connected" : "API unavailable";
  return (
    <nav style={{ borderBottom: `1px solid ${T.border}`, background: "rgba(10,6,8,0.97)", backdropFilter: "blur(20px)", position: "sticky", top: 0, zIndex: 50 }}>
      <div style={{ maxWidth: 1480, margin: "0 auto", padding: "0 24px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 9, background: T.gradient, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, letterSpacing: "-0.02em", boxShadow: "0 4px 12px rgba(220,38,38,0.3)" }}>BB</div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: "-0.01em" }}>BB QC Labs</span>
            <span style={{ fontSize: 10, color: T.textDim, letterSpacing: "0.04em" }}>Video Quality Control</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 12px", borderRadius: 20, background: "rgba(255,255,255,0.04)", border: `1px solid ${T.border}` }} title={apiStatus.detail || ""}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, boxShadow: `0 0 8px ${dotColor}` }} />
            <span style={{ fontSize: 12, color: T.textMute }}>{dotLabel}</span>
          </div>
          {user && isAdminUser && onAdmin && (
            <button onClick={onAdmin} title="Admin · QC monitor (all scans on this device)" style={{ fontSize: 11, fontWeight: 800, color: T.redLight, background: T.redTint, border: `1px solid ${T.borderHot}`, borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>🛡 Admin</button>
          )}
          {user && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div title={user} style={{ width: 30, height: 30, borderRadius: "50%", background: T.gradientPurple, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, textTransform: "uppercase" }}>{user.slice(0, 1)}</div>
              <span style={{ fontSize: 13, color: "white", fontWeight: 600, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user}</span>
              <button onClick={onLogout} title="Log out" style={{ fontSize: 11, color: T.textDim, background: "rgba(255,255,255,0.04)", border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer" }}>Log out</button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

function MagicPresetChips({ activeId, onPick }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
      {PRESETS.map((p) => {
        const isActive = activeId === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            title={p.text}
            style={{
              padding: "7px 14px",
              borderRadius: 22,
              background: isActive ? T.gradientPurple : "rgba(255,255,255,0.025)",
              border: `1px solid ${isActive ? T.borderPurple : T.border}`,
              color: isActive ? "white" : T.textMute,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              transition: "all 0.15s",
              boxShadow: isActive ? "0 4px 14px rgba(168,85,247,0.3)" : "none",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.borderColor = T.borderPurple; }}
            onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.borderColor = T.border; }}
          >
            <span style={{ fontSize: 13 }}>{p.icon}</span>
            <span>{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function UploadStage({ dragOver, setDragOver, handleDrop, handleFile, fileRef, apiStatus, onDashboard }) {
  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 108px)", paddingTop: 40, paddingBottom: 40 }}>
      {onDashboard && (
        <button onClick={onDashboard} style={{ alignSelf: "flex-start", marginBottom: 12, padding: "8px 14px", borderRadius: 9, background: "rgba(255,255,255,0.05)", color: T.textMute, fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${T.border}` }}>
          ← Dashboard
        </button>
      )}
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <h1 style={{ fontSize: 44, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.05 }}>
          Catch every QC mistake.<br />
          <span style={{ background: T.gradientText, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            Before delivery.
          </span>
        </h1>
        <p style={{ color: T.textDim, marginTop: 14, fontSize: 15, maxWidth: 540 }}>
          Drop a video. Claude reads every on-screen frame, spell-checks captions and titles, and flags safe-zone violations — with timestamps.
        </p>
      </div>

      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        style={{
          width: "100%", maxWidth: 540,
          border: `2px dashed ${dragOver ? T.red : "rgba(255,255,255,0.12)"}`,
          borderRadius: 20, padding: "60px 40px", textAlign: "center", cursor: "pointer",
          background: dragOver ? T.redTint : "rgba(255,255,255,0.02)",
          transition: "all 0.2s",
        }}
      >
        <div style={{ fontSize: 46, marginBottom: 16 }}>🎥</div>
        <p style={{ fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Drop your video here</p>
        <p style={{ color: T.textDim, fontSize: 13, marginBottom: 24 }}>MP4, MOV, WebM, AVI — up to ~500 MB recommended</p>
        <span style={{ background: T.gradient, padding: "11px 32px", borderRadius: 10, fontSize: 13, fontWeight: 700, display: "inline-block", boxShadow: "0 4px 14px rgba(220,38,38,0.35)" }}>
          Select Video File
        </span>
        <input ref={fileRef} type="file" accept="video/*" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
      </div>

      <p style={{ color: T.textMute, fontSize: 12, marginTop: 16 }}>
        After you pick a file you'll get a review step — add a brief / magic preset, then start the scan.
      </p>

      <div style={{ display: "flex", gap: 20, marginTop: 28, flexWrap: "wrap", justifyContent: "center", maxWidth: 700 }}>
        {CHECKS.filter(c => c.id !== "audio" && c.id !== "metadata").map(c => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, color: T.textDim, fontSize: 13 }}>
            <span>{c.icon}</span><span>{c.label}</span>
          </div>
        ))}
      </div>

      {apiStatus.probed && !apiStatus.ok && (
        <div style={{ marginTop: 32, maxWidth: 540, padding: "12px 16px", borderRadius: 10, background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.3)", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span style={{ fontSize: 16 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: T.redLight, marginBottom: 4 }}>API not reachable</p>
            <p style={{ fontSize: 12, color: T.textMute, lineHeight: 1.5 }}>
              {apiStatus.detail || "The Anthropic API isn't responding."} Make sure <code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 5px", borderRadius: 3 }}>ANTHROPIC_API_KEY</code> is set in <code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 5px", borderRadius: 3 }}>.env</code> and restart the dev server (<code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 5px", borderRadius: 3 }}>Ctrl+C</code> → <code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 5px", borderRadius: 3 }}>npm run dev</code>).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Review step shown after a file is picked and BEFORE scanning starts. Lets the
// user preview the video, set the magic-prompt brief, then explicitly start.
// Small stat cell used by the cost calculator.
function Stat({ label, value, highlight }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: highlight ? "#34d399" : "white", fontFamily: "DM Mono, monospace" }}>{value}</div>
      <div style={{ fontSize: 10, color: T.textDim, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function ConfirmStage({ file, videoUrl, onStart, onBack, referenceBrief, setReferenceBrief, activePresetId, setActivePresetId, mode, setMode, scopeMode, setScopeMode }) {
  const briefChars = referenceBrief.length;
  const briefLimit = 4000;
  const sizeMb = file ? (file.size / (1024 * 1024)).toFixed(1) : "0";

  // Video metadata (read from the preview element) → live cost estimate.
  const [meta, setMeta] = useState({ duration: 0, w: 0, h: 0 });
  const est = useMemo(
    () => (meta.duration > 0 ? estimateScanCost(meta.duration, meta.w, meta.h, MODES[mode]) : null),
    [meta, mode]
  );

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", minHeight: "calc(100vh - 108px)", paddingTop: 32, paddingBottom: 48 }}>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>Review &amp; start scan</h1>
        <p style={{ color: T.textDim, marginTop: 8, fontSize: 14, maxWidth: 540 }}>
          Add an optional brief or pick a magic preset, then start. Nothing runs until you click <strong>Start QC Scan</strong>.
        </p>
      </div>

      {/* Video preview + file meta */}
      <div style={{ width: "100%", maxWidth: 540, marginBottom: 20 }}>
        <div style={{ borderRadius: 14, overflow: "hidden", border: `1px solid ${T.border}`, background: "#000" }}>
          {videoUrl ? (
            <video
              src={videoUrl}
              controls
              muted
              playsInline
              onLoadedMetadata={e => {
                const v = e.currentTarget;
                setMeta({
                  duration: isFinite(v.duration) ? v.duration : 0,
                  w: v.videoWidth || 0,
                  h: v.videoHeight || 0,
                });
              }}
              style={{ width: "100%", display: "block", maxHeight: 300, background: "#000" }}
            />
          ) : (
            <div style={{ padding: 40, textAlign: "center", color: T.textDim }}>Loading preview…</div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, gap: 12 }}>
          <span style={{ fontSize: 13, color: "white", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🎬 {file?.name}</span>
          <span style={{ fontSize: 12, color: T.textDim, fontFamily: "DM Mono, monospace", flexShrink: 0 }}>
            {meta.w > 0 ? `${meta.w}×${meta.h} · ` : ""}{meta.duration > 0 ? fmtTs(meta.duration) + " · " : ""}{sizeMb} MB
          </span>
        </div>
      </div>

      {/* ── Speed-mode selector ──────────────────────────────────────────── */}
      <ModeSelector mode={mode} setMode={setMode} />

      {/* ── Text-scope selector (captions only vs all on-screen text) ──────── */}
      <ScopeSelector scopeMode={scopeMode} setScopeMode={setScopeMode} />

      {/* ── Cost calculator ──────────────────────────────────────────────── */}
      <div style={{ width: "100%", maxWidth: 540, marginBottom: 20, padding: "14px 16px", borderRadius: 12, background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.25)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: T.textMute, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>💰 Estimated cost of this scan</span>
          <span style={{ fontSize: 10, color: T.textDim }}>{MODES[mode].label} · {MODES[mode].model.replace("claude-", "")} · ${MODES[mode].priceIn}/M in · ${MODES[mode].priceOut}/M out</span>
        </div>
        {est ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 10 }}>
              <Stat label="Frames scanned" value={est.frames} />
              <Stat label="API calls" value={est.calls} />
              <Stat label="Input tokens" value={`~${(est.inputTokens / 1000).toFixed(0)}K`} />
              <Stat label="Est. cost" value={`$${est.cost.toFixed(2)}`} highlight />
            </div>
            <p style={{ fontSize: 11, color: T.textDim, lineHeight: 1.5, margin: 0 }}>
              ≈ <strong style={{ color: "white" }}>${est.cost.toFixed(2)}</strong> for this video ({est.frames} frames at {est.tokensPerImage} tokens each, across {est.calls} batched calls). Real cost varies with how many findings come back. This is deducted from your Anthropic credit.
            </p>
          </>
        ) : (
          <p style={{ fontSize: 12, color: T.textDim, margin: 0 }}>Reading video length to estimate cost…</p>
        )}
      </div>

      {/* ── Magic prompt tool: Reference Brief / Script / Editor Notes ─────── */}
      <div style={{ width: "100%", maxWidth: 540 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <label htmlFor="ref-brief" style={{ fontSize: 11, color: T.textMute, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            ✨ Magic Prompt · Brief / Script / Notes
            <span style={{ color: T.textDim, fontWeight: 500, letterSpacing: "0.02em", textTransform: "none", marginLeft: 6 }}>· optional</span>
          </label>
          <span style={{ fontSize: 10, color: briefChars > briefLimit ? T.redBright : T.textDim, fontFamily: "DM Mono, monospace" }}>
            {briefChars}/{briefLimit}
          </span>
        </div>

        {/* One-click magic-prompt preset chips. Click → fills the textarea. */}
        <MagicPresetChips
          activeId={activePresetId}
          onPick={(p) => { setReferenceBrief(p.text); setActivePresetId(p.id); }}
        />

        <textarea
          id="ref-brief"
          value={referenceBrief}
          onChange={(e) => {
            setReferenceBrief(e.target.value);
            const match = PRESETS.find(p => p.text === e.target.value);
            setActivePresetId(match ? match.id : null);
          }}
          rows={5}
          placeholder={`Paste your script, brand guidelines, or specific checks here. Or tap a preset above.`}
          style={{
            width: "100%", padding: "12px 14px", borderRadius: 10,
            background: "rgba(255,255,255,0.025)",
            border: `1px solid ${referenceBrief ? T.borderHot : T.border}`,
            color: "white", fontSize: 12, fontFamily: "DM Sans, sans-serif",
            lineHeight: 1.55, resize: "vertical", minHeight: 110, outline: "none",
            transition: "border-color 0.2s", boxSizing: "border-box",
          }}
          onFocus={(e) => { e.target.style.borderColor = T.red; }}
          onBlur={(e) => { e.target.style.borderColor = referenceBrief ? T.borderHot : T.border; }}
        />
        <p style={{ fontSize: 11, color: T.textDim, marginTop: 6, lineHeight: 1.5 }}>
          {referenceBrief
            ? <>✓ Claude will cross-reference the video against these instructions and perform an exhaustive pass.</>
            : <>If provided, Claude will strictly audit the video against these requirements — wrong prices, missing brand terms, off-script copy, etc.</>
          }
        </p>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 12, marginTop: 24, width: "100%", maxWidth: 540 }}>
        <button
          onClick={onBack}
          style={{
            flexShrink: 0, padding: "13px 20px", borderRadius: 10, cursor: "pointer",
            background: "rgba(255,255,255,0.04)", border: `1px solid ${T.border}`,
            color: T.textDim, fontSize: 13, fontWeight: 600,
          }}
        >
          ← Different video
        </button>
        <button
          onClick={onStart}
          style={{
            flex: 1, padding: "13px 20px", borderRadius: 10, cursor: "pointer",
            background: T.gradient, border: "none", color: "white",
            fontSize: 14, fontWeight: 800, letterSpacing: "0.01em",
            boxShadow: "0 4px 14px rgba(220,38,38,0.35)",
          }}
        >
          ▶ Start QC Scan
        </button>
      </div>
      <p style={{ fontSize: 11, color: T.textMute, marginTop: 12, textAlign: "center", maxWidth: 540 }}>
        Exhaustive mode: every distinct frame is scanned across many batched calls. A longer clip can take a few minutes — that's the cost of missing nothing.
      </p>
    </div>
  );
}

function PhaseRow({ done, active, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderRadius: 10, background: active ? T.redTint : "rgba(255,255,255,0.02)", border: `1px solid ${active ? T.borderHot : T.border}` }}>
      {done && <span style={{ color: "#10b981", fontSize: 14 }}>✓</span>}
      {active && <div style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${T.red}`, borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />}
      {!done && !active && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.15)" }} />}
      <span style={{ fontSize: 13, color: active ? "white" : T.textMute }}>{label}</span>
    </div>
  );
}

function AnalyzingStage({ file, phase, progress, error, onCancel, deadline, capMs }) {
  const phaseLabels = {
    extracting: { title: "Extracting frames", subtitle: "Densely sampling the video so no on-screen text is missed" },
    analyzing:  { title: "Analyzing with Claude vision", subtitle: "Scanning every frame across batched calls — this can take a few minutes" },
    finalizing: { title: "Compiling report",  subtitle: "Merging duplicate findings and sorting by timestamp" },
  };
  const current = phaseLabels[phase] || phaseLabels.extracting;
  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 108px)" }}>
      <div style={{ width: "100%", maxWidth: 540 }}>
        {error ? (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Analysis failed</h2>
            <p style={{ color: T.textDim, fontSize: 13, marginBottom: 24 }}>{file?.name}</p>
            <div style={{ padding: "14px 18px", borderRadius: 10, background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.3)", marginBottom: 24, textAlign: "left" }}>
              <p style={{ fontSize: 12, color: T.redLight, fontWeight: 700, marginBottom: 6, letterSpacing: "0.04em" }}>ERROR</p>
              <p style={{ fontSize: 13, color: "white", lineHeight: 1.5, fontFamily: "DM Mono, monospace" }}>{error}</p>
              <p style={{ fontSize: 11, color: T.textDim, lineHeight: 1.6, marginTop: 12 }}>
                Check the terminal where you ran <code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 4px", borderRadius: 3 }}>npm run dev</code> for proxy errors. Most common causes: missing <code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 4px", borderRadius: 3 }}>ANTHROPIC_API_KEY</code> (restart the dev server after setting it), unsupported video codec, no API credit.
              </p>
            </div>
            <button onClick={onCancel} style={{ padding: "10px 28px", borderRadius: 10, background: T.gradient, color: "white", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              ↩ Try another file
            </button>
          </div>
        ) : (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 20, animation: "pulse 2s ease-in-out infinite" }}>🔍</div>
            <h2 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6 }}>{current.title}</h2>
            <p style={{ color: T.textDim, fontSize: 13, marginBottom: 8 }}>{current.subtitle}</p>
            <p style={{ color: T.textMute, fontSize: 12, marginBottom: 24, fontFamily: "DM Mono, monospace" }}>{file?.name}</p>

            <Countdown deadline={deadline} capMs={capMs} />

            <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 6, marginBottom: 12, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${pct}%`,
                background: T.gradient,
                borderRadius: 6,
                transition: "width 0.4s ease",
                boxShadow: "0 0 12px rgba(220,38,38,0.5)",
              }} />
            </div>
            <p style={{ fontSize: 12, color: T.textDim, fontFamily: "DM Mono, monospace", marginBottom: 32 }}>
              {progress.current} / {progress.total}
              {phase === "extracting" && " frames captured"}
              {phase === "analyzing" && " (Claude is reading the frames…)"}
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, textAlign: "left" }}>
              <PhaseRow done={phase !== "extracting" || progress.current === progress.total} active={phase === "extracting"} label="Extract frames from video" />
              <PhaseRow done={phase === "finalizing"} active={phase === "analyzing"} label="Send frames to Claude vision API" />
              <PhaseRow done={false} active={phase === "finalizing"} label="Compile QC report" />
            </div>

            <button onClick={onCancel} style={{ marginTop: 32, padding: "8px 20px", borderRadius: 8, background: "rgba(255,255,255,0.04)", color: T.textMute, fontSize: 12, fontWeight: 500, cursor: "pointer", border: `1px solid ${T.border}` }}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ ring, score, value, label, color }) {
  return (
    <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 18px", display: "flex", flexDirection: "column", alignItems: ring ? "center" : "flex-start", gap: 6 }}>
      {ring ? (
        <>
          <ScoreRing score={score} size={58} />
          <p style={{ fontSize: 11, color: T.textDim }}>{label}</p>
        </>
      ) : (
        <>
          <p style={{ fontSize: 11, color: T.textDim, fontWeight: 500 }}>{label}</p>
          <p style={{ fontSize: 28, fontWeight: 800, color, fontFamily: "DM Mono, monospace", lineHeight: 1 }}>{value}</p>
        </>
      )}
    </div>
  );
}

function FilterChip({ label, count, active, onClick, color }) {
  const c = color || T.redLight;
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 10px",
        borderRadius: 20,
        background: active ? T.redTint : "rgba(255,255,255,0.03)",
        border: `1px solid ${active ? T.borderHot : T.border}`,
        color: active ? c : T.textMute,
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
        transition: "all 0.15s",
      }}
    >
      {label}
      <span style={{ fontSize: 10, color: active ? c : T.textDim, fontFamily: "DM Mono, monospace" }}>{count}</span>
    </button>
  );
}

// "Learned corrections" manager — review/remove what the AI has been taught.
function MemoryPanel({ memory, onUnlearn, onClose }) {
  const allow = memory?.allow || [], typos = memory?.typos || [];
  const chip = (children, key, onX) => (
    <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 20, background: "rgba(255,255,255,0.05)", border: `1px solid ${T.border}`, fontSize: 11.5, color: "white" }}>
      {children}
      <button onClick={onX} title="Forget this" style={{ cursor: "pointer", color: T.textDim, fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
    </span>
  );
  return (
    <div style={{ marginBottom: 20, padding: 18, borderRadius: 14, background: T.bgPanel, border: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15 }}>🧠</span>
          <span style={{ fontSize: 14, fontWeight: 800 }}>Learned corrections</span>
          <span style={{ fontSize: 11, color: T.textDim }}>· applies to all your future scans</span>
        </div>
        <button onClick={onClose} style={{ cursor: "pointer", color: T.textDim, fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: "rgba(255,255,255,0.04)" }}>Close</button>
      </div>

      <div style={{ fontSize: 11, color: T.textMute, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
        ✓ Always correct · never flag ({allow.length})
      </div>
      {allow.length === 0 ? (
        <p style={{ fontSize: 11.5, color: T.textDim, marginBottom: 14 }}>Nothing yet. On a wrong finding, click <strong>“✗ Not an error — learn”</strong> to teach the AI a word is correct.</p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          {allow.map((a, i) => chip(<span>“{a.term}”</span>, `a${i}`, () => onUnlearn("allow", i)))}
        </div>
      )}

      <div style={{ fontSize: 11, color: T.textMute, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
        🔎 Known mistakes · always catch ({typos.length})
      </div>
      {typos.length === 0 ? (
        <p style={{ fontSize: 11.5, color: T.textDim }}>Nothing yet. Use <strong>“+ Add missed issue”</strong> to record a typo the AI should always catch.</p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {typos.map((t, i) => chip(<span style={{ fontFamily: "DM Mono, monospace" }}>“{t.wrong}” → “{t.right}”</span>, `t${i}`, () => onUnlearn("typos", i)))}
        </div>
      )}
    </div>
  );
}

// Inline form to add a finding the AI missed (and remember it for next time).
function AddMissedForm({ defaultTs, onAdd, onClose }) {
  const [wrong, setWrong] = useState("");
  const [right, setRight] = useState("");
  const [note, setNote] = useState("");
  const fld = { padding: "7px 10px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: `1px solid ${T.border}`, color: "white", fontSize: 12, outline: "none", width: "100%" };
  const save = () => { if (wrong.trim() || right.trim() || note.trim()) { onAdd({ ts: defaultTs, wrong, right, note }); onClose(); } };
  return (
    <div style={{ padding: 12, borderRadius: 10, background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.3)", marginBottom: 8 }}>
      <p style={{ fontSize: 11, color: T.textDim, marginBottom: 8, lineHeight: 1.45 }}>
        Add an issue the AI missed at <strong style={{ color: "white" }}>{fmtTs(defaultTs ?? 0)}</strong>. If you fill both fields, the AI will watch for this typo on every future scan.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <input value={wrong} autoFocus onChange={(e) => setWrong(e.target.value)} placeholder="Wrong text on screen (e.g. Bedrtoom)" style={fld} />
        <input value={right} onChange={(e) => setRight(e.target.value)} placeholder="Should be (e.g. Bedroom)" style={fld} />
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" style={{ ...fld, marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={save} style={{ padding: "7px 14px", borderRadius: 8, cursor: "pointer", border: "none", background: T.gradient, color: "white", fontSize: 11.5, fontWeight: 800 }}>＋ Add to report</button>
        <button onClick={onClose} style={{ padding: "7px 14px", borderRadius: 8, cursor: "pointer", border: `1px solid ${T.border}`, background: "rgba(255,255,255,0.04)", color: T.textDim, fontSize: 11.5, fontWeight: 700 }}>Cancel</button>
      </div>
    </div>
  );
}

function ResultsStage(props) {
  const {
    file, videoUrl, videoRef, seekFromExternal, videoDuration, setVideoDuration,
    issues, filteredIssues, activeFilter, setActiveFilter,
    activeTab, setActiveTab,
    currentTs, setCurrentTs, selectedIssue, seekToIssue, navigateIssue,
    mistakeCount, reviewCount, styleCount, doneCount,
    overallScore, onNewUpload, onExport, onRecheck, doneIds, toggleDone, briefWasUsed,
    memory, onLearnCorrect, onAddMissed, onUnlearn, onFeedback,
  } = props;
  const [showMemory, setShowMemory] = useState(false);
  const [adding, setAdding] = useState(false);
  const learnedCount = (memory?.allow?.length || 0) + (memory?.typos?.length || 0);

  const timedIssues = issues.filter(i => i.ts != null);
  const checkCounts = useMemo(() => {
    const c = {};
    for (const i of issues) c[i.checkId] = (c[i.checkId] || 0) + 1;
    return c;
  }, [issues]);

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.01em" }}>QC Report</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
            <p style={{ color: T.textDim, fontSize: 13 }}>
              {file?.name} · {issues.length} issues · {fmtTs(Math.round(videoDuration))}
            </p>
            {briefWasUsed && (
              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: T.redTint, color: T.redLight, fontWeight: 700, letterSpacing: "0.04em", border: `1px solid ${T.borderHot}` }}>
                BRIEF APPLIED ✓
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onNewUpload} style={{ padding: "9px 18px", borderRadius: 9, background: "rgba(255,255,255,0.05)", color: T.textMute, fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${T.border}` }}>
            ← Dashboard
          </button>
          {onRecheck && file && (
            <button onClick={onRecheck} title="Re-run QC on this same video — no re-upload needed" style={{ padding: "9px 16px", borderRadius: 9, background: "rgba(255,255,255,0.05)", color: T.textMute, fontSize: 12, fontWeight: 700, cursor: "pointer", border: `1px solid ${T.border}` }}>
              ↻ Re-check
            </button>
          )}
          {onUnlearn && (
            <button onClick={() => setShowMemory((v) => !v)} title="Review what the AI has learned" style={{ padding: "9px 16px", borderRadius: 9, background: showMemory ? T.redTint : "rgba(255,255,255,0.05)", color: showMemory ? T.redLight : T.textMute, fontSize: 12, fontWeight: 700, cursor: "pointer", border: `1px solid ${showMemory ? T.borderHot : T.border}` }}>
              🧠 Learned {learnedCount > 0 ? `(${learnedCount})` : ""}
            </button>
          )}
          <button onClick={onExport} style={{ padding: "9px 18px", borderRadius: 9, background: T.gradient, color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer", boxShadow: "0 2px 8px rgba(220,38,38,0.3)" }}>
            ⬇ Export PDF
          </button>
        </div>
      </div>

      {showMemory && onUnlearn && (
        <MemoryPanel memory={memory} onUnlearn={onUnlearn} onClose={() => setShowMemory(false)} />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 24 }}>
        <StatCard ring score={overallScore} label="Overall Score" />
        <StatCard value={mistakeCount} label="Actual Mistakes" color={T.redBright} />
        <StatCard value={reviewCount} label="Needs Review" color="#f59e0b" />
        <StatCard value={styleCount} label="Optional Style" color="#94a3b8" />
        <StatCard value={doneCount} label="Done" color="#10b981" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(340px, 1fr)", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden" }}>
            <div style={{ position: "relative", background: "#000", aspectRatio: "16/9" }}>
              {videoUrl ? (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  onLoadedMetadata={e => { const d = e.currentTarget.duration; if (isFinite(d) && d > 0) setVideoDuration(d); }}
                  onTimeUpdate={e => {
                    if (seekFromExternal.current) { seekFromExternal.current = false; return; }
                    setCurrentTs(e.currentTarget.currentTime);
                  }}
                  style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", background: "#000" }}
                  controls
                />
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: T.textDim, fontSize: 14 }}>
                  No video loaded
                </div>
              )}
              <div style={{ position: "absolute", bottom: 12, right: 12, background: "rgba(0,0,0,0.75)", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontFamily: "DM Mono, monospace", color: "white", pointerEvents: "none", backdropFilter: "blur(6px)" }}>
                {fmtTs(currentTs ?? 0)} / {fmtTs(videoDuration)}
              </div>
            </div>
          </div>

          <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 16, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14 }}>⏱</span>
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.02em" }}>Issue Timeline</span>
                <span style={{ fontSize: 11, color: T.textDim }}>· {timedIssues.length} timed issues</span>
              </div>
              {currentTs != null && (
                <span style={{ fontSize: 11, fontFamily: "DM Mono, monospace", color: T.redLight, background: T.redTint, padding: "3px 10px", borderRadius: 20, fontWeight: 700 }}>
                  ▶ {fmtTs(currentTs)}
                </span>
              )}
            </div>
            <Timeline
              issues={issues}
              currentTs={currentTs}
              duration={videoDuration}
              doneIds={doneIds}
              onSeek={(ts) => {
                setCurrentTs(ts);
                if (timedIssues.length === 0) return;
                const closest = timedIssues.reduce((p, c) => Math.abs(c.ts - ts) < Math.abs(p.ts - ts) ? c : p, timedIssues[0]);
                const snapWindow = Math.max(2, videoDuration * 0.03);
                if (closest && Math.abs(closest.ts - ts) < snapWindow) seekToIssue(closest);
              }}
            />
            <div style={{ display: "flex", gap: 16, marginTop: 24, flexWrap: "wrap" }}>
              {Object.entries(SEV).map(([key, s]) => (
                <div key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: s.dot }} />
                  <span style={{ fontSize: 11, color: T.textDim, textTransform: "capitalize" }}>{key}</span>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "transparent", border: `2px solid ${T.purpleBright}` }} />
                <span style={{ fontSize: 11, color: T.textDim }}>creative idea</span>
              </div>
            </div>
          </div>

          {selectedIssue && (
            <div style={{ background: T.bgPanel, border: `1px solid ${SEV[selectedIssue.severity].dot}50`, borderRadius: 16, padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, padding: "3px 9px", borderRadius: 4, background: SEV[selectedIssue.severity].badge, color: SEV[selectedIssue.severity].badgeText, fontWeight: 800, letterSpacing: "0.06em" }}>
                  {SEV[selectedIssue.severity].label}
                </span>
                {selectedIssue.ts != null && (
                  <span style={{ fontSize: 12, fontFamily: "DM Mono, monospace", color: T.redLight, fontWeight: 600 }}>
                    ▶ {fmtTs(selectedIssue.ts)}
                  </span>
                )}
                <span style={{ fontSize: 12, color: T.textDim }}>
                  {CHECKS.find(c => c.id === selectedIssue.checkId)?.icon} {CHECKS.find(c => c.id === selectedIssue.checkId)?.label}
                </span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button onClick={() => navigateIssue("prev")} style={{ padding: "5px 12px", borderRadius: 7, background: "rgba(255,255,255,0.05)", color: T.textMute, fontSize: 11, cursor: "pointer", border: `1px solid ${T.border}` }}>← Prev</button>
                  <button onClick={() => navigateIssue("next")} style={{ padding: "5px 12px", borderRadius: 7, background: "rgba(255,255,255,0.05)", color: T.textMute, fontSize: 11, cursor: "pointer", border: `1px solid ${T.border}` }}>Next →</button>
                </div>
              </div>
              <p style={{ fontSize: 16, fontWeight: 600, color: "white", lineHeight: 1.4, marginBottom: 12 }}>{selectedIssue.msg}</p>
              {selectedIssue.fix && (
                <div style={{ background: T.redTint, border: `1px solid ${T.borderHot}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 20, height: 20, borderRadius: 5, background: T.gradient, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>✦</div>
                    <span style={{ fontSize: 11, fontWeight: 800, color: T.redLight, letterSpacing: "0.06em" }}>HOW TO FIX</span>
                  </div>
                  <p style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", lineHeight: 1.6 }}>{selectedIssue.fix}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", position: "sticky", top: 80, maxHeight: "calc(100vh - 100px)", display: "flex", flexDirection: "column" }}>
          {/* ── Two-tab header: QC Baseline / Creative & Retention ────────── */}
          <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}>
            {Object.entries(CATEGORIES).map(([catId, cat]) => {
              const count = issues.filter(i => i.category === catId).length;
              const isActive = activeTab === catId;
              return (
                <button
                  key={catId}
                  onClick={() => { setActiveTab(catId); setActiveFilter(catId === "qc_technical" ? "mistake" : "all"); }}
                  style={{
                    flex: 1,
                    padding: "14px 16px",
                    background: isActive ? cat.accentTint : "transparent",
                    borderBottom: isActive ? `2px solid ${cat.accent}` : "2px solid transparent",
                    color: isActive ? cat.accent : T.textMute,
                    cursor: "pointer",
                    transition: "all 0.15s",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  <span style={{ fontSize: 15 }}>{cat.icon}</span>
                  <span>{cat.label}</span>
                  <span style={{
                    fontSize: 10,
                    padding: "2px 7px",
                    borderRadius: 20,
                    background: isActive ? cat.accent + "33" : "rgba(255,255,255,0.06)",
                    color: isActive ? cat.accent : T.textDim,
                    fontFamily: "DM Mono, monospace",
                    fontWeight: 800,
                  }}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Tab-specific subhead + secondary filters */}
          <div style={{ padding: "12px 18px 12px", borderBottom: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 11, color: T.textDim, lineHeight: 1.5, marginBottom: 10 }}>
              {CATEGORIES[activeTab].desc}
            </p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(() => {
                // Tier counts within the active tab (pending = not done).
                const inTab = issues.filter(i => i.category === activeTab);
                const pend = inTab.filter(i => !doneIds.has(i.id));
                const mis = pend.filter(i => issueTier(i) === "mistake").length;
                const rev = pend.filter(i => issueTier(i) === "review").length;
                const sty = pend.filter(i => issueTier(i) === "style").length;
                const dn = inTab.filter(i => doneIds.has(i.id)).length;
                return (
                  <>
                    <FilterChip label="Actual Mistakes" count={mis} active={activeFilter === "mistake"} onClick={() => setActiveFilter("mistake")} color={T.redBright} />
                    <FilterChip label="Needs Review" count={rev} active={activeFilter === "review"} onClick={() => setActiveFilter("review")} color="#f59e0b" />
                    <FilterChip label="Optional Style" count={sty} active={activeFilter === "style"} onClick={() => setActiveFilter("style")} color="#94a3b8" />
                    <FilterChip label="Done" count={dn} active={activeFilter === "done"} onClick={() => setActiveFilter("done")} color="#10b981" />
                    <FilterChip label="All pending" count={pend.length} active={activeFilter === "all"} onClick={() => setActiveFilter("all")} color={CATEGORIES[activeTab].accent} />
                  </>
                );
              })()}
            </div>
          </div>

          {/* Findings list — filtered by tab + secondary filter */}
          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {onAddMissed && activeTab === "qc_technical" && (
              adding ? (
                <AddMissedForm defaultTs={currentTs} onAdd={onAddMissed} onClose={() => setAdding(false)} />
              ) : (
                <button
                  onClick={() => setAdding(true)}
                  title="The AI missed something? Add it here — and it'll watch for it next time"
                  style={{ alignSelf: "flex-start", padding: "7px 12px", borderRadius: 8, cursor: "pointer", border: `1px dashed ${T.border}`, background: "rgba(255,255,255,0.03)", color: T.textMute, fontSize: 11.5, fontWeight: 700 }}
                >
                  ＋ Add missed issue
                </button>
              )
            )}
            {filteredIssues.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: T.textDim }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>
                  {activeTab === "qc_technical" ? "🎉" : "💭"}
                </div>
                <p style={{ fontSize: 13 }}>
                  {activeTab === "qc_technical"
                    ? "No technical issues in this filter"
                    : "No creative suggestions yet — try a different brief or the Retention preset"}
                </p>
              </div>
            ) : (
              filteredIssues.map(issue => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  isSelected={selectedIssue?.id === issue.id}
                  onClick={seekToIssue}
                  isDone={doneIds.has(issue.id)}
                  onToggleDone={toggleDone}
                  onLearnCorrect={onLearnCorrect}
                  onFeedback={onFeedback}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 4b. WORKSPACE UI — login + dashboard
// ═════════════════════════════════════════════════════════════════════════════

function LoginStage({ onLogin }) {
  const [name, setName] = useState("");
  const submit = () => { const n = name.trim(); if (n) onLogin(n); };
  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 108px)" }}>
      <div style={{ width: "100%", maxWidth: 420, textAlign: "center" }}>
        <div style={{ width: 54, height: 54, borderRadius: 14, background: T.gradient, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 800, margin: "0 auto 20px", boxShadow: "0 6px 18px rgba(220,38,38,0.35)" }}>BB</div>
        <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>Welcome to BB QC Labs</h1>
        <p style={{ color: T.textDim, marginTop: 10, fontSize: 14, lineHeight: 1.5 }}>Enter your name to open your QC workspace. Your scans are saved here for 7 days.</p>
        <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            autoFocus value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Enter your name"
            style={{ padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,0.04)", border: `1px solid ${T.border}`, color: "white", fontSize: 15, outline: "none", textAlign: "center", boxSizing: "border-box" }}
          />
          <button onClick={submit} disabled={!name.trim()}
            style={{ padding: "14px 16px", borderRadius: 12, border: "none", cursor: name.trim() ? "pointer" : "not-allowed", background: name.trim() ? T.gradient : "rgba(255,255,255,0.06)", color: "white", fontSize: 15, fontWeight: 800, boxShadow: name.trim() ? "0 4px 14px rgba(220,38,38,0.35)" : "none" }}>
            Enter workspace →
          </button>
        </div>
        <p style={{ color: T.textMute, fontSize: 11, marginTop: 16, lineHeight: 1.5 }}>No password needed for now. History is stored privately in this browser.</p>
      </div>
    </div>
  );
}

function StatusPill({ errors, incomplete }) {
  const label = incomplete ? "Incomplete" : errors > 0 ? "Needs fixes" : "Clean";
  const color = incomplete ? "#f59e0b" : errors > 0 ? T.redBright : "#10b981";
  return <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.04em", padding: "3px 9px", borderRadius: 20, color, background: `${color}1a`, border: `1px solid ${color}55` }}>{label.toUpperCase()}</span>;
}

function ScanCard({ rec, onOpen }) {
  return (
    <div
      onClick={() => onOpen(rec.id)}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderHot; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; }}
      style={{ cursor: "pointer", background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", gap: 10, transition: "all 0.15s" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ScoreRing score={rec.score} size={46} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "white", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>🎬 {rec.fileName}</p>
          <p style={{ fontSize: 11, color: T.textDim, marginTop: 2, fontFamily: "DM Mono, monospace" }}>{fmtDate(rec.createdAt)} · {fmtClock(rec.createdAt)}</p>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: T.redLight, fontWeight: 700 }}>{rec.errors} err</span>
        <span style={{ fontSize: 11, color: "#fcd34d", fontWeight: 700 }}>{rec.warnings} warn</span>
        <StatusPill errors={rec.errors} />
        <span style={{ marginLeft: "auto", fontSize: 10, color: T.textDim }}>⏳ {daysLeft(rec.createdAt)}d left</span>
      </div>
    </div>
  );
}

function DashboardStage({ user, scans, loading, onNewScan, onOpen, onDelete }) {
  const recent = scans.slice(0, 6);
  return (
    <div className="fade-in" style={{ paddingTop: 8, paddingBottom: 48 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16, marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em" }}>Your QC Workspace</h1>
          <p style={{ color: T.textDim, fontSize: 14, marginTop: 4 }}>Signed in as <strong style={{ color: "white" }}>{user}</strong> · reports kept for 7 days</p>
        </div>
        <button onClick={onNewScan} style={{ padding: "13px 24px", borderRadius: 12, border: "none", cursor: "pointer", background: T.gradient, color: "white", fontSize: 14, fontWeight: 800, boxShadow: "0 4px 14px rgba(220,38,38,0.35)" }}>＋ New QC Scan</button>
      </div>

      {loading ? (
        <p style={{ color: T.textDim }}>Loading your workspace…</p>
      ) : scans.length === 0 ? (
        <div style={{ textAlign: "center", padding: "64px 20px", border: `1px dashed ${T.border}`, borderRadius: 16, background: "rgba(255,255,255,0.015)" }}>
          <div style={{ fontSize: 42, marginBottom: 12 }}>🎬</div>
          <p style={{ fontSize: 16, fontWeight: 700 }}>No scans yet</p>
          <p style={{ color: T.textDim, fontSize: 13, marginTop: 6 }}>Upload your first video to start your QC history.</p>
          <button onClick={onNewScan} style={{ marginTop: 18, padding: "11px 22px", borderRadius: 10, border: "none", cursor: "pointer", background: T.gradient, color: "white", fontWeight: 700, fontSize: 13 }}>Start a scan</button>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", color: T.textMute, marginBottom: 14 }}>Recent Activity</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
              {recent.map((r) => <ScanCard key={r.id} rec={r} onOpen={onOpen} />)}
            </div>
          </div>

          <div>
            <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", color: T.textMute, marginBottom: 14 }}>History</h2>
            <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 720 }}>
                  <thead>
                    <tr style={{ color: T.textDim, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      {["Video", "Date", "Time", "Score", "Errors", "Warnings", "Status", ""].map((h, i) => (
                        <th key={i} style={{ textAlign: i === 0 ? "left" : "center", padding: "12px 14px", borderBottom: `1px solid ${T.border}`, fontWeight: 700, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map((r) => (
                      <tr key={r.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td style={{ padding: "12px 14px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>🎬 {r.fileName}</td>
                        <td style={{ padding: "12px 14px", textAlign: "center", color: T.textMute, fontFamily: "DM Mono, monospace", whiteSpace: "nowrap" }}>{fmtDate(r.createdAt)}</td>
                        <td style={{ padding: "12px 14px", textAlign: "center", color: T.textMute, fontFamily: "DM Mono, monospace", whiteSpace: "nowrap" }}>{fmtClock(r.createdAt)}</td>
                        <td style={{ padding: "12px 14px", textAlign: "center", fontWeight: 800, fontFamily: "DM Mono, monospace", color: r.score >= 80 ? "#10b981" : r.score >= 60 ? "#f59e0b" : T.redBright }}>{r.score}</td>
                        <td style={{ padding: "12px 14px", textAlign: "center", color: T.redLight, fontWeight: 700 }}>{r.errors}</td>
                        <td style={{ padding: "12px 14px", textAlign: "center", color: "#fcd34d", fontWeight: 700 }}>{r.warnings}</td>
                        <td style={{ padding: "12px 14px", textAlign: "center" }}><StatusPill errors={r.errors} /></td>
                        <td style={{ padding: "12px 14px", textAlign: "center", whiteSpace: "nowrap" }}>
                          <button onClick={() => onOpen(r.id)} style={{ padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: T.gradient, color: "white", fontSize: 11, fontWeight: 700 }}>Open</button>
                          <button onClick={() => onDelete(r.id)} title="Delete" style={{ marginLeft: 6, padding: "6px 10px", borderRadius: 8, cursor: "pointer", background: "rgba(255,255,255,0.05)", color: T.textDim, fontSize: 11, border: `1px solid ${T.border}` }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── ADMIN PANEL (same-device) ─────────────────────────────────────────────────
// Gated to admin users. Reviews every scan stored in THIS browser across all
// users, and shows the QC-feedback log. Does NOT touch the normal user dashboard.
function AdminFilterChip({ label, count, active, onClick, color }) {
  return (
    <button onClick={onClick} style={{ padding: "7px 13px", borderRadius: 9, cursor: "pointer", fontSize: 12, fontWeight: 700,
      background: active ? `${color}22` : "rgba(255,255,255,0.04)", color: active ? color : T.textMute,
      border: `1px solid ${active ? color + "88" : T.border}` }}>
      {label}{count != null ? ` ${count}` : ""}
    </button>
  );
}

function AdminStage({ user, allScans, feedback, loading, onOpen, onBack, onRefresh, onClearFeedback }) {
  const [tab, setTab] = useState("overview");   // overview | videos | feedback
  const scans = allScans || [];
  const fb = feedback || [];

  const users = useMemo(() => {
    const mem = loadAllMemory();
    const map = new Map();
    for (const r of scans) {
      const key = normalizeUser(r.user);
      if (!map.has(key)) map.set(key, { key, name: r.user || "—", count: 0, lastAt: 0, mistakes: 0, errors: 0, scoreSum: 0 });
      const u = map.get(key);
      u.count++;
      u.lastAt = Math.max(u.lastAt, r.createdAt || 0);
      u.mistakes += scanTierCounts(r).mistake;
      u.errors += r.errors || 0;
      u.scoreSum += (typeof r.score === "number" ? r.score : 0);
    }
    return [...map.values()].map((u) => {
      const m = mem[u.key] || {};
      return { ...u, avgScore: u.count ? Math.round(u.scoreSum / u.count) : 0, learned: (m.allow?.length || 0) + (m.typos?.length || 0) };
    }).sort((a, b) => b.lastAt - a.lastAt);
  }, [scans]);

  const fbCounts = useMemo(() => { const c = {}; for (const f of fb) c[f.type] = (c[f.type] || 0) + 1; return c; }, [fb]);
  const fbSorted = useMemo(() => [...fb].sort((a, b) => (b.ts || 0) - (a.ts || 0)), [fb]);

  const th = { textAlign: "left", padding: "10px 12px", borderBottom: `1px solid ${T.border}`, fontWeight: 700, fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", color: T.textDim, whiteSpace: "nowrap" };
  const td = { padding: "10px 12px", borderBottom: `1px solid ${T.border}`, fontSize: 12.5 };

  return (
    <div className="fade-in" style={{ paddingTop: 8, paddingBottom: 48 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16, marginBottom: 22 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>🛡 Admin · QC Monitor</h1>
          <p style={{ color: T.textDim, fontSize: 13, marginTop: 4 }}>
            All scans on <strong style={{ color: "white" }}>this device</strong> · {scans.length} reports · {users.length} users · signed in as <strong style={{ color: "white" }}>{user}</strong>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onRefresh} style={{ padding: "10px 16px", borderRadius: 10, background: "rgba(255,255,255,0.05)", color: T.textMute, fontSize: 12, fontWeight: 700, cursor: "pointer", border: `1px solid ${T.border}` }}>↻ Refresh</button>
          <button onClick={onBack} style={{ padding: "10px 16px", borderRadius: 10, background: "rgba(255,255,255,0.05)", color: T.textMute, fontSize: 12, fontWeight: 700, cursor: "pointer", border: `1px solid ${T.border}` }}>← My dashboard</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <AdminFilterChip label="👥 Users" count={users.length} active={tab === "overview"} onClick={() => setTab("overview")} color="#ef4444" />
        <AdminFilterChip label="🎬 Videos" count={scans.length} active={tab === "videos"} onClick={() => setTab("videos")} color="#ef4444" />
        <AdminFilterChip label="🧠 Feedback" count={fb.length} active={tab === "feedback"} onClick={() => setTab("feedback")} color="#ef4444" />
      </div>

      {loading ? (
        <p style={{ color: T.textDim }}>Loading all reports on this device…</p>
      ) : scans.length === 0 && fb.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", border: `1px dashed ${T.border}`, borderRadius: 16 }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🗂️</div>
          <p style={{ fontWeight: 700 }}>No reports stored on this device yet</p>
          <p style={{ color: T.textDim, fontSize: 13, marginTop: 6 }}>Admin only sees scans run in this browser. Reports from other devices aren't visible without a backend.</p>
        </div>
      ) : (
        <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>

            {tab === "overview" && (
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
                <thead><tr>
                  {["User", "Videos", "Last activity", "Pending mistakes", "Total errors", "Avg score", "Learned"].map((h, i) => <th key={i} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.key}>
                      <td style={{ ...td, fontWeight: 700 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 24, height: 24, borderRadius: "50%", background: T.gradientPurple, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, textTransform: "uppercase" }}>{(u.name || "?").slice(0, 1)}</span>
                          {u.name}{isAdmin(u.name) && <span style={{ fontSize: 9, color: T.redLight }}>🛡</span>}
                        </span>
                      </td>
                      <td style={td}>{u.count}</td>
                      <td style={{ ...td, color: T.textMute, fontFamily: "DM Mono, monospace", whiteSpace: "nowrap" }}>{u.lastAt ? `${fmtDate(u.lastAt)} ${fmtClock(u.lastAt)}` : "—"}</td>
                      <td style={{ ...td, color: u.mistakes > 0 ? T.redLight : T.textMute, fontWeight: 700 }}>{u.mistakes}</td>
                      <td style={{ ...td, color: T.redLight, fontWeight: 700 }}>{u.errors}</td>
                      <td style={{ ...td, fontWeight: 800, fontFamily: "DM Mono, monospace", color: u.avgScore >= 80 ? "#10b981" : u.avgScore >= 60 ? "#f59e0b" : T.redBright }}>{u.avgScore}</td>
                      <td style={{ ...td, color: T.textMute }}>{u.learned}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === "videos" && (
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
                <thead><tr>
                  {["Video", "User", "Uploaded", "Score", "Mistake", "Review", "Style", ""].map((h, i) => <th key={i} style={{ ...th, textAlign: i >= 3 && i <= 6 ? "center" : "left" }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {scans.map((r) => {
                    const c = scanTierCounts(r);
                    return (
                      <tr key={r.id}>
                        <td style={{ ...td, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>🎬 {r.fileName}</td>
                        <td style={{ ...td, color: T.textMute, fontWeight: 700 }}>{r.user || "—"}</td>
                        <td style={{ ...td, color: T.textMute, fontFamily: "DM Mono, monospace", whiteSpace: "nowrap" }}>{fmtDate(r.createdAt)} {fmtClock(r.createdAt)}</td>
                        <td style={{ ...td, textAlign: "center", fontWeight: 800, fontFamily: "DM Mono, monospace", color: r.score >= 80 ? "#10b981" : r.score >= 60 ? "#f59e0b" : T.redBright }}>{r.score}</td>
                        <td style={{ ...td, textAlign: "center", color: T.redLight, fontWeight: 700 }}>{c.mistake}</td>
                        <td style={{ ...td, textAlign: "center", color: "#fcd34d", fontWeight: 700 }}>{c.review}</td>
                        <td style={{ ...td, textAlign: "center", color: T.textMute }}>{c.style}</td>
                        <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                          <button onClick={() => onOpen(r.id)} style={{ padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: T.gradient, color: "white", fontSize: 11, fontWeight: 700 }}>Open & review</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {tab === "feedback" && (
              <div style={{ padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                  {FEEDBACK_TYPES.map((t) => (
                    <span key={t.id} style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20, color: t.color, background: `${t.color}1a`, border: `1px solid ${t.color}55` }}>
                      {t.label}: {fbCounts[t.id] || 0}
                    </span>
                  ))}
                  {fb.length > 0 && (
                    <button onClick={onClearFeedback} style={{ marginLeft: "auto", padding: "6px 12px", borderRadius: 8, cursor: "pointer", background: "rgba(255,255,255,0.04)", color: T.textDim, fontSize: 11, fontWeight: 700, border: `1px solid ${T.border}` }}>Clear log</button>
                  )}
                </div>
                {fb.length === 0 ? (
                  <p style={{ color: T.textDim, fontSize: 13, padding: "20px 4px" }}>No feedback yet. Open any report and use the issue feedback buttons (Correct issue / False positive / Wrong severity / Wrong timestamp), or "✗ Not an error" and "＋ Add missed issue" — every correction is logged here as the model-improvement signal.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {fbSorted.map((f) => {
                      const t = FEEDBACK_LABEL[f.type] || { label: f.type, color: T.textMute };
                      return (
                        <div key={f.id} style={{ padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.02)", border: `1px solid ${T.border}`, borderLeft: `3px solid ${t.color}` }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                            <span style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4, color: t.color, background: `${t.color}1a`, border: `1px solid ${t.color}55` }}>{t.label.toUpperCase()}</span>
                            {f.ts != null && <span style={{ fontSize: 10, color: T.textDim, fontFamily: "DM Mono, monospace" }}>{fmtDate(f.ts)} {fmtClock(f.ts)}</span>}
                            <span style={{ fontSize: 11, color: T.textDim }}>by {f.admin || "admin"}{f.owner ? ` · video by ${f.owner}` : ""}</span>
                            {f.scanId && (
                              <button onClick={() => onOpen(f.scanId)} style={{ marginLeft: "auto", padding: "4px 10px", borderRadius: 7, cursor: "pointer", background: "rgba(255,255,255,0.05)", color: T.textMute, fontSize: 10.5, fontWeight: 700, border: `1px solid ${T.border}` }}>Open report</button>
                            )}
                          </div>
                          {f.caption && <p style={{ fontSize: 12, margin: "2px 0" }}><span style={{ color: T.textDim }}>Caption: </span>“{f.caption}”</p>}
                          {f.msg && <p style={{ fontSize: 12, margin: "2px 0", color: "rgba(255,255,255,0.85)" }}>{f.msg}</p>}
                          {f.note && <p style={{ fontSize: 11.5, margin: "2px 0", color: T.textMute }}><span style={{ color: T.textDim }}>Note: </span>{f.note}</p>}
                          {f.fileName && <p style={{ fontSize: 10.5, margin: "2px 0", color: T.textDim }}>🎬 {f.fileName}</p>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. MAIN APP
// ═════════════════════════════════════════════════════════════════════════════

export default function App() {
  const [user, setUser] = useState(loadUser);   // "" until logged in
  const [stage, setStage] = useState(() => (loadUser() ? "dashboard" : "login")); // login | dashboard | upload | confirm | analyzing | results
  const [scans, setScans] = useState([]);       // this user's saved reports (IndexedDB)
  const [dashLoading, setDashLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState(null);
  const [analysisPhase, setAnalysisPhase] = useState("");
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
  const [analysisError, setAnalysisError] = useState(null);
  const [analysisWarning, setAnalysisWarning] = useState(null);
  const [issues, setIssues] = useState([]);
  const [videoDuration, setVideoDuration] = useState(60);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [currentTs, setCurrentTs] = useState(null);
  const [activeFilter, setActiveFilter] = useState("mistake"); // mistake|review|style|done|all
  const [activeTab, setActiveTab] = useState("qc_technical"); // qc_technical | creative_retention
  const [apiStatus, setApiStatus] = useState({ probed: false, ok: false, detail: "" });
  const [referenceBrief, setReferenceBrief] = useState("");
  const [activePresetId, setActivePresetId] = useState(null);
  const [briefWasUsed, setBriefWasUsed] = useState(false);
  const [mode, setMode] = useState(DEFAULT_MODE);          // "urgent" | "deep"
  const [scopeMode, setScopeMode] = useState("captions");  // "captions" (default) | "all" — which on-screen text to QC
  const [scanDeadline, setScanDeadline] = useState(null);  // epoch ms for the live countdown
  const [scanCapMs, setScanCapMs] = useState(0);           // total cap (for the countdown bar)
  const [canResume, setCanResume] = useState(false);       // some segments still pending/failed
  const [doneIds, setDoneIds] = useState(() => new Set()); // issue ids the editor marked complete
  const [memory, setMemory] = useState(() => loadMemory(loadUser())); // learned corrections (allow + typos)
  const [allScans, setAllScans] = useState([]);            // ADMIN: every scan in this browser
  const [feedback, setFeedback] = useState(loadFeedback);  // ADMIN: QC-feedback log
  const admin = isAdmin(user);

  const fileRef = useRef(null);
  const manualIdRef = useRef(-1);                          // ids for editor-added findings (negative → no clash)
  const reviewCtxRef = useRef(null);                       // {scanId, owner, fileName} of the report being reviewed
  const wantPlayRef = useRef(false);                       // play from the pre-roll point after an issue click
  const videoRef = useRef(null);
  const abortRef = useRef(null);
  const seekFromExternal = useRef(false);
  const checkpointRef = useRef(null);                      // the resumable scan plan (in memory)
  const currentScanIdRef = useRef(null);                   // id of the report being written (so resume updates it)

  const videoUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  useEffect(() => {
    let cancelled = false;
    probeApi().then(r => { if (!cancelled) setApiStatus({ probed: true, ok: r.ok, detail: r.detail || "" }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || currentTs == null) return;
    if (Math.abs(v.currentTime - currentTs) > 0.3) {
      seekFromExternal.current = true;
      v.currentTime = currentTs;
    }
    // After an issue click we pre-rolled the playhead — now start playback so the
    // reviewer gets moving context into the error (user-gesture initiated → allowed).
    if (wantPlayRef.current) {
      wantPlayRef.current = false;
      v.play?.().catch(() => { /* autoplay blocked — playhead is still pre-rolled */ });
    }
  }, [currentTs]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ── Workspace: login + per-user scan history ────────────────────────────────
  const refreshScans = useCallback(async (who) => {
    const u = who ?? user;
    if (!u) { setScans([]); return; }
    setDashLoading(true);
    try { setScans(await listUserScans(u)); } finally { setDashLoading(false); }
  }, [user]);

  useEffect(() => { if (user) refreshScans(user); /* load history on mount */ }, []); // eslint-disable-line

  const handleLogin = useCallback((name) => {
    storeUser(name); setUser(name); setMemory(loadMemory(name)); setStage("dashboard"); refreshScans(name);
  }, [refreshScans]);

  const handleLogout = useCallback(() => {
    abortRef.current?.abort();
    clearStoredUser(); setUser(""); setScans([]); setMemory(EMPTY_MEMORY); setStage("login");
    setFile(null); setIssues([]); setSelectedIssue(null); setCurrentTs(null);
    setAnalysisError(null); setAnalysisWarning(null); setCanResume(false);
    checkpointRef.current = null; currentScanIdRef.current = null;
  }, []);

  const goDashboard = useCallback(() => {
    abortRef.current?.abort();
    setFile(null); setIssues([]); setSelectedIssue(null); setCurrentTs(null);
    setAnalysisError(null); setAnalysisWarning(null); setCanResume(false);
    setScanDeadline(null); checkpointRef.current = null; currentScanIdRef.current = null;
    setStage("dashboard");
    if (user) refreshScans(user);
  }, [user, refreshScans]);

  const startNewScan = useCallback(() => {
    setFile(null); setIssues([]); setSelectedIssue(null); setCurrentTs(null);
    setAnalysisError(null); setAnalysisWarning(null);
    setReferenceBrief(""); setActivePresetId(null); currentScanIdRef.current = null;
    setStage("upload");
  }, []);

  // Re-check an ALREADY-UPLOADED video (from a fresh scan or a reopened report)
  // without re-uploading. Routes back to the confirm screen with the same file so
  // the editor can pick the mode / scope / brief, then re-run. Produces a fresh
  // report. Needs the video blob — unavailable only if it was purged for quota.
  const recheckVideo = useCallback(() => {
    if (!file) return;
    currentScanIdRef.current = null;   // re-check writes a new report, doesn't overwrite
    setStage("confirm");
  }, [file]);

  // Save the finished report to IndexedDB (with the video blob, so it replays).
  const persistScan = useCallback(async (f, duration, issuesList, reuseId) => {
    if (!f || !user) return;
    const errors = issuesList.filter(i => i.severity === "error").length;
    const warnings = issuesList.filter(i => i.severity === "warning").length;
    const info = issuesList.filter(i => i.severity === "info").length;
    const score = Math.max(0, 100 - errors * 12 - warnings * 4);
    const id = reuseId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentScanIdRef.current = id;
    await saveScan({
      id, user, fileName: f.name || "video.mp4",
      sizeMb: +((f.size || 0) / 1048576).toFixed(1),
      durationSec: duration, createdAt: Date.now(),
      issues: issuesList, score, errors, warnings, info,
      briefUsed: briefWasUsed, blob: f,
    });
    refreshScans(user);
  }, [user, briefWasUsed, refreshScans]);

  // Reopen a saved report — restores findings + the video (from the stored blob).
  const openScan = useCallback(async (id) => {
    abortRef.current?.abort();
    let rec = null;
    try { rec = await idbGet(id); } catch { /* ignore */ }
    if (!rec) return;
    const f = rec.blob ? new File([rec.blob], rec.fileName, { type: rec.blob.type || "video/mp4" }) : null;
    setFile(f);
    // Apply the editor's allow-list retroactively so words learned after this
    // scan was saved no longer appear when the report is reopened.
    setIssues(sortByTs(filterAllowlisted(rec.issues || [], loadMemory(user).allow)));
    setVideoDuration(rec.durationSec || 60);
    setBriefWasUsed(!!rec.briefUsed);
    setDoneIds(new Set(rec.doneIds || []));
    setSelectedIssue(null); setCurrentTs(null);
    setActiveTab("qc_technical"); setActiveFilter("mistake");
    setAnalysisError(null); setAnalysisWarning(null); setCanResume(false);
    checkpointRef.current = null; currentScanIdRef.current = id;
    reviewCtxRef.current = { scanId: id, owner: rec.user || "", fileName: rec.fileName || "" };
    setStage("results");
  }, [user]);

  const deleteScan = useCallback(async (id) => {
    try { await idbDelete(id); } catch { /* ignore */ }
    if (user) refreshScans(user);
  }, [user, refreshScans]);

  // ── Admin: open the panel (loads every scan on this device + the feedback log)
  const openAdmin = useCallback(async () => {
    abortRef.current?.abort();
    setFile(null); setIssues([]); setSelectedIssue(null); setCurrentTs(null);
    checkpointRef.current = null; currentScanIdRef.current = null;
    setFeedback(loadFeedback());
    setStage("admin");
    setDashLoading(true);
    try { setAllScans(await listAllScans()); } finally { setDashLoading(false); }
  }, []);

  // ── Admin: record a QC-feedback entry (the model-improvement signal).
  const recordFeedback = useCallback((entry) => {
    const ctx = reviewCtxRef.current || {};
    setFeedback(logFeedback({
      admin: user,
      scanId: entry.scanId ?? currentScanIdRef.current ?? ctx.scanId ?? null,
      owner: entry.owner ?? ctx.owner ?? null,
      fileName: entry.fileName ?? ctx.fileName ?? file?.name ?? null,
      ...entry,
    }));
  }, [user, file]);

  const clearFeedbackLog = useCallback(() => { clearFeedback(); setFeedback([]); }, []);

  // Shared post-run handling: surface incomplete coverage + offer Resume.
  const finishRun = useCallback((result) => {
    if (result.failedFrames > 0 || result.pendingRemain) {
      setCanResume(true);
      setAnalysisWarning(
        `${result.failedSegments} segment(s) covering ${result.failedFrames} of ${result.totalFrames} frames didn't finish (timeout or rate limit). The segments that completed are saved — click Resume to retry ONLY the missing ones.`
      );
    } else {
      setAnalysisWarning(null);
    }
  }, []);

  const runAnalysis = useCallback(async (f) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const briefForThisRun = referenceBrief.trim();
    const captionScope = scopeMode;   // capture the text-scope toggle for this run
    const memoryForThisRun = loadMemory(user);   // freshest learned corrections for this user
    const cfg = MODES[mode];
    setFile(f);
    setStage("analyzing");
    setIssues([]);
    setSelectedIssue(null);
    setCurrentTs(null);
    setAnalysisError(null);
    setAnalysisWarning(null);
    setActiveFilter("mistake");
    setCanResume(false);
    setDoneIds(new Set());
    setBriefWasUsed(briefForThisRun.length > 0);

    try {
      setAnalysisPhase("extracting");
      setAnalysisProgress({ current: 0, total: 1 });
      // Extract frames AND transcribe the voiceover in parallel (both read the
      // file). Transcription is non-fatal — if there's no audio track or STT
      // fails, transcript is null and the audio cross-check is simply skipped.
      const [framesResult, transcript] = await Promise.all([
        extractFrames(f, cfg.coverageFps, (p) => setAnalysisProgress({ current: p.current, total: p.total })),
        transcribeAudio(f, controller.signal).catch((e) => { console.warn("[BB QC] transcription skipped:", e.message); return null; }),
      ]);
      const { frames, duration } = framesResult;
      setVideoDuration(duration);
      if (controller.signal.aborted) return;

      // DIVIDE: cut the timeline into chronological segments (1s overlap). The
      // `plan` IS the resumable checkpoint, kept in memory (no DB).
      const segCount = computeSegmentCount(duration, cfg.maxSegments);
      const segFrames = segmentByTime(frames, segCount, SEGMENT_OVERLAP_SEC);
      const plan = {
        modeId: mode,
        frames,
        duration,
        brief: briefForThisRun,
        transcript,
        captionScope,                                     // "captions" (default) | "all"
        memory: memoryForThisRun,                         // editor's learned corrections
        file: f,                                          // kept so we can save the report (incl. blob)
        segments: segFrames.map((fr, i) => ({ id: i, frames: fr, status: "pending", issues: [] })),
        creativeDone: false,
        creativeIssues: [],
      };
      currentScanIdRef.current = null;                    // fresh report id for this run
      checkpointRef.current = plan;

      // Start the live countdown against this mode's hard cap.
      const capMs = cfg.capFormula(duration);
      setScanCapMs(capMs);
      setScanDeadline(Date.now() + capMs);

      setAnalysisPhase("analyzing");
      setAnalysisProgress({ current: 0, total: 1 });

      // CONQUER: run all segments in parallel; merge progressively as each lands.
      const result = await analyzeSegments(plan, controller.signal, {
        onProgress: (p) => setAnalysisProgress(p),
        onSegmentDone: () => setIssues(sortByTs(reducePlan(plan).issues)),
      });

      if (controller.signal.aborted) return;

      setAnalysisPhase("finalizing");
      // Verify animation-suspect findings against neighbouring frames — drop the
      // ones that were just captions still animating in (e.g. "econo"→"economy").
      const finalIssues = await verifyAnimationSuspects(result.issues, plan, controller.signal, (p) => setAnalysisProgress(p));
      if (controller.signal.aborted) return;
      setIssues(sortByTs(finalIssues));
      finishRun(result);
      // Save (or update, on resume) this report to the user's workspace history.
      persistScan(plan.file, plan.duration, finalIssues, currentScanIdRef.current);
      setScanDeadline(null);
      await new Promise((r) => setTimeout(r, 400));
      setStage("results");
    } catch (e) {
      setScanDeadline(null);
      if (e.name === "AbortError") return;
      console.error("Analysis failed:", e);
      setAnalysisError(e.message || "Analysis failed");
    }
  }, [referenceBrief, mode, scopeMode, user, finishRun, persistScan]);

  // RESUME: re-run ONLY the segments still pending/failed/aborted. Completed
  // segments + their findings are preserved in checkpointRef.
  const resumeAnalysis = useCallback(async () => {
    const plan = checkpointRef.current;
    if (!plan) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const cfg = MODES[plan.modeId] || MODES[DEFAULT_MODE];

    setStage("analyzing");
    setAnalysisPhase("analyzing");
    setAnalysisError(null);
    setAnalysisWarning(null);
    setCanResume(false);
    const capMs = cfg.capFormula(plan.duration);
    setScanCapMs(capMs);
    setScanDeadline(Date.now() + capMs);

    try {
      const result = await analyzeSegments(plan, controller.signal, {
        onProgress: (p) => setAnalysisProgress(p),
        onSegmentDone: () => setIssues(sortByTs(reducePlan(plan).issues)),
      });
      if (controller.signal.aborted) return;
      setAnalysisPhase("finalizing");
      // Verify animation-suspect findings against neighbouring frames — drop the
      // ones that were just captions still animating in (e.g. "econo"→"economy").
      const finalIssues = await verifyAnimationSuspects(result.issues, plan, controller.signal, (p) => setAnalysisProgress(p));
      if (controller.signal.aborted) return;
      setIssues(sortByTs(finalIssues));
      finishRun(result);
      // Save (or update, on resume) this report to the user's workspace history.
      persistScan(plan.file, plan.duration, finalIssues, currentScanIdRef.current);
      setScanDeadline(null);
      await new Promise((r) => setTimeout(r, 400));
      setStage("results");
    } catch (e) {
      setScanDeadline(null);
      if (e.name === "AbortError") return;
      setAnalysisError(e.message || "Resume failed");
    }
  }, [finishRun, persistScan]);

  const handleFile = useCallback((f) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) {
      alert("Please upload a video file (MP4, MOV, WebM, etc.)");
      return;
    }
    // Don't auto-scan. Stage the file and move to the confirm/review step where
    // the user can set the magic prompt and explicitly start the scan.
    setFile(f);
    setIssues([]);
    setSelectedIssue(null);
    setCurrentTs(null);
    setAnalysisError(null);
    setStage("confirm");
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  }, [handleFile]);

  const resetUpload = () => {
    abortRef.current?.abort();
    setStage("upload"); setFile(null); setIssues([]);
    setSelectedIssue(null); setCurrentTs(null);
    setAnalysisError(null); setAnalysisPhase("");
    setCanResume(false); setScanDeadline(null); checkpointRef.current = null;
  };

  const seekToIssue = (issue) => {
    setSelectedIssue(issue);
    // Pre-roll: land ~0.6s BEFORE the flagged frame and start playing, so the
    // reviewer sees the caption animate in and hears the lead-in audio context
    // rather than jumping onto the exact (possibly mid-animation) error frame.
    if (issue.ts != null) {
      wantPlayRef.current = true;
      setCurrentTs(Math.max(0, issue.ts - ISSUE_PREROLL_SEC));
    }
    // If the user clicked a timeline marker for a finding in the OTHER tab,
    // switch to that tab so the highlighted issue card is actually visible.
    if (issue.category && issue.category !== activeTab) {
      setActiveTab(issue.category);
      setActiveFilter("all");
    }
  };

  const navigateIssue = (dir) => {
    if (!selectedIssue) return;
    const visible = filteredIssues;
    const idx = visible.findIndex(i => i.id === selectedIssue.id);
    if (idx < 0) return;
    const next = dir === "next" ? visible[idx + 1] : visible[idx - 1];
    if (next) seekToIssue(next);
  };

  // Counts + score by IMPORTANCE (not raw severity), so optional/unnecessary
  // items don't tank the score. Done items don't count against it.
  // Three-tier counts (pending = not done). Only Actual Mistakes affect the score.
  const mistakeCount = issues.filter(i => !doneIds.has(i.id) && issueTier(i) === "mistake").length;
  const reviewCount  = issues.filter(i => !doneIds.has(i.id) && issueTier(i) === "review").length;
  const styleCount   = issues.filter(i => !doneIds.has(i.id) && issueTier(i) === "style").length;
  const doneCount = issues.filter(i => doneIds.has(i.id)).length;
  const overallScore = Math.max(0, Math.min(100, 100 - mistakeCount * 12));

  const filteredIssues = useMemo(() => {
    let list = issues.filter(i => i.category === activeTab);
    if (activeFilter === "done") return list.filter(i => doneIds.has(i.id));
    list = list.filter(i => !doneIds.has(i.id));              // hide completed from the working views
    if (activeFilter === "all") return list;
    return list.filter(i => issueTier(i) === activeFilter);   // mistake | review | style
  }, [issues, activeTab, activeFilter, doneIds]);

  // Mark an issue complete (or reopen it) and persist done-state to the report.
  const toggleDone = useCallback((id) => {
    setDoneIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      const scanId = currentScanIdRef.current;
      if (scanId) (async () => {
        try {
          const rec = await idbGet(scanId);
          if (rec) { await saveScan({ ...rec, doneIds: [...next] }); if (user) refreshScans(user); }
        } catch { /* ignore */ }
      })();
      return next;
    });
  }, [user, refreshScans]);

  const handleExport = useCallback(() => {
    exportReportPDF({ fileName: file?.name || "video.mp4", issues, doneIds, durationSec: videoDuration, score: overallScore });
  }, [file, issues, doneIds, videoDuration, overallScore]);

  // ── Learn / correct-on-the-spot (spell-checker-style custom dictionary) ───────
  // "This is correct" → add the word to the allow-list (never flagged again) and
  // drop the finding from the current report.
  const learnCorrect = useCallback((issue, term) => {
    const t = (term || "").trim();
    if (!t) return;
    setMemory((prev) => {
      if (prev.allow.some((a) => normTerm(a.term) === normTerm(t))) return prev;   // dedupe
      const next = { ...prev, allow: [...prev.allow, { term: t, ts: Date.now() }] };
      saveMemory(user, next);
      return next;
    });
    setIssues((prev) => prev.filter((i) => i.id !== issue.id));
    setSelectedIssue((s) => (s?.id === issue.id ? null : s));
    if (admin) recordFeedback({ type: "false_positive", caption: issue.captionText, msg: issue.msg, note: `Learned correct: "${t}"` });
  }, [user, admin, recordFeedback]);

  // "You missed this" → add a manual finding to the report now, AND remember the
  // wrong→right pair so future scans actively watch for it.
  const addMissed = useCallback(({ ts, wrong, right, note }) => {
    const w = (wrong || "").trim(), r = (right || "").trim(), n = (note || "").trim();
    if (!w && !r && !n) return;
    const id = manualIdRef.current--;
    const finding = {
      id, category: "qc_technical", checkId: "grammar", kind: "spelling",
      confidence: "high", priority: "required", severity: "error", textSource: "caption",
      ts: (typeof ts === "number" && isFinite(ts)) ? ts : null,
      captionText: w || null, audioText: null,
      msg: r ? `Editor-flagged: “${w}” should be “${r}”` : (w ? `Editor-flagged: “${w}”` : "Editor-flagged issue"),
      why: n || "Reported by the editor — missed in the automated pass.",
      fix: r ? `Replace “${w}” with “${r}”` : (n || "See note."),
      manual: true,
    };
    setIssues((prev) => {
      const nextList = sortByTs([...prev, finding]);
      const scanId = currentScanIdRef.current;
      if (scanId) (async () => {
        try { const rec = await idbGet(scanId); if (rec) { await saveScan({ ...rec, issues: nextList }); if (user) refreshScans(user); } } catch { /* ignore */ }
      })();
      return nextList;
    });
    if (w && r) setMemory((prev) => {
      if (prev.typos.some((t) => normTerm(t.wrong) === normTerm(w))) return prev;
      const next = { ...prev, typos: [...prev.typos, { wrong: w, right: r, ts: Date.now() }] };
      saveMemory(user, next);
      return next;
    });
    if (admin) recordFeedback({ type: "missed", caption: w || null, msg: finding.msg, note: n || null });
  }, [user, admin, refreshScans, recordFeedback]);

  // Remove a learned entry ("allow" or "typos") by index.
  const unlearn = useCallback((kind, idx) => {
    setMemory((prev) => {
      const next = { ...prev, [kind]: prev[kind].filter((_, i) => i !== idx) };
      saveMemory(user, next);
      return next;
    });
  }, [user]);

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: "white" }}>
      <Nav apiStatus={apiStatus} user={user} onLogout={handleLogout} isAdminUser={admin} onAdmin={openAdmin} />
      <div style={{ maxWidth: 1480, margin: "0 auto", padding: "24px" }}>
        {stage === "login" && <LoginStage onLogin={handleLogin} />}
        {stage === "dashboard" && (
          <DashboardStage
            user={user}
            scans={scans}
            loading={dashLoading}
            onNewScan={startNewScan}
            onOpen={openScan}
            onDelete={deleteScan}
          />
        )}
        {stage === "results" && analysisWarning && (
          <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.4)", display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ fontSize: 16 }}>⚠️</span>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: "#fbbf24", marginBottom: 2 }}>Incomplete scan</p>
              <p style={{ fontSize: 12, color: T.textMute, lineHeight: 1.5, margin: 0 }}>{analysisWarning}</p>
            </div>
            {canResume && (
              <button
                onClick={resumeAnalysis}
                style={{ flexShrink: 0, alignSelf: "center", padding: "8px 18px", borderRadius: 9, background: "#f59e0b", color: "#1a1205", fontSize: 12, fontWeight: 800, cursor: "pointer", border: "none" }}
              >
                ↻ Resume missing segments
              </button>
            )}
          </div>
        )}
        {stage === "upload" && (
          <UploadStage
            dragOver={dragOver}
            setDragOver={setDragOver}
            handleDrop={handleDrop}
            handleFile={handleFile}
            fileRef={fileRef}
            apiStatus={apiStatus}
            onDashboard={goDashboard}
          />
        )}
        {stage === "confirm" && (
          <ConfirmStage
            file={file}
            videoUrl={videoUrl}
            onStart={() => runAnalysis(file)}
            onBack={resetUpload}
            referenceBrief={referenceBrief}
            setReferenceBrief={setReferenceBrief}
            activePresetId={activePresetId}
            setActivePresetId={setActivePresetId}
            mode={mode}
            setMode={setMode}
            scopeMode={scopeMode}
            setScopeMode={setScopeMode}
          />
        )}
        {stage === "analyzing" && (
          <AnalyzingStage
            file={file}
            phase={analysisPhase}
            progress={analysisProgress}
            error={analysisError}
            onCancel={resetUpload}
            deadline={scanDeadline}
            capMs={scanCapMs}
          />
        )}
        {stage === "results" && (
          <ResultsStage
            file={file}
            videoUrl={videoUrl}
            videoRef={videoRef}
            seekFromExternal={seekFromExternal}
            videoDuration={videoDuration}
            setVideoDuration={setVideoDuration}
            issues={issues}
            filteredIssues={filteredIssues}
            activeFilter={activeFilter}
            setActiveFilter={setActiveFilter}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            currentTs={currentTs}
            setCurrentTs={setCurrentTs}
            selectedIssue={selectedIssue}
            seekToIssue={seekToIssue}
            navigateIssue={navigateIssue}
            mistakeCount={mistakeCount}
            reviewCount={reviewCount}
            styleCount={styleCount}
            doneCount={doneCount}
            overallScore={overallScore}
            onNewUpload={goDashboard}
            onExport={handleExport}
            onRecheck={recheckVideo}
            doneIds={doneIds}
            toggleDone={toggleDone}
            briefWasUsed={briefWasUsed}
            memory={memory}
            onLearnCorrect={learnCorrect}
            onAddMissed={addMissed}
            onUnlearn={unlearn}
            onFeedback={admin ? recordFeedback : null}
          />
        )}
        {stage === "admin" && admin && (
          <AdminStage
            user={user}
            allScans={allScans}
            feedback={feedback}
            loading={dashLoading}
            onOpen={openScan}
            onBack={goDashboard}
            onRefresh={openAdmin}
            onClearFeedback={clearFeedbackLog}
          />
        )}
      </div>
    </div>
  );
}
