// ═════════════════════════════════════════════════════════════════════════════
// TOOL REGISTRY — every tool shown on the home screen after login.
//
// To add a new tool:
//   1. Build its page as a component in src/tools/ (see Mp3Converter.jsx).
//   2. Add one entry below. `stage` is the screen App.jsx opens for it.
//   3. In App.jsx, render the component for that stage (search "TOOL PAGES").
//
// Fields:
//   id        unique key
//   stage     App.jsx stage to open ("dashboard" = the existing QC workspace)
//   name      card title
//   icon      emoji shown on the card
//   desc      one-line description
//   tag       optional small badge ("New", "Beta")
//   status    "live" (clickable) | "soon" (shown greyed out, not clickable)
//   adminOnly true → only admins see it
// ═════════════════════════════════════════════════════════════════════════════

export const TOOLS = [
  {
    id: "qc",
    stage: "dashboard",
    name: "QC Check",
    icon: "🎬",
    desc: "AI quality control for videos — spelling, safe zones, audio, music risk.",
    status: "live",
  },
  {
    id: "yt",
    stage: "yt",
    name: "YT Downloader",
    icon: "📥",
    desc: "Paste a YouTube link and download the video or its audio.",
    tag: "Beta",
    status: "live",
  },
  {
    id: "mp3",
    stage: "mp3",
    name: "MP3 Converter",
    icon: "🎵",
    desc: "Turn any video or audio file into an MP3 — right in your browser.",
    tag: "New",
    status: "live",
  },
];

export function visibleTools(isAdmin) {
  return TOOLS.filter((t) => !t.adminOnly || isAdmin);
}

export const TOOL_STAGES = new Set(TOOLS.map((t) => t.stage));
