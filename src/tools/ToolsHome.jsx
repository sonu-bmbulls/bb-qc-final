import { TT } from "./theme.jsx";
import { visibleTools } from "./registry.js";

// Home screen every user lands on after login: a grid of available tools.
export default function ToolsHome({ user, isAdmin, onOpen }) {
  const tools = visibleTools(isAdmin);
  return (
    <div className="fade-in" style={{ paddingTop: 8, paddingBottom: 48 }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>
          Hi {user}, what are we working on?
        </h1>
        <p style={{ color: TT.textDim, fontSize: 14, marginTop: 6 }}>
          Pick a tool to get started. More tools are on the way.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
        {tools.map((t) => {
          const live = t.status === "live";
          return (
            <button
              key={t.id}
              type="button"
              disabled={!live}
              onClick={() => live && onOpen(t)}
              onMouseEnter={(e) => { if (live) { e.currentTarget.style.borderColor = TT.borderHot; e.currentTarget.style.transform = "translateY(-2px)"; } }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = TT.border; e.currentTarget.style.transform = "none"; }}
              style={{
                textAlign: "left",
                cursor: live ? "pointer" : "not-allowed",
                opacity: live ? 1 : 0.45,
                background: TT.panel,
                border: `1px solid ${TT.border}`,
                borderRadius: 16,
                padding: 20,
                display: "flex",
                flexDirection: "column",
                gap: 14,
                minHeight: 170,
                transition: "all 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ width: 50, height: 50, borderRadius: 14, background: TT.redTint, border: `1px solid ${TT.borderHot}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26 }}>
                  {t.icon}
                </div>
                {(t.tag || !live) && (
                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.05em", padding: "3px 9px", borderRadius: 20, color: TT.redLight, background: TT.redTint, border: `1px solid ${TT.borderHot}` }}>
                    {(live ? t.tag : "Coming soon").toUpperCase()}
                  </span>
                )}
              </div>
              <div>
                <p style={{ fontSize: 17, fontWeight: 800, color: "white" }}>{t.name}</p>
                <p style={{ fontSize: 13, color: TT.textDim, marginTop: 6, lineHeight: 1.5 }}>{t.desc}</p>
              </div>
              {live && <span style={{ marginTop: "auto", fontSize: 12, fontWeight: 700, color: TT.redBright }}>Open →</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
