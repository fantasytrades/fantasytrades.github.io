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
 * Envs (Vite):
 *   VITE_GH_OWNER, VITE_GH_REPO, VITE_GH_BRANCH, VITE_GH_TOKEN
 */
const GH_OWNER = import.meta.env.VITE_GH_OWNER;
const GH_REPO = import.meta.env.VITE_GH_REPO;
const GH_BRANCH = import.meta.env.VITE_GH_BRANCH || "main";
const GH_TOKEN = import.meta.env.VITE_GH_TOKEN;

const GH_API = "https://api.github.com";
const PATH_USERS = "data/users.json";
const PATH_TEAMS = "data/league_teams.json";
const PATH_INTERESTS = "data/interests.json";

const LEAGUE_SIZE = 10;

// 1 QB 2 RB 1 WR 1 TE 3 FLEX 21 BENCH
const SLOT_LIMITS = [
  { key: "QB", label: "QB", limit: 1, accepts: ["QB"] },
  { key: "RB", label: "RB", limit: 2, accepts: ["RB"] },
  { key: "WR", label: "WR", limit: 1, accepts: ["WR"] },
  { key: "TE", label: "TE", limit: 1, accepts: ["TE"] },
  { key: "FLEX", label: "FLEX", limit: 3, accepts: ["RB", "WR", "TE"] },
  { key: "BENCH", label: "BN", limit: 21, accepts: ["QB", "RB", "WR", "TE"] },
];

// Player availability (tu equipo)
const AVAIL_CYCLE = ["AVAILABLE", "LISTENING", "NOT_AVAILABLE"];
const AVAIL_LABEL = {
  AVAILABLE: "Disponible",
  LISTENING: "En escucha",
  NOT_AVAILABLE: "No disponible",
};
const AVAIL_TONE = {
  AVAILABLE: "good",
  LISTENING: "neutral",
  NOT_AVAILABLE: "bad",
};

// Interest levels (tu interés sobre assets ajenos)
const INTEREST_LEVELS = ["LOW", "MEDIUM", "HIGH"];
const INTEREST_LABEL = { LOW: "Bajo", MEDIUM: "Medio", HIGH: "Alto" };

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

// IMPORTANT: GitHub acepta esquemas distintos según el tipo de token.
// - Fine-grained PAT suele ser `Bearer` (prefijo github_pat_)
// - Classic PAT suele ser `token` (prefijo ghp_)
function ghAuthHeaderValue(token) {
  if (!token) return null;
  const t = String(token).trim();
  if (!t) return null;
  return t.startsWith("github_pat_") ? `Bearer ${t}` : `token ${t}`;
}
function ghHeaders() {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const auth = ghAuthHeaderValue(GH_TOKEN);
  if (auth) h.Authorization = auth;
  return h;
}

// Cola global para serializar escrituras (evita 409 por SHA stale en GitHub Contents API)
let ghWriteQueue = Promise.resolve();
function ghEnqueueWrite(fn) {
  ghWriteQueue = ghWriteQueue.then(fn, fn);
  return ghWriteQueue;
}

async function ghError(res) {
  const text = await res.text();
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.message ? String(j.message) : text;
  } catch {
    // keep raw
  }
  const err = new Error(msg);
  err.status = res.status;
  err.raw = text;
  return err;
}

async function ghGetFile(path) {
  const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return { exists: false, sha: null, content: "" };
  if (!res.ok) throw await ghError(res);
  const j = await res.json();
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
    const err = await ghError(res);
    err.code = 409;
    throw err;
  }
  if (!res.ok) throw await ghError(res);
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
  return ghEnqueueWrite(async () => {
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
  });
}

function normPos(p) {
  const up = String(p || "").toUpperCase();
  if (up === "K" || up === "DST") return up;
  if (up === "QB" || up === "RB" || up === "WR" || up === "TE") return up;
  return up;
}

function normalizeRosterIds(roster) {
  const arr = Array.isArray(roster) ? roster : [];
  return arr
    .map((x) => {
      if (x == null) return null;
      if (typeof x === "string" || typeof x === "number") return String(x);
      if (typeof x === "object") {
        // compat con schema viejo: { type:"PLAYER", id:"5177", ... }
        if (x.id != null) return String(x.id);
        if (x.player_id != null) return String(x.player_id);
      }
      return null;
    })
    .filter(Boolean);
}

function build2026PickCatalog() {
  const out = [];
  for (let rnd = 1; rnd <= 6; rnd++) {
    for (let slot = 1; slot <= LEAGUE_SIZE; slot++) {
      const id = `2026-${rnd}.${String(slot).padStart(2, "0")}`;
      out.push({ id, label: `${rnd}.${String(slot).padStart(2, "0")} 2026` });
    }
  }
  return out;
}
function buildFuturePickCatalog(year) {
  const out = [];
  for (let rnd = 1; rnd <= 6; rnd++) {
    const suf =
      rnd === 1
        ? "1era"
        : rnd === 2
        ? "2da"
        : rnd === 3
        ? "3era"
        : rnd === 4
        ? "4ta"
        : rnd === 5
        ? "5ta"
        : "6ta";
    out.push({ id: `${year}-${rnd}`, label: `${suf} ${year}` });
  }
  return out;
}
function buildPickCatalog() {
  return [...build2026PickCatalog(), ...buildFuturePickCatalog(2027), ...buildFuturePickCatalog(2028)];
}

function cycleAvail(curr) {
  const i = AVAIL_CYCLE.indexOf(curr);
  return AVAIL_CYCLE[(i + 1) % AVAIL_CYCLE.length];
}

