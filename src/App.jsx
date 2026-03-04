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

/** ========= domain ========= */
const ROSTER_SLOTS = [
  { id: "QB", label: "QB", limit: 1, accepts: ["QB"] },
  { id: "RB", label: "RB", limit: 2, accepts: ["RB"] },
  { id: "WR", label: "WR", limit: 1, accepts: ["WR"] },
  { id: "TE", label: "TE", limit: 1, accepts: ["TE"] },
  { id: "FLEX", label: "FLEX", limit: 3, accepts: ["RB", "WR", "TE"] },
  { id: "BN", label: "BN", limit: 21, accepts: ["QB", "RB", "WR", "TE"] },
];

const PLAYER_STATUSES = ["Disponible", "En escucha", "No disponible"]; // cycle
const INTEREST_LEVELS = [
  { id: "LOW", label: "Bajo" },
  { id: "MED", label: "Medio" },
  { id: "HIGH", label: "Alto" },
];

function assetKey(type, id) {
  return `${type}:${id}`;
}

function pickId2026(round, slot) {
  const r = String(round);
  const s = String(slot).padStart(2, "0");
  return `2026-${r}.${s}`;
}

function generatePickCatalog() {
  const out = [];
  // 2026: 6 rondas x 10 picks numerados
  for (let round = 1; round <= 6; round++) {
    for (let slot = 1; slot <= 10; slot++) {
      const id = pickId2026(round, slot);
      out.push({
        id,
        type: "PICK",
        year: 2026,
        round,
        slot,
        label: `${String(round)}.${String(slot).padStart(2, "0")} 2026`,
      });
    }
  }
  // 2027/2028: por ronda (sin número)
  for (const year of [2027, 2028]) {
    for (let round = 1; round <= 6; round++) {
      out.push({
        id: `${year}-${round}`,
        type: "PICK",
        year,
        round,
        slot: null,
        label: `${round}ra ${year}`,
      });
    }
  }
  return out;
}

function normalizePos(p) {
  const v = String(p || "").toUpperCase().trim();
  if (v === "QB" || v === "RB" || v === "WR" || v === "TE") return v;
  return v || "";
}

function slotForNewPlayer(pos, currentRoster) {
  const counts = new Map();
  for (const s of ROSTER_SLOTS) counts.set(s.id, 0);
  for (const a of currentRoster || []) {
    if (a.type !== "PLAYER") continue;
    counts.set(a.slot || "BN", (counts.get(a.slot || "BN") || 0) + 1);
  }
  // natural
  const natural = ROSTER_SLOTS.find((s) => s.id === pos);
  if (natural && (counts.get(natural.id) || 0) < natural.limit) return natural.id;
  // flex
  const flex = ROSTER_SLOTS.find((s) => s.id === "FLEX");
  if (flex && flex.accepts.includes(pos) && (counts.get("FLEX") || 0) < flex.limit) return "FLEX";
  return "BN";
}

