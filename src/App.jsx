import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Fantasy Trade Board — GitHub-only persistence (SIN Supabase)
 * - Usuarios y data se guardan como JSON en ESTE repo, usando GitHub Contents API.
 * - Inseguro por diseño (token en frontend). OK para liga chica de amigos.
 *
 * Requiere en el repo (en la raíz /data):
 *   - data/users.json
 *   - data/league_teams.json
 *   - data/interests.json
 *
 * Recomendado: definir envs en .env (Vite):
 *   VITE_GH_OWNER, VITE_GH_REPO, VITE_GH_BRANCH, VITE_GH_TOKEN
 */

const GH_OWNER = import.meta.env.VITE_GH_OWNER;
const GH_REPO = import.meta.env.VITE_GH_REPO;
const GH_BRANCH = import.meta.env.VITE_GH_BRANCH;
const GH_TOKEN = import.meta.env.VITE_GH_TOKEN;
const GH_API = "https://api.github.com";

const PATH_USERS = "data/users.json";
const PATH_TEAMS = "data/league_teams.json";
const PATH_INTERESTS = "data/interests.json";

/** ========= helpers ========= */
function uid(prefix = "u") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
function nowIso() {
  return new Date().toISOString();
}
function safeJsonParse(txt, fallback) {
  try {
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}
function b64encodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decodeUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}
async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function ghHeaders() {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GH_TOKEN) h.Authorization = `Bearer ${GH_TOKEN}`;
  return h;
}

