// Shared look for the tool pages — mirrors the T palette in App.jsx so every
// tool feels like part of the same BB QC Labs app.
export const TT = {
  bg: "#0a0608",
  panel: "rgba(255,255,255,0.025)",
  border: "rgba(255,255,255,0.07)",
  borderHot: "rgba(220,38,38,0.35)",
  red: "#dc2626",
  redBright: "#ef4444",
  redLight: "#fca5a5",
  redTint: "rgba(220,38,38,0.08)",
  textDim: "rgba(255,255,255,0.4)",
  textMute: "rgba(255,255,255,0.6)",
  green: "#10b981",
  amber: "#f59e0b",
  gradient: "linear-gradient(135deg,#dc2626,#7f1d1d)",
};

export const btnPrimary = (enabled = true) => ({
  padding: "12px 22px",
  borderRadius: 12,
  border: "none",
  cursor: enabled ? "pointer" : "not-allowed",
  background: enabled ? TT.gradient : "rgba(255,255,255,0.06)",
  color: "white",
  fontSize: 14,
  fontWeight: 800,
  boxShadow: enabled ? "0 4px 14px rgba(220,38,38,0.35)" : "none",
});

export const btnGhost = {
  padding: "8px 14px",
  borderRadius: 10,
  border: `1px solid ${TT.border}`,
  background: "rgba(255,255,255,0.04)",
  color: TT.textMute,
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

export const inputStyle = {
  width: "100%",
  padding: "13px 16px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${TT.border}`,
  color: "white",
  fontSize: 14,
  outline: "none",
};

export const panel = {
  background: TT.panel,
  border: `1px solid ${TT.border}`,
  borderRadius: 16,
  padding: 20,
};

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function ToolHeader({ icon, title, subtitle, onBack }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <button onClick={onBack} style={{ ...btnGhost, marginBottom: 16 }}>← All tools</button>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 48, height: 48, borderRadius: 13, background: TT.redTint, border: `1px solid ${TT.borderHot}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>{icon}</div>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>{title}</h1>
          <p style={{ color: TT.textDim, fontSize: 14, marginTop: 2 }}>{subtitle}</p>
        </div>
      </div>
    </div>
  );
}