const SAMPLE_PLAYERS = [
  { id: "1111", name: "Ja'Marr Chase", pos: "WR", nfl: "CIN" },
  { id: "5041", name: "Bijan Robinson", pos: "RB", nfl: "ATL" },
  { id: "3333", name: "CeeDee Lamb", pos: "WR", nfl: "DAL" },
  { id: "2222", name: "Justin Jefferson", pos: "WR", nfl: "MIN" },
  { id: "4444", name: "Jahmyr Gibbs", pos: "RB", nfl: "DET" },
  { id: "5555", name: "Josh Jacobs", pos: "RB", nfl: "GB" },
  { id: "6666", name: "A.J. Brown", pos: "WR", nfl: "PHI" },
  { id: "7777", name: "Tua Tagovailoa", pos: "QB", nfl: "MIA" },
  { id: "8888", name: "Josh Allen", pos: "QB", nfl: "BUF" },
  { id: "9999", name: "Amon-Ra St. Brown", pos: "WR", nfl: "DET" },
];

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
async function ghGetFile(path) {
  const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return { exists: false, sha: null, content: "" };
  if (!res.ok) throw new Error(await res.text());
  const j = await res.json();

  // GitHub devuelve base64 con \n cada X chars.
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await ghGetJson(path, []);
    const arr = Array.isArray(data) ? data : [];
    const next = mutator(arr);
    try {
      await ghPutJson(path, next, sha, label);
      return next;
    } catch (e) {
      if (e?.code === 409 && attempt === 0) continue;
      throw e;
    }
  }
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

      .breakAnywhere{ min-width: 0; overflow-wrap: anywhere; }

      @media (max-width: 860px){
        .grid3{ grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 720px){
        .topbarInner{ flex-wrap: wrap; }
        .grid3{ grid-template-columns: 1fr; }
        .grid2{ grid-template-columns: 1fr; }
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
    variant === "primary" ? COLORS.blue : variant === "danger" ? COLORS.danger : "transparent";
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

  // ui tabs
  const [tab, setTab] = useState("home"); // home | myteam | league | interests

  // players catalog
  const [playerCatalog, setPlayerCatalog] = useState(SAMPLE_PLAYERS);
  const pickCatalog = useMemo(() => generatePickCatalog(), []);

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
    // levantar /public/adp.json si existe
    (async () => {
      try {
        const res = await fetch("/adp.json", { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        const arr = Array.isArray(j) ? j : Array.isArray(j?.players) ? j.players : [];
        const cleaned = arr
          .map((p) => ({
            id: String(p.id ?? p.player_id ?? p.pid ?? ""),
            name: String(p.name ?? p.player_name ?? p.full_name ?? "").trim(),
            pos: normalizePos(p.pos ?? p.position),
            nfl: String(p.nfl ?? p.team ?? p.nfl_team ?? "").trim().toUpperCase(),
          }))
          .filter((p) => p.id && p.name && ["QB", "RB", "WR", "TE"].includes(p.pos));
        if (cleaned.length >= 30) setPlayerCatalog(cleaned);
      } catch {
        // silent
      }
    })();
  }, []);

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

  const myOutgoing = useMemo(
    () => (me ? interests.filter((x) => x.from_user_id === me.id) : []),
    [interests, me?.id]
  );
  const myIncoming = useMemo(
    () => (me ? interests.filter((x) => x.to_user_id === me.id) : []),
    [interests, me?.id]
  );

  const myTeamRow = useMemo(() => (me ? teams.find((x) => x.user_id === me.id) : null), [teams, me?.id]);
  const myRoster = useMemo(() => (Array.isArray(myTeamRow?.roster) ? myTeamRow.roster : []), [myTeamRow?.roster]);
  const myStatusOverrides = useMemo(
    () => (myTeamRow?.status_overrides && typeof myTeamRow.status_overrides === "object" ? myTeamRow.status_overrides : {}),
    [myTeamRow?.status_overrides]
  );

  async function signup() {
    setAuthError("");
    if (!email || !pass) return setAuthError("Completá email y contraseña.");
    if (pass.length < 6) return setAuthError("La contraseña debe tener al menos 6 caracteres.");
    if (pass !== pass2) return setAuthError("Las contraseñas no coinciden.");
    setAuthBusy(true);

    try {
      const { data: users, sha } = await ghGetJson(PATH_USERS, []);
      const list = Array.isArray(users) ? users : [];
      const exists = list.some((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
      if (exists) throw new Error("Ese email ya existe.");

      const id = uid("user");
      const hash = await sha256Hex(pass);
      const next = [...list, { id, email, pass_sha256: hash, created_at: nowIso() }];

      await ghPutJson(PATH_USERS, next, sha, "signup user");

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
      setTab("home");
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
      setTab("home");
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

  async function updateMyTeam(mutator, label) {
    if (!me) return;
    try {
      await ghPutJsonWithRetry(
        PATH_TEAMS,
        (cur) => {
          const i = cur.findIndex((x) => x.user_id === me.id);
          const prev = i === -1 ? null : cur[i];
          const base = prev || {
            user_id: me.id,
            display_name: myDisplayName || me.email?.split("@")[0] || "",
            team_name: myTeamName || "",
            team_status: myStatus || "Contendiendo",
            roster: [],
            status_overrides: {},
            asset_values: {},
            updated_at: nowIso(),
          };
          const nextRow = mutator({ ...base });
          nextRow.updated_at = nowIso();
          const next = [...cur];
          if (i === -1) next.push(nextRow);
          else next[i] = nextRow;
          return next;
        },
        label
      );
      await refreshData();
    } catch (e) {
      setBootError(`No pude guardar equipo: ${String(e?.message || e)}`);
    }
  }

  function cyclePlayerStatus(current) {
    const i = PLAYER_STATUSES.indexOf(current || "Disponible");
    return PLAYER_STATUSES[(i + 1 + PLAYER_STATUSES.length) % PLAYER_STATUSES.length];
  }

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
                <li>
                  Existencia de <code>/data/users.json</code>, <code>/data/league_teams.json</code>,{" "}
                  <code>/data/interests.json</code>
                </li>
              </ul>
            </div>
            <Button variant="ghost" onClick={() => setBootError("")}>Cerrar</Button>
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
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
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
              <Button
                disabled={authBusy}
                onClick={authMode === "login" ? login : signup}
                style={{ padding: "14px 16px", fontSize: 18 }}
              >
                {authBusy ? "Procesando…" : authMode === "login" ? "Entrar" : "Crear cuenta"}
              </Button>
              {!!authError && <div style={{ color: COLORS.danger, fontWeight: 800 }}>{authError}</div>}
              <div style={{ color: COLORS.gray, fontSize: 13, lineHeight: 1.4 }}>
                Nota: usuarios y data se guardan en JSON dentro del repo (inseguro).
              </div>
            </div>
          </Card>
        ) : (
          <div style={{ display: "grid", gap: 16, paddingBottom: 74 }}>
            {tab === "home" ? (
              <HomeTab
                me={me}
                myDisplayName={myDisplayName}
                myTeamName={myTeamName}
                myStatus={myStatus}
                onProfileChange={onProfileChange}
                onRefresh={refreshData}
                saveInfo={saveInfo}
              />
            ) : tab === "myteam" ? (
              <MyTeamTab
                roster={myRoster}
                statusOverrides={myStatusOverrides}
                playerCatalog={playerCatalog}
                pickCatalog={pickCatalog}
                onAddPlayer={async (p) => {
                  await updateMyTeam(
                    (row) => {
                      const exists = (row.roster || []).some((a) => a.type === "PLAYER" && a.id === p.id);
                      if (exists) return row;
                      const nextRoster = Array.isArray(row.roster) ? [...row.roster] : [];
                      nextRoster.push({
                        type: "PLAYER",
                        id: p.id,
                        name: p.name,
                        pos: normalizePos(p.pos),
                        nfl: String(p.nfl || "").toUpperCase(),
                        slot: slotForNewPlayer(normalizePos(p.pos), nextRoster),
                        created_at: nowIso(),
                      });
                      row.roster = nextRoster;
                      return row;
                    },
                    "add player"
                  );
                }}
                onAddPick={async (pick) => {
                  await updateMyTeam(
                    (row) => {
                      const exists = (row.roster || []).some((a) => a.type === "PICK" && a.id === pick.id);
                      if (exists) return row;
                      const nextRoster = Array.isArray(row.roster) ? [...row.roster] : [];
                      nextRoster.push({
                        type: "PICK",
                        id: pick.id,
                        label: pick.label,
                        year: pick.year,
                        round: pick.round,
                        slot: pick.slot,
                        created_at: nowIso(),
                      });
                      row.roster = nextRoster;
                      return row;
                    },
                    "add pick"
                  );
                }}
                onRemoveAsset={async (type, id) => {
                  await updateMyTeam(
                    (row) => {
                      row.roster = (Array.isArray(row.roster) ? row.roster : []).filter((a) => !(a.type === type && a.id === id));
                      const k = assetKey(type, id);
                      if (row.status_overrides && typeof row.status_overrides === "object") {
                        const so = { ...row.status_overrides };
                        delete so[k];
                        row.status_overrides = so;
                      }
                      return row;
                    },
                    "remove asset"
                  );
                }}
                onTogglePlayerStatus={async (playerId) => {
                  await updateMyTeam(
                    (row) => {
                      const so = row.status_overrides && typeof row.status_overrides === "object" ? { ...row.status_overrides } : {};
                      const k = assetKey("PLAYER", playerId);
                      so[k] = cyclePlayerStatus(so[k] || "Disponible");
                      row.status_overrides = so;
                      return row;
                    },
                    "toggle player status"
                  );
                }}
                onChangePlayerSlot={async (playerId, nextSlot) => {
                  await updateMyTeam(
                    (row) => {
                      row.roster = (Array.isArray(row.roster) ? row.roster : []).map((a) =>
                        a.type === "PLAYER" && a.id === playerId ? { ...a, slot: nextSlot } : a
                      );
                      return row;
                    },
                    "move player slot"
                  );
                }}
              />
            ) : tab === "league" ? (
              <LeagueTab me={me} teams={teams} interests={interests} byUser={byUser} onSetInterest={setInterest} />
            ) : (
              <InterestsTab me={me} byUser={byUser} outgoing={myOutgoing} incoming={myIncoming} teams={teams} />
            )}

            <BottomNav tab={tab} onTab={setTab} />
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

function HomeTab({ me, myDisplayName, myTeamName, myStatus, onProfileChange, onRefresh, saveInfo }) {
  return (
    <Card>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 14, color: COLORS.gray }}>Conectado como</div>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{me.email}</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Button variant="ghost" onClick={onRefresh}>
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
          <Input value={myTeamName} onChange={(v) => onProfileChange({ team_name: v })} placeholder="Ej: Mojarrita" />
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
  );
}

function BottomNav({ tab, onTab }) {
  const items = [
    { id: "home", label: "Inicio" },
    { id: "league", label: "Liga" },
    { id: "interests", label: "Intereses" },
    { id: "myteam", label: "Mi equipo" },
  ];
  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        padding: "10px 14px",
        background: "rgba(10, 18, 34, 0.65)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderTop: `1px solid ${COLORS.border}`,
        zIndex: 20,
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        {items.map((it) => (
          <Button
            key={it.id}
            variant={tab === it.id ? "primary" : "ghost"}
            onClick={() => onTab(it.id)}
            style={{ padding: "12px 10px", borderRadius: 999 }}
          >
            {it.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function MyTeamTab({
  roster,
  statusOverrides,
  playerCatalog,
  pickCatalog,
  onAddPlayer,
  onAddPick,
  onRemoveAsset,
  onTogglePlayerStatus,
  onChangePlayerSlot,
}) {
  const [mode, setMode] = useState("players"); // players | picks
  const [q, setQ] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");

  const rosterPlayers = useMemo(() => (roster || []).filter((a) => a.type === "PLAYER"), [roster]);
  const rosterPicks = useMemo(() => (roster || []).filter((a) => a.type === "PICK"), [roster]);

  const rosterPlayerIds = useMemo(() => new Set(rosterPlayers.map((p) => String(p.id))), [rosterPlayers]);
  const rosterPickIds = useMemo(() => new Set(rosterPicks.map((p) => String(p.id))), [rosterPicks]);

  const filteredPlayers = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return playerCatalog
      .filter((p) => (posFilter === "ALL" ? true : normalizePos(p.pos) === posFilter))
      .filter((p) => (qq ? p.name.toLowerCase().includes(qq) : true))
      .slice(0, 140);
  }, [playerCatalog, q, posFilter]);

  const filteredPicks = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return pickCatalog.filter((p) => (qq ? p.label.toLowerCase().includes(qq) : true)).slice(0, 220);
  }, [pickCatalog, q]);

  const slotGroups = useMemo(() => {
    const g = new Map();
    for (const s of ROSTER_SLOTS) g.set(s.id, []);
    for (const p of rosterPlayers) {
      const k = p.slot || "BN";
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(p);
    }
    for (const [k, arr] of g.entries()) {
      arr.sort((a, b) => String(a.pos).localeCompare(String(b.pos)) || String(a.name).localeCompare(String(b.name)));
    }
    return g;
  }, [rosterPlayers]);

  const formatLine = "1 QB · 2 RB · 1 WR · 1 TE · 3 FLEX · 21 BN";

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card style={{ background: COLORS.sky }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 950 }}>Mi equipo (slots)</div>
            <div style={{ color: COLORS.gray, marginTop: 6 }}>Tocá el botón de estado: Disponible → En escucha → No disponible</div>
            <div style={{ color: COLORS.gray, marginTop: 6, fontSize: 13 }}>Formato: {formatLine}</div>
          </div>
        </div>
      </Card>

      <div className="grid2">
        <Card>
          <div style={{ display: "flex", gap: 10 }}>
            <Button variant={mode === "players" ? "primary" : "ghost"} onClick={() => setMode("players")} style={{ flex: 1, borderRadius: 14 }}>
              Jugadores
            </Button>
            <Button variant={mode === "picks" ? "primary" : "ghost"} onClick={() => setMode("picks")} style={{ flex: 1, borderRadius: 14 }}>
              Picks
            </Button>
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <Input value={q} onChange={setQ} placeholder={mode === "players" ? "Buscar jugador por nombre…" : "Buscar pick…"} />
            {mode === "players" ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[
                  { id: "ALL", label: "Todos" },
                  { id: "QB", label: "QB" },
                  { id: "RB", label: "RB" },
                  { id: "WR", label: "WR" },
                  { id: "TE", label: "TE" },
                ].map((p) => (
                  <Button key={p.id} variant={posFilter === p.id ? "primary" : "ghost"} onClick={() => setPosFilter(p.id)} style={{ padding: "8px 10px", borderRadius: 999 }}>
                    {p.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          <div style={{ marginTop: 12, maxHeight: 520, overflow: "auto", paddingRight: 6 }}>
            <div style={{ display: "grid", gap: 10 }}>
              {mode === "players"
                ? filteredPlayers.map((p) => {
                    const added = rosterPlayerIds.has(String(p.id));
                    return (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: 12, borderRadius: 14, border: `1px solid ${COLORS.border}`, background: COLORS.soft }}>
                        <div className="breakAnywhere">
                          <div style={{ fontWeight: 900 }}>{p.name}</div>
                          <div style={{ color: COLORS.gray, fontSize: 13 }}>{normalizePos(p.pos)} · {String(p.nfl || "").toUpperCase()}</div>
                        </div>
                        <Button disabled={added} variant={added ? "ghost" : "primary"} onClick={() => onAddPlayer(p)} style={{ padding: "10px 12px", borderRadius: 12 }}>
                          {added ? "Agregado" : "+ Agregar"}
                        </Button>
                      </div>
                    );
                  })
                : filteredPicks.map((p) => {
                    const added = rosterPickIds.has(String(p.id));
                    return (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: 12, borderRadius: 14, border: `1px solid ${COLORS.border}`, background: COLORS.soft }}>
                        <div className="breakAnywhere">
                          <div style={{ fontWeight: 900 }}>{p.label}</div>
                          <div style={{ color: COLORS.gray, fontSize: 13 }}>Pick</div>
                        </div>
                        <Button disabled={added} variant={added ? "ghost" : "primary"} onClick={() => onAddPick(p)} style={{ padding: "10px 12px", borderRadius: 12 }}>
                          {added ? "Agregado" : "+ Agregar"}
                        </Button>
                      </div>
                    );
                  })}
            </div>
          </div>
        </Card>

        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 18, fontWeight: 950 }}>Roster</div>
            <div style={{ color: COLORS.gray, fontSize: 13 }}>{rosterPlayers.length} jugadores · {rosterPicks.length} picks</div>
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 16 }}>
            {ROSTER_SLOTS.map((s) => {
              const arr = slotGroups.get(s.id) || [];
              return (
                <div key={s.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <div style={{ fontWeight: 950 }}>{s.label}</div>
                    <div style={{ color: COLORS.gray, fontWeight: 800 }}>{arr.length}/{s.limit}</div>
                  </div>
                  <div style={{ marginTop: 8, display: "grid", gap: 10 }}>
                    {arr.length === 0 ? (
                      <div style={{ color: COLORS.gray, fontSize: 13 }}>—</div>
                    ) : (
                      arr.map((p) => {
                        const k = assetKey("PLAYER", p.id);
                        const st = statusOverrides?.[k] || "Disponible";
                        return (
                          <div key={p.id} style={{ padding: 12, borderRadius: 14, border: `1px solid ${COLORS.border}`, background: COLORS.soft, display: "grid", gap: 10 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                              <div className="breakAnywhere">
                                <div style={{ fontWeight: 950 }}>{p.name}</div>
                                <div style={{ color: COLORS.gray, fontSize: 13 }}>{normalizePos(p.pos)} · {String(p.nfl || "").toUpperCase()}</div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <select
                                  value={p.slot || "BN"}
                                  onChange={(e) => onChangePlayerSlot(p.id, e.target.value)}
                                  style={{
                                    padding: "10px 12px",
                                    borderRadius: 12,
                                    border: `1px solid ${COLORS.border}`,
                                    background: COLORS.sky,
                                    color: COLORS.navy,
                                    fontWeight: 900,
                                  }}
                                >
                                  {ROSTER_SLOTS.map((ss) => (
                                    <option key={ss.id} value={ss.id}>
                                      {ss.label}
                                    </option>
                                  ))}
                                </select>
                                <Button
                                  variant={st === "No disponible" ? "danger" : st === "En escucha" ? "primary" : "ghost"}
                                  onClick={() => onTogglePlayerStatus(p.id)}
                                  style={{ padding: "10px 12px", borderRadius: 999 }}
                                >
                                  {st}
                                </Button>
                                <Button variant="ghost" onClick={() => onRemoveAsset("PLAYER", p.id)} style={{ padding: "10px 12px", borderRadius: 12 }}>
                                  ✕
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}

            <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 950 }}>Picks</div>
                <div style={{ color: COLORS.gray, fontWeight: 800 }}>{rosterPicks.length}</div>
              </div>
              <div style={{ marginTop: 8, display: "grid", gap: 10 }}>
                {rosterPicks.length === 0 ? (
                  <div style={{ color: COLORS.gray, fontSize: 13 }}>—</div>
                ) : (
                  rosterPicks
                    .slice()
                    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                    .map((p) => (
                      <div key={p.id} style={{ padding: 12, borderRadius: 14, border: `1px solid ${COLORS.border}`, background: COLORS.soft, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                        <div className="breakAnywhere" style={{ fontWeight: 950 }}>{p.label || p.id}</div>
                        <Button variant="ghost" onClick={() => onRemoveAsset("PICK", p.id)} style={{ padding: "10px 12px", borderRadius: 12 }}>
                          ✕
                        </Button>
                      </div>
                    ))
                )}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function LeagueTab({ me, teams, interests, byUser, onSetInterest }) {
  const [selectedUserId, setSelectedUserId] = useState("");
  const otherTeams = useMemo(() => teams.filter((t) => t.user_id !== me.id), [teams, me.id]);

  useEffect(() => {
    if (!selectedUserId && otherTeams.length) setSelectedUserId(otherTeams[0].user_id);
  }, [otherTeams.length]);

  const selected = byUser.get(selectedUserId);
  const selectedRoster = useMemo(() => (Array.isArray(selected?.roster) ? selected.roster : []), [selected?.roster]);
  const selectedStatusOverrides = useMemo(
    () => (selected?.status_overrides && typeof selected.status_overrides === "object" ? selected.status_overrides : {}),
    [selected?.status_overrides]
  );

  const players = useMemo(() => selectedRoster.filter((a) => a.type === "PLAYER"), [selectedRoster]);
  const picks = useMemo(() => selectedRoster.filter((a) => a.type === "PICK"), [selectedRoster]);

  function currentInterest(assetType, assetId) {
    return interests.find(
      (x) => x.from_user_id === me.id && x.to_user_id === selectedUserId && x.asset_type === assetType && x.asset_id === assetId
    );
  }

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
            fontWeight: 900,
          }}
        >
          {otherTeams.map((t) => (
            <option key={t.user_id} value={t.user_id}>
              {(t.team_name || t.display_name || t.user_id).slice(0, 36)}
            </option>
          ))}
        </select>
      </div>

      {!selected ? (
        <div style={{ marginTop: 12, color: COLORS.gray }}>No hay otro equipo seleccionado.</div>
      ) : (
        <div style={{ marginTop: 14, display: "grid", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 18, fontWeight: 950 }}>
              {selected.team_name || "(sin nombre)"} · <span style={{ color: COLORS.gray }}>{selected.display_name || selected.user_id}</span>
            </div>
            <Pill tone="neutral">{selected.team_status || "—"}</Pill>
          </div>

          <div className="grid2">
            <Card style={{ boxShadow: "none" }}>
              <h3 style={{ marginTop: 0 }}>Roster</h3>
              {players.length === 0 && picks.length === 0 ? (
                <div style={{ color: COLORS.gray }}>Este equipo todavía no cargó assets.</div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {players
                    .slice()
                    .sort((a, b) => String(a.pos).localeCompare(String(b.pos)) || String(a.name).localeCompare(String(b.name)))
                    .map((p) => {
                      const st = selectedStatusOverrides?.[assetKey("PLAYER", p.id)] || "Disponible";
                      const cur = currentInterest("PLAYER", p.id);
                      return (
                        <AssetInterestRow
                          key={`pl-${p.id}`}
                          title={p.name}
                          subtitle={`${normalizePos(p.pos)} · ${String(p.nfl || "").toUpperCase()} · ${st}`}
                          current={cur}
                          onSet={(lvl) => onSetInterest(selected.user_id, "PLAYER", p.id, lvl, "")}
                        />
                      );
                    })}

                  {picks
                    .slice()
                    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                    .map((p) => {
                      const cur = currentInterest("PICK", p.id);
                      return (
                        <AssetInterestRow
                          key={`pk-${p.id}`}
                          title={p.label || p.id}
                          subtitle={`Pick`}
                          current={cur}
                          onSet={(lvl) => onSetInterest(selected.user_id, "PICK", p.id, lvl, "")}
                        />
                      );
                    })}
                </div>
              )}
            </Card>

            <Card style={{ boxShadow: "none" }}>
              <h3 style={{ marginTop: 0 }}>Guía</h3>
              <div style={{ color: COLORS.gray, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 6 }}>Cómo usar esta pestaña</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Elegís un equipo en el selector.</li>
                  <li>Marcás interés: Bajo / Medio / Alto.</li>
                  <li>Lo ves resumido en <b>Intereses</b>.</li>
                </ul>
              </div>
            </Card>
          </div>
        </div>
      )}
    </Card>
  );
}

function AssetInterestRow({ title, subtitle, current, onSet }) {
  const level = current?.level || "NONE";
  return (
    <div style={{ padding: 12, borderRadius: 14, border: `1px solid ${COLORS.border}`, background: COLORS.soft, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div className="breakAnywhere">
          <div style={{ fontWeight: 950 }}>{title}</div>
          <div style={{ color: COLORS.gray, fontSize: 13 }}>{subtitle}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {INTEREST_LEVELS.map((l) => (
            <Button
              key={l.id}
              variant={level === l.id ? "primary" : "ghost"}
              onClick={() => onSet(level === l.id ? "NONE" : l.id)}
              style={{ padding: "8px 10px", borderRadius: 999 }}
            >
              {l.label}
            </Button>
          ))}
          <Pill tone={level === "HIGH" ? "good" : "neutral"}>{level === "NONE" ? "—" : level}</Pill>
        </div>
      </div>
    </div>
  );
}

function InterestsTab({ byUser, outgoing, incoming, teams }) {
  const teamNameById = useMemo(() => {
    const m = new Map();
    for (const t of teams) m.set(t.user_id, t.team_name || "");
    return m;
  }, [teams]);

  const outgoingSorted = useMemo(
    () => outgoing.slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))),
    [outgoing]
  );
  const incomingSorted = useMemo(
    () => incoming.slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))),
    [incoming]
  );

  const incomingByAsset = useMemo(() => {
    const m = new Map();
    for (const r of incomingSorted) {
      const k = `${r.asset_type}__${r.asset_id}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  }, [incomingSorted]);

  return (
    <Card>
      <h2 style={{ marginTop: 0 }}>Intereses</h2>
      <div className="grid2">
        <div>
          <div style={{ fontSize: 16, fontWeight: 950, marginBottom: 10 }}>Lo que me interesa</div>
          {outgoingSorted.length === 0 ? (
            <div style={{ color: COLORS.gray }}>Todavía no marcaste intereses en otros equipos.</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {outgoingSorted.map((r) => {
                const to = byUser.get(r.to_user_id);
                const owner = `${to?.team_name || teamNameById.get(r.to_user_id) || "(sin nombre)"}`;
                const who = `${to?.display_name || r.to_user_id}`;
                const label = r.level === "LOW" ? "Bajo" : r.level === "MED" ? "Medio" : r.level === "HIGH" ? "Alto" : r.level;
                return (
                  <div key={r.key} style={{ padding: 12, borderRadius: 14, border: `1px solid ${COLORS.border}`, background: COLORS.soft }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                      <div className="breakAnywhere" style={{ fontWeight: 950 }}>
                        {r.asset_type}: {r.asset_id}
                      </div>
                      <Pill tone={r.level === "HIGH" ? "good" : "neutral"}>{label}</Pill>
                    </div>
                    <div style={{ marginTop: 6, color: COLORS.gray, fontSize: 13 }}>Dueño: {owner} · {who}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: 16, fontWeight: 950, marginBottom: 10 }}>Otros interesados en mi equipo</div>
          {incomingSorted.length === 0 ? (
            <div style={{ color: COLORS.gray }}>Nadie marcó interés por tus assets (todavía).</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {[...incomingByAsset.entries()].map(([k, rows]) => {
                const first = rows[0];
                return (
                  <div key={k} style={{ padding: 12, borderRadius: 14, border: `1px solid ${COLORS.border}`, background: COLORS.soft }}>
                    <div className="breakAnywhere" style={{ fontWeight: 950 }}>
                      {first.asset_type}: {first.asset_id}
                    </div>
                    <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {rows.map((r) => {
                        const from = byUser.get(r.from_user_id);
                        const who = from?.team_name
                          ? `${from.team_name} (${from.display_name || r.from_user_id})`
                          : from?.display_name || r.from_user_id;
                        const label = r.level === "LOW" ? "Bajo" : r.level === "MED" ? "Medio" : r.level === "HIGH" ? "Alto" : r.level;
                        return (
                          <span
                            key={r.key}
                            style={{
                              padding: "8px 10px",
                              borderRadius: 999,
                              border: `1px solid ${COLORS.border}`,
                              background: COLORS.sky,
                              fontWeight: 900,
                              fontSize: 12,
                            }}
                          >
                            {who}: {label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