function playerAvatar(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] || "" : parts[0]?.[1] || "";
  return (a + b).toUpperCase();
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
      html, body { height: 100%; }
      body { margin: 0; background: ${COLORS.page}; color: ${COLORS.navy}; }
      * { box-sizing: border-box; }
      .ftbPage { min-height: 100vh; background: ${COLORS.page}; }
      .ftbContainer { max-width: 1180px; margin: 0 auto; padding: 18px 14px 94px; }
      .ftbTitle { margin: 6px 0 16px; letter-spacing: -0.02em; }
      .breakAnywhere { word-break: break-word; overflow-wrap: anywhere; }
      .grid2 { display: grid; grid-template-columns: 1fr; gap: 12px; }
      @media (min-width: 980px) { .grid2 { grid-template-columns: 1fr 1fr; } }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      .spacer { flex: 1 1 auto; }
      .topbar { position: sticky; top: 0; z-index: 50; background: ${COLORS.page}; border-bottom: 1px solid ${COLORS.border}; }
      .topbarInner { max-width: 1180px; margin: 0 auto; padding: 10px 14px; display:flex; align-items:center; gap:10px; }
      .chip { padding: 7px 10px; border-radius: 999px; border: 1px solid ${COLORS.border}; background: ${COLORS.sky}; color: ${COLORS.navy}; font-weight: 800; font-size: 12px; }
      .tabs { display:flex; gap:8px; flex-wrap: wrap; }
      .tabBtn { padding: 10px 12px; border-radius: 12px; border: 1px solid ${COLORS.border}; background: ${COLORS.sky}; color: ${COLORS.navy}; font-weight: 900; cursor:pointer; }
      .tabBtn.active { background: ${COLORS.blue}; border-color: transparent; color:#fff; }
      .dock { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; background: ${COLORS.page}; border-top: 1px solid ${COLORS.border}; }
      .dockInner { max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 10px 12px; }
      .dockBtn { border-radius: 14px; padding: 10px 10px; border: 1px solid transparent; background: transparent; color: ${COLORS.gray}; font-weight: 900; cursor: pointer; }
      .dockBtn.active { background: ${COLORS.sky}; border-color: ${COLORS.border}; color: ${COLORS.navy}; }
      .list { display: grid; gap: 10px; }
      .playerRow { display:flex; align-items:center; justify-content:space-between; gap:10px; padding: 10px 12px; border-radius: 14px; border:1px solid ${COLORS.border}; background: ${COLORS.soft}; }
      .avatar { width: 34px; height: 34px; border-radius: 999px; display:flex; align-items:center; justify-content:center; font-weight: 900; background: ${COLORS.sky}; border:1px solid ${COLORS.border}; }
      .muted { color: ${COLORS.gray}; }
      .slotGroup { border:1px solid ${COLORS.border}; background: ${COLORS.surface}; border-radius: 16px; padding: 12px; }
      .slotHead { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
      .slotTitle { font-weight: 1000; }
      .slotCount { color:${COLORS.gray}; font-weight: 900; font-size: 12px; }
      .seg { display:flex; gap:8px; flex-wrap:wrap; }
      .segBtn { padding: 8px 10px; border-radius: 999px; border:1px solid ${COLORS.border}; background: ${COLORS.sky}; font-weight: 900; cursor: pointer; }
      .segBtn.active { background: ${COLORS.blue}; color: #fff; border-color: transparent; }
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
        padding: 16,
        boxShadow: "var(--c-shadow)",
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
        maxWidth: "100%",
        display: "block",
        minWidth: 0,
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
  const bg = variant === "primary" ? COLORS.blue : variant === "danger" ? COLORS.danger : "transparent";
  const border = variant === "ghost" ? `1px solid ${COLORS.border}` : "1px solid transparent";
  const color = variant === "ghost" ? COLORS.navy : "#fff";
  return (
    <button
      className={className}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: "12px 14px",
        borderRadius: 14,
        border,
        background: bg,
        color,
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: 900,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function Pill({ children, tone = "neutral", style }) {
  const bg =
    tone === "good" ? "rgba(34,197,94,0.15)" : tone === "bad" ? "rgba(239,68,68,0.15)" : "rgba(59,130,246,0.12)";
  const bd =
    tone === "good" ? "rgba(34,197,94,0.35)" : tone === "bad" ? "rgba(239,68,68,0.35)" : "rgba(59,130,246,0.25)";
  const col = tone === "good" ? COLORS.success : tone === "bad" ? COLORS.danger : COLORS.blue;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 999,
        border: `1px solid ${bd}`,
        background: bg,
        color: col,
        fontWeight: 900,
        fontSize: 12,
        ...style,
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

  // nav
  const [tab, setTab] = useState(() => localStorage.getItem("ftb_tab") || "team"); // home|league|interests|team
  useEffect(() => localStorage.setItem("ftb_tab", tab), [tab]);

  // league data
  const [teams, setTeams] = useState([]);
  const [interests, setInterests] = useState([]);

  // players catalog (from /public/adp.json)
  const [players, setPlayers] = useState([]);
  const [playersLoading, setPlayersLoading] = useState(false);

  // my profile
  const [myDisplayName, setMyDisplayName] = useState("");
  const [myTeamName, setMyTeamName] = useState("");
  const [myStatus, setMyStatus] = useState("Contendiendo");
  const [saveInfo, setSaveInfo] = useState("");

  const picksCatalog = useMemo(() => buildPickCatalog(), []);

  const applyTheme = (t) => {
    setTheme(t);
    localStorage.setItem("ftb_theme", t);
    document.documentElement.dataset.theme = t;
    const vars = THEME_VARS[t] || THEME_VARS.dark;
    Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  };

  useEffect(() => {
    applyTheme(theme);
    if (!GH_OWNER || !GH_REPO) setBootError("Faltan VITE_GH_OWNER / VITE_GH_REPO (o hardcode en App.jsx).");
    if (!GH_TOKEN) setBootError("Falta VITE_GH_TOKEN. Sin token no podés guardar/leer en GitHub.");
  }, []);

  useEffect(() => {
    if (me) localStorage.setItem("ftb_session", JSON.stringify(me));
    else localStorage.removeItem("ftb_session");
  }, [me]);

  const playersById = useMemo(() => {
    const m = new Map();
    for (const p of players) m.set(String(p.player_id), p);
    return m;
  }, [players]);

  async function refreshData() {
    const [{ data: t }, { data: i }] = await Promise.all([ghGetJson(PATH_TEAMS, []), ghGetJson(PATH_INTERESTS, [])]);
    setTeams(Array.isArray(t) ? t : []);
    setInterests(Array.isArray(i) ? i : []);
  }

  async function loadPlayers() {
    setPlayersLoading(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL || "/"}adp.json`, { cache: "no-store" });
      const j = await res.json();
      setPlayers(Array.isArray(j?.players) ? j.players : []);
    } catch (e) {
      console.warn(e);
    } finally {
      setPlayersLoading(false);
    }
  }

  useEffect(() => {
    if (!me) return;
    (async () => {
      try {
        await Promise.all([refreshData(), loadPlayers()]);
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

  const myRow = useMemo(() => (me ? byUser.get(me.id) : null), [byUser, me?.id]);
  const myOutgoing = useMemo(() => (me ? interests.filter((x) => x.from_user_id === me.id) : []), [interests, me?.id]);
  const myIncoming = useMemo(() => (me ? interests.filter((x) => x.to_user_id === me.id) : []), [interests, me?.id]);

  function friendlyAuthError(e) {
    const status = e?.status;
    if (status === 401) return "GitHub 401: token inválido o revocado. Revisá VITE_GH_TOKEN.";
    if (status === 403) return "GitHub 403: sin permisos o rate limit. Chequeá permisos (Contents RW) y repo.";
    if (status === 404) return "GitHub 404: faltan /data/*.json (users/teams/interests).";
    return String(e?.message || e);
  }

  async function ensureTeamRow(userId, userEmail) {
    const next = await ghPutJsonWithRetry(
      PATH_TEAMS,
      (cur) => {
        const exists = cur.some((x) => x.user_id === userId);
        if (exists) return cur;
        return [
          ...cur,
          {
            user_id: userId,
            display_name: userEmail.split("@")[0],
            team_name: "",
            team_status: "Contendiendo",
            roster: [],
            picks: [],
            availability: {}, // key: PLAYER:<id> or PICK:<id>
            asset_values: {},
            updated_at: nowIso(),
          },
        ];
      },
      "ensure team row"
    );
    setTeams(next);
  }

  async function signup() {
    setAuthBusy(true);
    setAuthError("");
    try {
      if (!email.includes("@")) throw new Error("Email inválido.");
      if (pass.length < 4) throw new Error("Contraseña muy corta (mínimo 4).");
      if (pass !== pass2) throw new Error("Las contraseñas no coinciden.");

      const pwHash = await sha256Hex(pass);
      const userId = uid("user");

      await ghPutJsonWithRetry(
        PATH_USERS,
        (cur) => [
          ...cur,
          { id: userId, email: email.trim().toLowerCase(), pass_hash: pwHash, created_at: nowIso() },
        ],
        "create user"
      );

      await ensureTeamRow(userId, email.trim().toLowerCase());
      setMe({ id: userId, email: email.trim().toLowerCase() });
      setPass("");
      setPass2("");
    } catch (e) {
      setAuthError(friendlyAuthError(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function login() {
    setAuthBusy(true);
    setAuthError("");
    try {
      const em = email.trim().toLowerCase();
      if (!em.includes("@")) throw new Error("Email inválido.");

      const { data: users } = await ghGetJson(PATH_USERS, []);
      const u = (Array.isArray(users) ? users : []).find((x) => String(x.email).toLowerCase() === em);
      if (!u) throw new Error("Usuario no encontrado.");

      const pwHash = await sha256Hex(pass);
      if (String(u.pass_hash) !== pwHash) throw new Error("Contraseña incorrecta.");

      setMe({ id: u.id, email: u.email });
      setPass("");
      setPass2("");
      await ensureTeamRow(u.id, u.email);
    } catch (e) {
      setAuthError(friendlyAuthError(e));
    } finally {
      setAuthBusy(false);
    }
  }

  function logout() {
    setMe(null);
    setEmail("");
    setPass("");
    setPass2("");
    setTab("team");
  }

  async function saveMyProfile() {
    if (!me) return;
    setSaveInfo("Guardando...");
    try {
      const next = await ghPutJsonWithRetry(
        PATH_TEAMS,
        (cur) =>
          cur.map((t) =>
            t.user_id !== me.id
              ? t
              : { ...t, display_name: myDisplayName.trim(), team_name: myTeamName.trim(), team_status: myStatus, updated_at: nowIso() }
          ),
        "update profile"
      );
      setTeams(next);
      setSaveInfo("Guardado ✅");
      setTimeout(() => setSaveInfo(""), 1200);
    } catch (e) {
      setSaveInfo(friendlyAuthError(e));
    }
  }

  async function updateMyTeam(mutator, label) {
    if (!me) return;
    setSaveInfo("Guardando...");
    try {
      const next = await ghPutJsonWithRetry(
        PATH_TEAMS,
        (cur) => cur.map((t) => (t.user_id !== me.id ? t : mutator({ ...t, updated_at: nowIso() }))),
        label
      );
      setTeams(next);
      setSaveInfo("Guardado ✅");
      setTimeout(() => setSaveInfo(""), 800);
    } catch (e) {
      setSaveInfo(friendlyAuthError(e));
    }
  }

  async function setInterest(toUserId, assetType, assetId, level, note) {
    if (!me) return;
    const key = `${me.id}::${toUserId}::${assetType}::${assetId}`;
    const cleanNote = String(note || "").trim();

    const next = await ghPutJsonWithRetry(
      PATH_INTERESTS,
      (cur) => {
        const rest = cur.filter((x) => x.key !== key);
        if (level === "NONE") return rest;
        return [
          ...rest,
          { key, from_user_id: me.id, to_user_id: toUserId, asset_type: assetType, asset_id: assetId, level, note: cleanNote, updated_at: nowIso() },
        ];
      },
      "set interest"
    );
    setInterests(next);
  }

  /** ========= derived data ========= */
  const myRosterIds = useMemo(() => normalizeRosterIds(myRow?.roster), [myRow]);
  const myPicks = useMemo(() => (Array.isArray(myRow?.picks) ? myRow.picks.map(String) : []), [myRow]);
  const myAvail = useMemo(() => (myRow?.availability && typeof myRow.availability === "object" ? myRow.availability : {}), [myRow]);

  const rosterPlayers = useMemo(() => {
    return myRosterIds
      .map((id) => playersById.get(String(id)))
      .filter(Boolean)
      .map((p) => ({ ...p, player_id: String(p.player_id), position: normPos(p.position) }));
  }, [myRosterIds, playersById]);

  const slotAssignments = useMemo(() => {
    // greedy fill according to SLOT_LIMITS order
    const remaining = rosterPlayers.slice();
    const slots = {};
    for (const s of SLOT_LIMITS) slots[s.key] = [];

    const takeFirstMatching = (accepts) => {
      const idx = remaining.findIndex((p) => accepts.includes(normPos(p.position)));
      if (idx === -1) return null;
      const [p] = remaining.splice(idx, 1);
      return p;
    };

    // fill non-bench
    for (const s of SLOT_LIMITS.filter((x) => x.key !== "BENCH")) {
      while (slots[s.key].length < s.limit) {
        const p = takeFirstMatching(s.accepts);
        if (!p) break;
        slots[s.key].push(p);
      }
    }
    // rest to bench
    slots.BENCH = remaining.slice(0, SLOT_LIMITS.find((x) => x.key === "BENCH").limit);
    return slots;
  }, [rosterPlayers]);

  /** ========= early boot error ========= */
  if (bootError) {
    return (
      <div className="ftbPage">
        <GlobalStyles />
        <div className="ftbContainer">
          <h2 style={{ marginTop: 0 }}>Error</h2>
          <Card>
            <div style={{ color: COLORS.danger, fontWeight: 900, marginBottom: 10 }}>{bootError}</div>
            <div style={{ color: COLORS.gray, lineHeight: 1.5 }}>
              Checklist:
              <ul>
                <li>Definí VITE_GH_OWNER / VITE_GH_REPO / VITE_GH_BRANCH</li>
                <li>Definí VITE_GH_TOKEN con permisos de lectura/escritura de Contents</li>
                <li>
                  Existencia de <code>/data/users.json</code>, <code>/data/league_teams.json</code>, <code>/data/interests.json</code>
                </li>
              </ul>
            </div>
            <Button variant="ghost" onClick={() => setBootError("")}>Cerrar</Button>
          </Card>
        </div>
      </div>
    );
  }

  /** ========= main ========= */
  return (
    <div className="ftbPage">
      <GlobalStyles />
      <TopBar theme={theme} onTheme={applyTheme} me={me} onLogout={logout} />

      <div className="ftbContainer">
        <h1 className="ftbTitle">Fantasy Trade Board</h1>

        {!me ? (
          <Card>
            <div className="row">
              <h2 style={{ margin: 0 }}>{authMode === "login" ? "Iniciar sesión" : "Crear cuenta"}</h2>
              <div className="spacer" />
              <Button variant="ghost" onClick={() => { setAuthMode(authMode === "login" ? "signup" : "login"); setAuthError(""); }}>
                {authMode === "login" ? "Crear cuenta" : "Tengo cuenta"}
              </Button>
            </div>

            <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
              <Input value={email} onChange={setEmail} placeholder="email" />
              <Input value={pass} onChange={setPass} placeholder="contraseña" type="password" />
              {authMode === "signup" ? <Input value={pass2} onChange={setPass2} placeholder="repetir contraseña" type="password" /> : null}
              {authError ? <div style={{ color: COLORS.danger, fontWeight: 900 }}>{authError}</div> : null}
              <Button disabled={authBusy} onClick={authMode === "login" ? login : signup}>
                {authBusy ? "..." : authMode === "login" ? "Entrar" : "Crear"}
              </Button>
              <div className="muted" style={{ fontSize: 13 }}>Tip: si ves 401/403, el token de GitHub está mal o no tiene permiso.</div>
            </div>
          </Card>
        ) : (
          <>
            {/* Header de tu equipo / perfil */}
            <Card style={{ background: COLORS.sky }}>
              <div className="grid2" style={{ gap: 12, alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 1000, fontSize: 18 }}>{myDisplayName || me.email}</div>
                  <div className="muted" style={{ fontWeight: 900 }}>{myTeamName || "Sin nombre de equipo"}</div>
                  <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                    Formato: 1 QB · 2 RB · 1 WR · 1 TE · 3 FLEX · 21 BN · Picks 2026 (1.01-6.10) + rondas 2027/2028
                  </div>
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  <div className="row">
                    <Input value={myDisplayName} onChange={setMyDisplayName} placeholder="Tu nombre" />
                    <Input value={myTeamName} onChange={setMyTeamName} placeholder="Nombre del equipo" />
                    <select
                      value={myStatus}
                      onChange={(e) => setMyStatus(e.target.value)}
                      style={{
                        padding: "14px 14px",
                        minWidth: 220,
                        borderRadius: 14,
                        border: `1px solid ${COLORS.border}`,
                        background: COLORS.surface,
                        color: COLORS.navy,
                        fontWeight: 900,
                      }}
                    >
                      <option>Contendiendo</option>
                      <option>Reconstrucción</option>
                      <option>Re-tool</option>
                      <option>Tanqueando</option>
                    </select>
                  </div>
                  <div className="row">
                    <Button variant="primary" onClick={saveMyProfile}>Guardar perfil</Button>
                    {saveInfo ? <div className="muted" style={{ fontWeight: 900 }}>{saveInfo}</div> : null}
                    <div className="spacer" />
                    {playersLoading ? <Pill>cargando ADP…</Pill> : null}
                  </div>
                </div>
              </div>
            </Card>

            {/* Contenido por pestaña */}
            {tab === "home" ? (
              <HomeView myIncoming={myIncoming} myOutgoing={myOutgoing} byUser={byUser} playersById={playersById} picksCatalog={picksCatalog} />
            ) : tab === "league" ? (
              <LeagueView me={me} teams={teams} byUser={byUser} playersById={playersById} picksCatalog={picksCatalog} interests={interests} onSetInterest={setInterest} />
            ) : tab === "interests" ? (
              <InterestsView me={me} byUser={byUser} myOutgoing={myOutgoing} myIncoming={myIncoming} playersById={playersById} picksCatalog={picksCatalog} />
            ) : (
              <MyTeamView
                players={players}
                picksCatalog={picksCatalog}
                rosterIds={myRosterIds}
                picksOwned={myPicks}
                availability={myAvail}
                slotAssignments={slotAssignments}
                onAddPlayer={(pid) =>
                  updateMyTeam(
                    (t) => {
                      const next = normalizeRosterIds(t.roster);
                      if (next.includes(String(pid))) return t;
                      return { ...t, roster: [...next, String(pid)] };
                    },
                    "add player"
                  )
                }
                onRemovePlayer={(pid) =>
                  updateMyTeam(
                    (t) => {
                      const next = normalizeRosterIds(t.roster).filter((x) => x !== String(pid));
                      const avail = { ...(t.availability || {}) };
                      delete avail[`PLAYER:${String(pid)}`];
                      return { ...t, roster: next, availability: avail };
                    },
                    "remove player"
                  )
                }
                onTogglePlayerAvail={(pid) =>
                  updateMyTeam(
                    (t) => {
                      const avail = { ...(t.availability || {}) };
                      const k = `PLAYER:${String(pid)}`;
                      const curr = avail[k] || "AVAILABLE";
                      avail[k] = cycleAvail(curr);
                      return { ...t, availability: avail };
                    },
                    "toggle player availability"
                  )
                }
                onAddPick={(pickId) =>
                  updateMyTeam(
                    (t) => {
                      const next = Array.isArray(t.picks) ? t.picks.map(String) : [];
                      if (next.includes(String(pickId))) return t;
                      return { ...t, picks: [...next, String(pickId)] };
                    },
                    "add pick"
                  )
                }
                onRemovePick={(pickId) =>
                  updateMyTeam(
                    (t) => {
                      const next = (Array.isArray(t.picks) ? t.picks : []).map(String).filter((x) => x !== String(pickId));
                      const avail = { ...(t.availability || {}) };
                      delete avail[`PICK:${String(pickId)}`];
                      return { ...t, picks: next, availability: avail };
                    },
                    "remove pick"
                  )
                }
                onTogglePickAvail={(pickId) =>
                  updateMyTeam(
                    (t) => {
                      const avail = { ...(t.availability || {}) };
                      const k = `PICK:${String(pickId)}`;
                      const curr = avail[k] || "AVAILABLE";
                      avail[k] = cycleAvail(curr);
                      return { ...t, availability: avail };
                    },
                    "toggle pick availability"
                  )
                }
              />
            )}
          </>
        )}
      </div>

      {/* Dock */}
      {me ? (
        <div className="dock">
          <div className="dockInner">
            <button className={`dockBtn ${tab === "home" ? "active" : ""}`} onClick={() => setTab("home")}>Inicio</button>
            <button className={`dockBtn ${tab === "league" ? "active" : ""}`} onClick={() => setTab("league")}>Liga</button>
            <button className={`dockBtn ${tab === "interests" ? "active" : ""}`} onClick={() => setTab("interests")}>Intereses</button>
            <button className={`dockBtn ${tab === "team" ? "active" : ""}`} onClick={() => setTab("team")}>Mi equipo</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** ========= Views ========= */

function HomeView({ myIncoming, myOutgoing, byUser, playersById, picksCatalog }) {
  const pickLabel = useMemo(() => {
    const m = new Map();
    for (const p of picksCatalog) m.set(String(p.id), p.label);
    return m;
  }, [picksCatalog]);

  const fmtAsset = (row) => {
    if (row.asset_type === "PLAYER") {
      const p = playersById.get(String(row.asset_id));
      return p ? `${p.name} (${p.position} ${p.team})` : `Jugador ${row.asset_id}`;
    }
    return pickLabel.get(String(row.asset_id)) || `Pick ${row.asset_id}`;
  };

  return (
    <div style={{ marginTop: 12 }} className="grid2">
      <Card>
        <h3 style={{ marginTop: 0 }}>Outgoing (lo que me interesa)</h3>
        {myOutgoing.length === 0 ? (
          <div className="muted">Todavía no marcaste intereses.</div>
        ) : (
          <div className="list">
            {myOutgoing
              .slice()
              .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
              .map((r) => {
                const to = byUser.get(r.to_user_id);
                return (
                  <div key={r.key} className="playerRow">
                    <div style={{ display: "grid", gap: 4 }}>
                      <div style={{ fontWeight: 1000 }}>{fmtAsset(r)}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Dueño: {to?.display_name || r.to_user_id} {to?.team_name ? `— ${to.team_name}` : ""}
                      </div>
                    </div>
                    <Pill tone={r.level === "HIGH" ? "good" : "neutral"}>{INTEREST_LABEL[r.level] || r.level}</Pill>
                  </div>
                );
              })}
          </div>
        )}
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>Incoming (a mí)</h3>
        {myIncoming.length === 0 ? (
          <div className="muted">Nadie marcó interés por tus assets (todavía).</div>
        ) : (
          <div className="list">
            {myIncoming
              .slice()
              .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
              .map((r) => {
                const from = byUser.get(r.from_user_id);
                return (
                  <div key={r.key} className="playerRow">
                    <div style={{ display: "grid", gap: 4 }}>
                      <div style={{ fontWeight: 1000 }}>{fmtAsset(r)}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Interesado: {from?.display_name || r.from_user_id} {from?.team_name ? `— ${from.team_name}` : ""}
                      </div>
                    </div>
                    <Pill tone={r.level === "HIGH" ? "good" : "neutral"}>{INTEREST_LABEL[r.level] || r.level}</Pill>
                  </div>
                );
              })}
          </div>
        )}
      </Card>
    </div>
  );
}

function MyTeamView({
  players,
  picksCatalog,
  rosterIds,
  picksOwned,
  availability,
  slotAssignments,
  onAddPlayer,
  onRemovePlayer,
  onTogglePlayerAvail,
  onAddPick,
  onRemovePick,
  onTogglePickAvail,
}) {
  const [mode, setMode] = useState("players"); // players | picks
  const [q, setQ] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");

  const pickLabel = useMemo(() => {
    const m = new Map();
    for (const p of picksCatalog) m.set(String(p.id), p.label);
    return m;
  }, [picksCatalog]);

  const filteredPlayers = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return (players || [])
      .filter((p) => {
        const pos = normPos(p.position);
        if (posFilter !== "ALL" && pos !== posFilter) return false;
        if (!qq) return true;
        return String(p.name || "").toLowerCase().includes(qq);
      })
      .slice(0, 250);
  }, [players, q, posFilter]);

  const ownedSet = useMemo(() => new Set(rosterIds.map(String)), [rosterIds]);
  const ownedPicksSet = useMemo(() => new Set(picksOwned.map(String)), [picksOwned]);

  return (
    <div style={{ marginTop: 12 }}>
      <Card style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Mi equipo</h2>
          <div className="muted" style={{ fontWeight: 900 }}>
            Tocá el botón de estado: Disponible → En escucha → No disponible
          </div>
          <div className="spacer" />
          <div className="tabs">
            <button className={`tabBtn ${mode === "players" ? "active" : ""}`} onClick={() => setMode("players")}>Jugadores</button>
            <button className={`tabBtn ${mode === "picks" ? "active" : ""}`} onClick={() => setMode("picks")}>Picks</button>
          </div>
        </div>
      </Card>

      <div className="grid2">
        <Card>
          {mode === "players" ? (
            <>
              <div style={{ display: "grid", gap: 10 }}>
                <Input value={q} onChange={setQ} placeholder="Buscar jugador por nombre..." />
                <div className="seg">
                  {["ALL", "QB", "RB", "WR", "TE"].map((p) => (
                    <button key={p} className={`segBtn ${posFilter === p ? "active" : ""}`} onClick={() => setPosFilter(p)}>
                      {p === "ALL" ? "Todos" : p}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 12 }} className="list">
                {filteredPlayers.map((p) => {
                  const pid = String(p.player_id);
                  const added = ownedSet.has(pid);
                  return (
                    <div key={pid} className="playerRow">
                      <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                        <div className="avatar">{playerAvatar(p.name)}</div>
                        <div style={{ minWidth: 0 }}>
                          <div className="breakAnywhere" style={{ fontWeight: 1000 }}>{p.name}</div>
                          <div className="muted" style={{ fontSize: 12, fontWeight: 900 }}>
                            {normPos(p.position)} · {p.team || "-"} · ADP {p.adp_formatted || "-"}
                          </div>
                        </div>
                      </div>
                      <div>
                        <Button variant={added ? "ghost" : "primary"} onClick={() => (added ? null : onAddPlayer(pid))} disabled={added} style={{ padding: "10px 12px" }}>
                          {added ? "Agregado" : "+ Agregar"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="muted" style={{ fontWeight: 900, marginBottom: 10 }}>
                Agregá tus picks. 2026 está en formato 1.01-6.10. 2027/2028 por rondas (1era…6ta).
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) onAddPick(v);
                    e.target.value = "";
                  }}
                  style={{
                    padding: "14px 14px",
                    borderRadius: 14,
                    border: `1px solid ${COLORS.border}`,
                    background: COLORS.sky,
                    color: COLORS.navy,
                    fontWeight: 900,
                  }}
                >
                  <option value="">+ Agregar pick…</option>
                  {picksCatalog.filter((p) => !ownedPicksSet.has(String(p.id))).map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
            </>
          )}
        </Card>

        <Card>
          {mode === "players" ? (
            <>
              <h3 style={{ marginTop: 0 }}>Mi equipo (slots)</h3>
              <div className="muted" style={{ fontSize: 13, fontWeight: 900 }}>
                Se asigna automático por posición (QB/RB/WR/TE → FLEX → BN).
              </div>

              <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                {SLOT_LIMITS.map((s) => {
                  const list = slotAssignments[s.key] || [];
                  return (
                    <div key={s.key} className="slotGroup">
                      <div className="slotHead">
                        <div className="slotTitle">{s.label}</div>
                        <div className="slotCount">{list.length}/{s.limit}</div>
                      </div>

                      <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                        {list.length === 0 ? <div className="muted">—</div> : null}
                        {list.map((p) => {
                          const pid = String(p.player_id);
                          const k = `PLAYER:${pid}`;
                          const avail = availability[k] || "AVAILABLE";
                          return (
                            <div key={pid} className="playerRow">
                              <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                                <div className="avatar">{playerAvatar(p.name)}</div>
                                <div style={{ minWidth: 0 }}>
                                  <div className="breakAnywhere" style={{ fontWeight: 1000 }}>{p.name}</div>
                                  <div className="muted" style={{ fontSize: 12, fontWeight: 900 }}>
                                    {normPos(p.position)} · {p.team || "-"}
                                  </div>
                                </div>
                              </div>

                              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                <Button variant="ghost" onClick={() => onTogglePlayerAvail(pid)} style={{ padding: "10px 12px" }}>
                                  <Pill tone={AVAIL_TONE[avail] || "neutral"}>{AVAIL_LABEL[avail] || avail}</Pill>
                                </Button>
                                <Button variant="danger" onClick={() => onRemovePlayer(pid)} style={{ padding: "10px 12px" }}>✕</Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <h3 style={{ marginTop: 0 }}>Mis picks</h3>
              <div className="list">
                {picksOwned.length === 0 ? <div className="muted">No agregaste picks todavía.</div> : null}
                {picksOwned.slice().map(String).sort().map((pid) => {
                  const k = `PICK:${pid}`;
                  const avail = availability[k] || "AVAILABLE";
                  return (
                    <div key={pid} className="playerRow">
                      <div style={{ display: "grid", gap: 4 }}>
                        <div style={{ fontWeight: 1000 }}>{pickLabel.get(pid) || pid}</div>
                        <div className="muted" style={{ fontSize: 12, fontWeight: 900 }}>{pid}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <Button variant="ghost" onClick={() => onTogglePickAvail(pid)} style={{ padding: "10px 12px" }}>
                          <Pill tone={AVAIL_TONE[avail] || "neutral"}>{AVAIL_LABEL[avail] || avail}</Pill>
                        </Button>
                        <Button variant="danger" onClick={() => onRemovePick(pid)} style={{ padding: "10px 12px" }}>✕</Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function LeagueView({ me, teams, byUser, playersById, picksCatalog, interests, onSetInterest }) {
  const [selectedUserId, setSelectedUserId] = useState("");
  const otherTeams = useMemo(() => teams.filter((t) => t.user_id !== me.id), [teams, me.id]);

  useEffect(() => {
    if (!selectedUserId && otherTeams.length) setSelectedUserId(otherTeams[0].user_id);
  }, [otherTeams.length]);

  const selected = byUser.get(selectedUserId);

  const pickLabel = useMemo(() => {
    const m = new Map();
    for (const p of picksCatalog) m.set(String(p.id), p.label);
    return m;
  }, [picksCatalog]);

  const selectedRoster = useMemo(() => {
    const ids = normalizeRosterIds(selected?.roster);
    return ids.map((id) => playersById.get(id)).filter(Boolean);
  }, [selected?.roster, playersById]);

  const selectedPicks = useMemo(() => (Array.isArray(selected?.picks) ? selected.picks.map(String) : []), [selected?.picks]);

  return (
    <div style={{ marginTop: 12 }}>
      <Card style={{ background: COLORS.sky }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>Liga</h2>
          <div className="spacer" />
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            style={{ padding: "12px 12px", minWidth: 260, borderRadius: 14, border: `1px solid ${COLORS.border}`, background: COLORS.surface, color: COLORS.navy, fontWeight: 900 }}
          >
            {otherTeams.map((t) => (
              <option key={t.user_id} value={t.user_id}>
                {(t.display_name || t.user_id).slice(0, 30)} {t.team_name ? `— ${t.team_name}` : ""}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {!selected ? (
        <div style={{ marginTop: 12 }} className="muted">No hay otro equipo seleccionado.</div>
      ) : (
        <div style={{ marginTop: 12 }} className="grid2">
          <Card>
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 18, fontWeight: 1000 }}>
                {selected.display_name} {selected.team_name ? `— ${selected.team_name}` : ""}
              </div>
              <Pill>{selected.team_status || "—"}</Pill>
            </div>

            <div style={{ marginTop: 14 }}>
              <h3 style={{ marginTop: 0 }}>Jugadores</h3>
              <div className="muted" style={{ fontSize: 13, fontWeight: 900 }}>
                Marcá tu interés: Bajo / Medio / Alto (clic para activar, clic otra vez para borrar).
              </div>

              <div style={{ marginTop: 12 }} className="list">
                {selectedRoster.length === 0 ? <div className="muted">Sin roster cargado.</div> : null}
                {selectedRoster.map((p) => {
                  const pid = String(p.player_id);
                  const current = interests.find(
                    (x) => x.from_user_id === me.id && x.to_user_id === selected.user_id && x.asset_type === "PLAYER" && String(x.asset_id) === pid
                  );
                  return (
                    <InterestAssetRow
                      key={pid}
                      title={`${p.name}`}
                      subtitle={`${normPos(p.position)} · ${p.team || "-"}`}
                      current={current}
                      onSet={(level) => onSetInterest(selected.user_id, "PLAYER", pid, level, "")}
                    />
                  );
                })}
              </div>
            </div>
          </Card>

          <Card>
            <h3 style={{ marginTop: 0 }}>Picks</h3>
            <div style={{ marginTop: 12 }} className="list">
              {selectedPicks.length === 0 ? <div className="muted">Sin picks cargados.</div> : null}
              {selectedPicks.slice().sort().map((pid) => {
                const current = interests.find(
                  (x) => x.from_user_id === me.id && x.to_user_id === selected.user_id && x.asset_type === "PICK" && String(x.asset_id) === String(pid)
                );
                return (
                  <InterestAssetRow
                    key={pid}
                    title={pickLabel.get(String(pid)) || String(pid)}
                    subtitle={String(pid)}
                    current={current}
                    onSet={(level) => onSetInterest(selected.user_id, "PICK", String(pid), level, "")}
                  />
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function InterestsView({ me, byUser, myOutgoing, myIncoming, playersById, picksCatalog }) {
  const pickLabel = useMemo(() => {
    const m = new Map();
    for (const p of picksCatalog) m.set(String(p.id), p.label);
    return m;
  }, [picksCatalog]);

  const fmtAsset = (row) => {
    if (row.asset_type === "PLAYER") {
      const p = playersById.get(String(row.asset_id));
      return p ? `${p.name} (${p.position} ${p.team})` : `Jugador ${row.asset_id}`;
    }
    return pickLabel.get(String(row.asset_id)) || `Pick ${row.asset_id}`;
  };

  return (
    <div style={{ marginTop: 12 }} className="grid2">
      <Card>
        <h2 style={{ marginTop: 0 }}>Lo que me interesa</h2>
        {myOutgoing.length === 0 ? (
          <div className="muted">No marcaste intereses todavía.</div>
        ) : (
          <div className="list">
            {myOutgoing.slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).map((r) => {
              const owner = byUser.get(r.to_user_id);
              return (
                <div key={r.key} className="playerRow">
                  <div style={{ display: "grid", gap: 4 }}>
                    <div style={{ fontWeight: 1000 }}>{fmtAsset(r)}</div>
                    <div className="muted" style={{ fontSize: 12, fontWeight: 900 }}>
                      Dueño: {owner?.display_name || r.to_user_id} {owner?.team_name ? `— ${owner.team_name}` : ""}
                    </div>
                  </div>
                  <Pill tone={r.level === "HIGH" ? "good" : "neutral"}>{INTEREST_LABEL[r.level] || r.level}</Pill>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <h2 style={{ marginTop: 0 }}>Otros interesados en mi equipo</h2>
        {myIncoming.length === 0 ? (
          <div className="muted">Todavía nadie marcó interés por tus assets.</div>
        ) : (
          <div className="list">
            {myIncoming.slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).map((r) => {
              const who = byUser.get(r.from_user_id);
              return (
                <div key={r.key} className="playerRow">
                  <div style={{ display: "grid", gap: 4 }}>
                    <div style={{ fontWeight: 1000 }}>{fmtAsset(r)}</div>
                    <div className="muted" style={{ fontSize: 12, fontWeight: 900 }}>
                      Interesado: {who?.display_name || r.from_user_id} {who?.team_name ? `— ${who.team_name}` : ""}
                    </div>
                  </div>
                  <Pill tone={r.level === "HIGH" ? "good" : "neutral"}>{INTEREST_LABEL[r.level] || r.level}</Pill>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

/** ========= Small UI pieces ========= */

function InterestAssetRow({ title, subtitle, current, onSet }) {
  const level = current?.level || "NONE";
  return (
    <div className="playerRow">
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <div className="breakAnywhere" style={{ fontWeight: 1000 }}>{title}</div>
        <div className="muted" style={{ fontSize: 12, fontWeight: 900 }}>{subtitle}</div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {INTEREST_LEVELS.map((l) => (
          <Button
            key={l}
            variant={level === l ? "primary" : "ghost"}
            onClick={() => onSet(level === l ? "NONE" : l)}
            style={{ padding: "10px 12px" }}
          >
            {INTEREST_LABEL[l]}
          </Button>
        ))}
      </div>
    </div>
  );
}

function TopBar({ theme, onTheme, me, onLogout }) {
  return (
    <div className="topbar">
      <div className="topbarInner">
        <div style={{ fontWeight: 1000 }}>Fantasy Trade Board</div>
        <div className="spacer" />
        <button className="chip" onClick={() => onTheme(theme === "dark" ? "light" : "dark")} title="Cambiar tema">
          {theme === "dark" ? "🌙 Dark" : "☀️ Light"}
        </button>
        {me ? (
          <>
            <div className="chip breakAnywhere">{me.email}</div>
            <button className="chip" onClick={onLogout} title="Cerrar sesión">Salir</button>
          </>
        ) : null}
      </div>
    </div>
  );
}