// Cola global de escrituras para evitar 409 por SHA desactualizado (race conditions)
let __ghWriteChain = Promise.resolve();
function ghEnqueueWrite(fn) {
  const run = __ghWriteChain.then(() => fn());
  // Importante: que la cola NO se "rompa" si un write falla
  __ghWriteChain = run.catch(() => {});
  return run;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function ghGetFile(path) {
  const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return { exists: false, sha: null, content: "" };
  if (!res.ok) throw new Error(await res.text());
  const j = await res.json();

  // OJO: GitHub devuelve base64 con \n cada X chars. NO uses regex multiline.
  const raw = j?.content ? b64decodeUtf8(String(j.content).split("\n").join("")) : "";
  return { exists: true, sha: j.sha, content: raw };
}
async function ghPutFile(path, content, sha = null, message = null) {
  const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;
  const body = {
    message: message || `update ${path}`,
    content: b64encodeUtf8(content),
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    const t = await res.text();
    const err = new Error(t);
    err.code = 409;
    throw err;
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function ghGetJson(path, fallback) {
  const f = await ghGetFile(path);
  if (!f.exists) return { data: fallback, sha: null };
  return { data: safeJsonParse(f.content, fallback), sha: f.sha };
}
async function ghPutJson(path, data, sha, message) {
  const txt = JSON.stringify(data, null, 2);
  return ghPutFile(path, `${txt}\n`, sha, message);
}
async function ghPutJsonWithRetry(path, mutator, label) {
  // Serializa todas las escrituras para que 2 acciones seguidas (Agregar / Editar / etc.)
  // no choquen en GitHub Contents API (409 sha mismatch).
  return ghEnqueueWrite(async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await ghGetJson(path, []);
      const arr = Array.isArray(data) ? data : [];
      const next = mutator(arr);
      try {
        await ghPutJson(path, next, sha, label);
        return next;
      } catch (e) {
        lastErr = e;
        if (e?.code === 409) {
          // backoff leve y reintento con SHA nuevo
          await sleep(200 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error("No se pudo guardar (reintentos agotados).");
  });
}

/** ========= UI ========= */
const COLORS = {
  page: "var(--c-page)",
  surface: "var(--c-surface)",
  sky: "var(--c-sky)",
  blue: "var(--c-blue)",
  navy: "var(--c-navy)",
  gray: "var(--c-gray)",
  border: "var(--c-border)",
  soft: "var(--c-soft)",
  danger: "var(--c-danger)",
  success: "var(--c-success)",
};

const THEME_VARS = {
  dark: {
    "--c-page": "#0B1220",
    "--c-surface": "#0F172A",
    "--c-sky": "#111B2F",
    "--c-blue": "#3B82F6",
    "--c-navy": "#E6EEFF",
    "--c-gray": "#A8B3C7",
    "--c-border": "#22304A",
    "--c-soft": "#0B1324",
    "--c-danger": "#EF4444",
    "--c-success": "#22C55E",
    "--c-shadow": "0 10px 30px rgba(0,0,0,0.18)",
  },
  light: {
    "--c-page": "#FFFFFF",
    "--c-surface": "#FFFFFF",
    "--c-sky": "#EAF6FF",
    "--c-blue": "#2F80ED",
    "--c-navy": "#0B2D4D",
    "--c-gray": "#6B7280",
    "--c-border": "#E5E7EB",
    "--c-soft": "#F8FAFC",
    "--c-danger": "#EF4444",
    "--c-success": "#22C55E",
    "--c-shadow": "0 10px 24px rgba(15,23,42,0.10)",
  },
};

function GlobalStyles() {
  return (
    <style>{`
      *, *::before, *::after { box-sizing: border-box; }
      html, body, #root { height: 100%; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial,
          "Apple Color Emoji", "Segoe UI Emoji";
      }
      button, input, select { font: inherit; }
      input::placeholder { color: rgba(128, 140, 160, 0.9); }
      html[data-theme="dark"] { color-scheme: dark; }
      html[data-theme="light"] { color-scheme: light; }

      .ftbPage{
        min-height: 100vh;
        padding: clamp(14px, 2.2vw, 22px);
        color: var(--c-navy);
        background:
          radial-gradient(900px circle at 12% -10%, rgba(59,130,246,0.25), transparent 55%),
          radial-gradient(700px circle at 90% 10%, rgba(34,197,94,0.12), transparent 50%),
          var(--c-page);
      }
      html[data-theme="light"] .ftbPage{
        background:
          radial-gradient(900px circle at 12% -10%, rgba(47,128,237,0.18), transparent 55%),
          radial-gradient(700px circle at 90% 10%, rgba(34,197,94,0.10), transparent 50%),
          var(--c-page);
      }

      .ftbContainer{ max-width: 1100px; margin: 0 auto; }
      .ftbTitle{ margin: 14px 0 18px; font-size: clamp(28px, 5vw, 46px); letter-spacing:-1px; line-height:1.05; }

      .authCard{ max-width: 560px; margin: 0 auto; }

      .grid3{ display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
      .grid2{ display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }

      .topbar{
        position: sticky;
        top: 0;
        z-index: 10;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        padding: 8px 0;
      }
      .topbarInner{
        max-width: 1100px;
        margin: 0 auto;
        display:flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }

      .assetRow{ display:grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
      .assetActions{ display:flex; flex-direction: column; gap: 8px; justify-content: space-between; }
      .breakAnywhere{ min-width: 0; overflow-wrap: anywhere; }

      @media (max-width: 860px){
        .grid3{ grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 720px){
        .topbarInner{ flex-wrap: wrap; }
        .grid3{ grid-template-columns: 1fr; }
        .grid2{ grid-template-columns: 1fr; }
        .assetRow{ grid-template-columns: 1fr; }
        .assetActions{ flex-direction: row; justify-content: flex-end; }
        .assetActions > button{ flex: 1; }
      }
    `}</style>
  );
}

function Card({ children, style, className }) {
  return (
    <div
      className={className}
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 18,
        padding: "clamp(14px, 2vw, 18px)",
        boxShadow: "var(--c-shadow)",
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
function Input({ value, onChange, placeholder, type = "text", style, className }) {
  return (
    <input
      className={className}
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        display: "block",
        minWidth: 0,
        boxSizing: "border-box",
        padding: "14px 14px",
        borderRadius: 14,
        border: `1px solid ${COLORS.border}`,
        background: COLORS.sky,
        color: COLORS.navy,
        outline: "none",
        fontSize: 16,
        ...style,
      }}
    />
  );
}
function Button({ children, onClick, disabled, variant = "primary", style, title, className }) {
  const bg =
    variant === "primary"
      ? COLORS.blue
      : variant === "danger"
        ? COLORS.danger
        : "transparent";
  const border = variant === "ghost" ? `1px solid ${COLORS.border}` : "1px solid transparent";
  const color = variant === "ghost" ? COLORS.navy : "#fff";
  return (
    <button
      className={className}
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "12px 14px",
        minWidth: 0,
        boxSizing: "border-box",
        lineHeight: 1.2,
        borderRadius: 14,
        border,
        background: bg,
        color,
        fontWeight: 800,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
function Pill({ children, tone = "neutral" }) {
  const bg =
    tone === "good"
      ? "rgba(34,197,94,0.15)"
      : tone === "bad"
        ? "rgba(239,68,68,0.15)"
        : "rgba(59,130,246,0.12)";
  const bd =
    tone === "good"
      ? "rgba(34,197,94,0.35)"
      : tone === "bad"
        ? "rgba(239,68,68,0.35)"
        : "rgba(59,130,246,0.25)";
  const col = tone === "good" ? COLORS.success : tone === "bad" ? COLORS.danger : COLORS.blue;
  return (
    <span
      style={{
        padding: "6px 10px",
        borderRadius: 999,
        background: bg,
        border: `1px solid ${bd}`,
        color: col,
        fontWeight: 800,
        fontSize: 12,
      }}
    >
      {children}
    </span>
  );
}
function useDebouncedCallback(cb, ms) {
  const t = useRef(null);
  return (...args) => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => cb(...args), ms);
  };
}

/** ========= APP ========= */
export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem("ftb_theme") || "dark");
  const [bootError, setBootError] = useState("");

  // auth
  const [authMode, setAuthMode] = useState("login"); // login | signup
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");

  const [me, setMe] = useState(() => {
    const s = localStorage.getItem("ftb_session");
    return s ? safeJsonParse(s, null) : null;
  });

  // league data
  const [teams, setTeams] = useState([]);
  const [interests, setInterests] = useState([]);

  // my profile
  const [myDisplayName, setMyDisplayName] = useState("");
  const [myTeamName, setMyTeamName] = useState("");
  const [myStatus, setMyStatus] = useState("Contendiendo");
  const [saveInfo, setSaveInfo] = useState("");

  const applyTheme = (t) => {
    setTheme(t);
    localStorage.setItem("ftb_theme", t);
    document.documentElement.dataset.theme = t;
    const vars = THEME_VARS[t] || THEME_VARS.dark;
    Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  };

  useEffect(() => {
    applyTheme(theme);

    if (!GH_OWNER || !GH_REPO) {
      setBootError("Faltan VITE_GH_OWNER / VITE_GH_REPO (o hardcode en App.jsx).");
    }
    if (!GH_TOKEN) {
      setBootError("Falta VITE_GH_TOKEN (o hardcode en App.jsx). Sin token no podés guardar/leer en GitHub.");
    }
  }, []);

  useEffect(() => {
    if (me) localStorage.setItem("ftb_session", JSON.stringify(me));
    else localStorage.removeItem("ftb_session");
  }, [me]);

  async function refreshData() {
    const [{ data: t }, { data: i }] = await Promise.all([
      ghGetJson(PATH_TEAMS, []),
      ghGetJson(PATH_INTERESTS, []),
    ]);
    setTeams(Array.isArray(t) ? t : []);
    setInterests(Array.isArray(i) ? i : []);
  }

  useEffect(() => {
    if (!me) return;
    (async () => {
      try {
        await refreshData();
      } catch (e) {
        setBootError(String(e?.message || e));
      }
    })();
  }, [me?.id]);

  useEffect(() => {
    if (!me) return;
    const row = teams.find((x) => x.user_id === me.id);
    if (row) {
      setMyDisplayName(row.display_name || "");
      setMyTeamName(row.team_name || "");
      setMyStatus(row.team_status || "Contendiendo");
    } else {
      setMyDisplayName(me.email?.split("@")?.[0] || "");
      setMyTeamName("");
      setMyStatus("Contendiendo");
    }
  }, [me?.id, teams]);

  const byUser = useMemo(() => {
    const m = new Map();
    for (const t of teams) m.set(t.user_id, t);
    return m;
  }, [teams]);

  const myOutgoing = useMemo(() => (me ? interests.filter((x) => x.from_user_id === me.id) : []), [interests, me?.id]);
  const myIncoming = useMemo(() => (me ? interests.filter((x) => x.to_user_id === me.id) : []), [interests, me?.id]);

  async function signup() {
    setAuthError("");
    if (!email || !pass) return setAuthError("Completá email y contraseña.");
    if (pass.length < 6) return setAuthError("La contraseña debe tener al menos 6 caracteres.");
    if (pass !== pass2) return setAuthError("Las contraseñas no coinciden.");
    setAuthBusy(true);

    try {
      // Guardamos USERS con cola (evita 409 por SHA viejo si hay dos writes seguidos)
      await ghEnqueueWrite(async () => {
        const { data: users, sha } = await ghGetJson(PATH_USERS, []);
        const list = Array.isArray(users) ? users : [];
        const exists = list.some((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
        if (exists) throw new Error("Ese email ya existe.");
        const next = [...list, { id, email, pass_sha256: hash, created_at: nowIso() }];
        await ghPutJson(PATH_USERS, next, sha, "signup user");
      });

      // crear fila del team si no existe
      await ghPutJsonWithRetry(
        PATH_TEAMS,
        (cur) => {
          if (cur.some((x) => x.user_id === id)) return cur;
          return [
            ...cur,
            {
              user_id: id,
              display_name: email.split("@")[0],
              team_name: "",
              team_status: "Contendiendo",
              roster: [],
              status_overrides: {},
              asset_values: {},
              updated_at: nowIso(),
            },
          ];
        },
        "create team row"
      );

      setMe({ id, email });
      setPass("");
      setPass2("");
    } catch (e) {
      setAuthError(String(e?.message || e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function login() {
    setAuthError("");
    if (!email || !pass) return setAuthError("Completá email y contraseña.");
    setAuthBusy(true);

    try {
      const { data: users } = await ghGetJson(PATH_USERS, []);
      const list = Array.isArray(users) ? users : [];
      const u = list.find((x) => String(x.email).toLowerCase() === String(email).toLowerCase());
      if (!u) throw new Error("Usuario inexistente.");

      const hash = await sha256Hex(pass);
      if (hash !== u.pass_sha256) throw new Error("Contraseña incorrecta.");

      setMe({ id: u.id, email: u.email });
      setPass("");
      setPass2("");
    } catch (e) {
      setAuthError(String(e?.message || e));
    } finally {
      setAuthBusy(false);
    }
  }

  function logout() {
    setMe(null);
    setTeams([]);
    setInterests([]);
  }

  const debouncedSaveProfile = useDebouncedCallback(async (next) => {
    if (!me) return;
    setSaveInfo("Guardando…");
    try {
      await ghPutJsonWithRetry(
        PATH_TEAMS,
        (cur) => {
          const i = cur.findIndex((x) => x.user_id === me.id);
          const row = {
            user_id: me.id,
            display_name: next.display_name,
            team_name: next.team_name,
            team_status: next.team_status,
            roster: cur[i]?.roster || [],
            status_overrides: cur[i]?.status_overrides || {},
            asset_values: cur[i]?.asset_values || {},
            updated_at: nowIso(),
          };
          if (i === -1) return [...cur, row];
          const copy = [...cur];
          copy[i] = row;
          return copy;
        },
        "update profile"
      );
      await refreshData();
      setSaveInfo("Guardado ✓");
      setTimeout(() => setSaveInfo(""), 1200);
    } catch (e) {
      setSaveInfo(`Error al guardar: ${String(e?.message || e)}`);
    }
  }, 650);

  function onProfileChange(patch) {
    const next = {
      display_name: patch.display_name ?? myDisplayName,
      team_name: patch.team_name ?? myTeamName,
      team_status: patch.team_status ?? myStatus,
    };
    if (patch.display_name != null) setMyDisplayName(patch.display_name);
    if (patch.team_name != null) setMyTeamName(patch.team_name);
    if (patch.team_status != null) setMyStatus(patch.team_status);
    debouncedSaveProfile(next);
  }

  async function setInterest(toUserId, assetType, assetId, level, note = "") {
    if (!me) return;

    const key = `${me.id}__${toUserId}__${assetType}__${assetId}`;
    const nextLocal = interests.filter((x) => x.key !== key);
    if (level && level !== "NONE") {
      nextLocal.push({
        key,
        from_user_id: me.id,
        to_user_id: toUserId,
        asset_type: assetType,
        asset_id: assetId,
        level,
        note: note || "",
        updated_at: nowIso(),
      });
    }
    setInterests(nextLocal);

    try {
      await ghPutJsonWithRetry(
        PATH_INTERESTS,
        (cur) => {
          const filtered = cur.filter((x) => x.key !== key);
          if (level && level !== "NONE") {
            filtered.push({
              key,
              from_user_id: me.id,
              to_user_id: toUserId,
              asset_type: assetType,
              asset_id: assetId,
              level,
              note: note || "",
              updated_at: nowIso(),
            });
          }
          return filtered;
        },
        "update interest"
      );
      await refreshData();
    } catch (e) {
      setBootError(`No pude guardar interest: ${String(e?.message || e)}`);
    }
  }

  const picks = useMemo(
    () => [
      { id: "2026-1", label: "2026 1st" },
      { id: "2026-2", label: "2026 2nd" },
      { id: "2027-1", label: "2027 1st" },
      { id: "2027-2", label: "2027 2nd" },
    ],
    []
  );

  if (bootError) {
    return (
      <div className="ftbPage">
        <GlobalStyles />
        <div className="ftbContainer">
        <h2 style={{ marginTop: 0 }}>Error</h2>
        <Card>
          <div style={{ color: COLORS.danger, fontWeight: 800, marginBottom: 10 }}>{bootError}</div>
          <div style={{ color: COLORS.gray, lineHeight: 1.5 }}>
            Checklist:
            <ul>
              <li>Definí VITE_GH_OWNER / VITE_GH_REPO / VITE_GH_BRANCH</li>
              <li>Definí VITE_GH_TOKEN con permisos de lectura/escritura de Contents</li>
              <li>Existencia de <code>/data/users.json</code>, <code>/data/league_teams.json</code>, <code>/data/interests.json</code></li>
            </ul>
          </div>
          <Button variant="ghost" onClick={() => setBootError("")}>
            Cerrar
          </Button>
        </Card>
      </div>
      </div>
    );
  }

  return (
    <div className="ftbPage">
      <GlobalStyles />
      <TopBar theme={theme} onTheme={applyTheme} me={me} onLogout={logout} />

      <div className="ftbContainer">
        <h1 className="ftbTitle">Fantasy Trade Board</h1>

        {!me ? (
          <Card className="authCard">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0 }}>{authMode === "login" ? "Iniciar sesión" : "Crear cuenta"}</h2>
              <Button
                variant="ghost"
                onClick={() => {
                  setAuthMode(authMode === "login" ? "signup" : "login");
                  setAuthError("");
                }}
              >
                {authMode === "login" ? "Crear cuenta" : "Tengo cuenta"}
              </Button>
            </div>

            <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
              <Input value={email} onChange={setEmail} placeholder="Email" />
              <Input value={pass} onChange={setPass} placeholder="Contraseña" type="password" />
              {authMode === "signup" && (
                <Input value={pass2} onChange={setPass2} placeholder="Repetir contraseña" type="password" />
              )}
              <Button disabled={authBusy} onClick={authMode === "login" ? login : signup} style={{ padding: "14px 16px", fontSize: 18 }}>
                {authBusy ? "Procesando…" : authMode === "login" ? "Entrar" : "Crear cuenta"}
              </Button>
              {!!authError && <div style={{ color: COLORS.danger, fontWeight: 800 }}>{authError}</div>}
              <div style={{ color: COLORS.gray, fontSize: 13, lineHeight: 1.4 }}>
                Nota: usuarios y data se guardan en JSON dentro del repo (inseguro).
              </div>
            </div>
          </Card>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 14, color: COLORS.gray }}>Conectado como</div>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>{me.email}</div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <Button variant="ghost" onClick={refreshData}>
                    Refrescar
                  </Button>
                  <div style={{ color: COLORS.gray, fontWeight: 700 }}>{saveInfo}</div>
                </div>
              </div>

              <div className="grid3" style={{ marginTop: 14 }}>
                <div>
                  <div style={{ fontSize: 13, color: COLORS.gray, marginBottom: 6 }}>Display name</div>
                  <Input value={myDisplayName} onChange={(v) => onProfileChange({ display_name: v })} placeholder="Ej: Nico" />
                </div>
                <div>
                  <div style={{ fontSize: 13, color: COLORS.gray, marginBottom: 6 }}>Team name</div>
                  <Input value={myTeamName} onChange={(v) => onProfileChange({ team_name: v })} placeholder="Ej: Blue Blitz" />
                </div>
                <div>
                  <div style={{ fontSize: 13, color: COLORS.gray, marginBottom: 6 }}>Estado</div>
                  <select
                    value={myStatus}
                    onChange={(e) => onProfileChange({ team_status: e.target.value })}
                    style={{
                      width: "100%",
                      minWidth: 0,
                      boxSizing: "border-box",
                      padding: "14px 14px",
                      borderRadius: 14,
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.sky,
                      color: COLORS.navy,
                      fontSize: 16,
                      fontWeight: 700,
                    }}
                  >
                    <option>Contendiendo</option>
                    <option>Reconstrucción</option>
                    <option>Re-tool</option>
                    <option>Tanqueando</option>
                  </select>
                </div>
              </div>
            </Card>

            <LeagueBoard
              me={me}
              teams={teams}
              interests={interests}
              picks={picks}
              byUser={byUser}
              onSetInterest={setInterest}
            />

            <div className="grid2">
              <Card>
                <h3 style={{ marginTop: 0 }}>Incoming (a mí)</h3>
                {myIncoming.length === 0 ? (
                  <div style={{ color: COLORS.gray }}>Nadie marcó interés por tus assets (todavía).</div>
                ) : (
                  <InterestList rows={myIncoming} byUser={byUser} />
                )}
              </Card>
              <Card>
                <h3 style={{ marginTop: 0 }}>Outgoing (míos)</h3>
                {myOutgoing.length === 0 ? (
                  <div style={{ color: COLORS.gray }}>Todavía no marcaste intereses.</div>
                ) : (
                  <InterestList rows={myOutgoing} byUser={byUser} />
                )}
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TopBar({ theme, onTheme, me, onLogout }) {
  return (
    <div className="topbar">
      <div className="topbarInner">
        <Button variant="ghost" onClick={() => onTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
        </Button>
        {me && (
          <Button variant="danger" onClick={onLogout}>
            Salir
          </Button>
        )}
      </div>
    </div>
  );
}

function LeagueBoard({ me, teams, interests, picks, byUser, onSetInterest }) {
  const [selectedUserId, setSelectedUserId] = useState("");
  const otherTeams = useMemo(() => teams.filter((t) => t.user_id !== me.id), [teams, me.id]);

  useEffect(() => {
    if (!selectedUserId && otherTeams.length) setSelectedUserId(otherTeams[0].user_id);
  }, [otherTeams.length]);

  const selected = byUser.get(selectedUserId);

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Liga</h2>
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          style={{
            padding: "10px 12px",
            minWidth: 220,
            flex: "1 1 220px",
            boxSizing: "border-box",
            borderRadius: 12,
            border: `1px solid ${COLORS.border}`,
            background: COLORS.sky,
            color: COLORS.navy,
            fontWeight: 800,
          }}
        >
          {otherTeams.map((t) => (
            <option key={t.user_id} value={t.user_id}>
              {(t.display_name || t.user_id).slice(0, 30)} {t.team_name ? `— ${t.team_name}` : ""}
            </option>
          ))}
        </select>
      </div>

      {!selected ? (
        <div style={{ marginTop: 12, color: COLORS.gray }}>No hay otro equipo seleccionado.</div>
      ) : (
        <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>
            {selected.display_name} {selected.team_name ? `— ${selected.team_name}` : ""}
          </div>
          <div>
            <Pill tone="neutral">{selected.team_status || "—"}</Pill>
          </div>

          <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
            <h3 style={{ margin: 0 }}>Assets (demo: picks)</h3>

            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              {picks.map((p) => (
                <AssetRow
                  key={p.id}
                  label={p.label}
                  current={interests.find(
                    (x) =>
                      x.from_user_id === me.id &&
                      x.to_user_id === selected.user_id &&
                      x.asset_type === "PICK" &&
                      x.asset_id === p.id
                  )}
                  onSet={(level, note) => onSetInterest(selected.user_id, "PICK", p.id, level, note)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function AssetRow({ label, current, onSet }) {
  const [note, setNote] = useState(current?.note || "");
  useEffect(() => setNote(current?.note || ""), [current?.key]);

  const level = current?.level || "NONE";
  return (
    <div
      className="assetRow"
      style={{
        padding: 12,
        borderRadius: 14,
        border: `1px solid ${COLORS.border}`,
        background: COLORS.soft,
      }}
    >
      <div style={{ display: "grid", gap: 8 }}>
        <div className="breakAnywhere" style={{ fontWeight: 900 }}>{label}</div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant={level === "LOW" ? "primary" : "ghost"} onClick={() => onSet(level === "LOW" ? "NONE" : "LOW", note)} style={{ padding: "8px 10px" }}>
            LOW
          </Button>
          <Button variant={level === "MED" ? "primary" : "ghost"} onClick={() => onSet(level === "MED" ? "NONE" : "MED", note)} style={{ padding: "8px 10px" }}>
            MED
          </Button>
          <Button variant={level === "HIGH" ? "primary" : "ghost"} onClick={() => onSet(level === "HIGH" ? "NONE" : "HIGH", note)} style={{ padding: "8px 10px" }}>
            HIGH
          </Button>

          <div style={{ flex: 1 }} />
          <Pill tone={level === "HIGH" ? "good" : "neutral"}>{level}</Pill>
        </div>

        <Input value={note} onChange={setNote} placeholder="nota (opcional)" />
      </div>

      <div className="assetActions">
        <Button variant="primary" onClick={() => onSet(level, note)} style={{ padding: "10px 12px" }}>
          Guardar
        </Button>
        <Button variant="danger" onClick={() => onSet("NONE", "")} style={{ padding: "10px 12px" }}>
          Borrar
        </Button>
      </div>
    </div>
  );
}

function InterestList({ rows, byUser }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows
        .slice()
        .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
        .map((r) => {
          const from = byUser.get(r.from_user_id);
          const to = byUser.get(r.to_user_id);
          return (
            <div key={r.key} style={{ padding: 12, borderRadius: 14, border: `1px solid ${COLORS.border}`, background: COLORS.soft }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <div className="breakAnywhere" style={{ fontWeight: 900 }}>
                  {(from?.display_name || r.from_user_id)} → {(to?.display_name || r.to_user_id)}
                </div>
                <Pill tone={r.level === "HIGH" ? "good" : "neutral"}>{r.level}</Pill>
              </div>
              <div style={{ marginTop: 6, color: COLORS.gray, fontSize: 13 }}>
                {r.asset_type}: {r.asset_id} · {r.updated_at ? new Date(r.updated_at).toLocaleString() : ""}
              </div>
              {r.note ? <div style={{ marginTop: 8 }}>{r.note}</div> : null}
            </div>
          );
        })}
    </div>
  );
}
