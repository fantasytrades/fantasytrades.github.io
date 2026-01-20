import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

/** ========= THEME ========= */
// Usamos CSS variables para poder alternar Light/Dark sin reescribir todos los estilos inline.
// NOTA: mantenemos las mismas keys (white/sky/navy/etc.) para no tocar todo el archivo.
const COLORS = {
  // Page background (antes era "white" en varios lugares)
  page: "var(--c-page)",
  // Surface / cards / inputs
  white: "var(--c-surface)",
  sky: "var(--c-sky)",
  blue: "var(--c-blue)",
  navy: "var(--c-navy)",
  gray: "var(--c-gray)",
  border: "var(--c-border)",
  soft: "var(--c-soft)",
  danger: "var(--c-danger)",
  success: "var(--c-success)",
  warn: "var(--c-warn)",
  topbar: "var(--c-topbar)",
};

const THEME_VARS = {
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
    "--c-warn": "#F59E0B",
    "--c-topbar": "rgba(255,255,255,0.9)",
  },
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
    "--c-warn": "#F59E0B",
    "--c-topbar": "rgba(15,23,42,0.82)",
  },
};

const POS_COLORS = {
  QB: "#F43F5E", // rojo
  RB: "#10B981", // verde
  WR: "#60A5FA", // azul
  TE: "#F59E0B", // naranja
  BENCH: "#9CA3AF", // gris
};

function flexGradient() {
  return `linear-gradient(90deg, ${POS_COLORS.RB} 0%, ${POS_COLORS.WR} 50%, ${POS_COLORS.TE} 100%)`;
}

// Responsive helper
function useMedia(query) {
  const get = () => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(query);
    const handler = () => setMatches(mq.matches);
    handler();
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else mq.removeListener(handler);
    };
  }, [query]);

  return matches;
}

function PosChip({ pos, size = "sm", forceFlex = false }) {
  const p = (pos || "").toUpperCase();
  const isFlex = forceFlex || p === "FLEX" || p === "WRT";
  const isBench = p === "BENCH" || p === "BN";

  const styleBase = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    fontWeight: 900,
    color: "white",
    border: `1px solid ${COLORS.border}`,
    whiteSpace: "nowrap",
  };

  const dims =
    size === "lg"
      ? { padding: "8px 12px", fontSize: 12 }
      : size === "md"
      ? { padding: "6px 10px", fontSize: 12 }
      : { padding: "4px 8px", fontSize: 11 };

  let background = POS_COLORS[p] || COLORS.gray;
  if (isBench) background = POS_COLORS.BENCH;
  if (isFlex) background = flexGradient();

  return (
    <span style={{ ...styleBase, ...dims, background }} title={isFlex ? "FLEX" : isBench ? "BENCH" : p}>
      {isFlex ? "FLEX" : isBench ? "BN" : p}
    </span>
  );
}

/** ========= SLEEPER (players) ========= */
const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";
const PLAYERS_CACHE_KEY = "ftb_sleeper_players_cache_v1";
const PLAYERS_CACHE_TS_KEY = "ftb_sleeper_players_cache_ts_v1";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** ========= ADP (ranking) ========= */
const ADP_SCORING = "ppr";
const ADP_TEAMS = 10;

/** ========= ROSTER SLOTS ========= */
const ROSTER_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 3, BENCH: 21 };
const FLEX_POS = new Set(["RB", "WR", "TE"]);

/** ========= Limits ========= */
const MAX_ROSTER_PLAYERS = 30;

/** ========= Supabase tables ========= */
const USER_STATE_TABLE = "user_state";
const LEAGUE_TEAMS_TABLE = "league_teams";
const LEAGUE_INTERESTS_TABLE = "league_interests";

/** ========= LOCAL KEYS ========= */
const LS_KEYS = {
  roster: "ftb_my_roster",
  statuses: "ftb_my_status_overrides",
  interests: "ftb_interests", // legacy (ya no se usa, pero lo dejamos)
  teamStatus: "ftb_my_team_status",
  teamName: "ftb_my_team_name",
  displayName: "ftb_my_display_name",
  assetValues: "ftb_my_asset_values",
  theme: "ftb_theme",
};

/** ========= HEADSHOTS (Sleeper CDN) ========= */
function sleeperHeadshotUrl(playerId) {
  return `https://sleepercdn.com/content/nfl/players/thumb/${playerId}.jpg`;
}
function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "?";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] : "";
  return (a + b).toUpperCase();
}
function Headshot({ id, name, size = 38 }) {
  const [broken, setBroken] = useState(false);

  if (broken || !id) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 999,
          background: COLORS.soft,
          border: `1px solid ${COLORS.border}`,
          display: "grid",
          placeItems: "center",
          fontWeight: 900,
          color: COLORS.gray,
          fontSize: 12,
          flex: "0 0 auto",
        }}
        title={name}
      >
        {initials(name)}
      </div>
    );
  }

  return (
    <img
      src={sleeperHeadshotUrl(id)}
      alt={name}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBroken(true)}
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        objectFit: "cover",
        border: `1px solid ${COLORS.border}`,
        background: COLORS.soft,
        flex: "0 0 auto",
      }}
    />
  );
}

/** ========= HELPERS ========= */
function normalize(s) {
  return (s || "").
  toLowerCase().trim();
}
function cleanText(v) {
  return (v ?? "").toString().trim();
}
function safeTeamName(v) {
  return cleanText(v) || "Sin nombre de equipo";
}
function safeDisplayName(v, fallback) {
  return cleanText(v) || fallback;
}
function normalizeKey(str) {
  return normalize(str).replace(/\./g, "").replace(/'/g, "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}
function playerKey({ name, pos }) {
  return `${normalizeKey(name)}|${(pos || "").toUpperCase()}`;
}
function buildPlayerName(p) {
  const fn = (p.first_name || "").trim();
  const ln = (p.last_name || "").trim();
  const full = `${fn} ${ln}`.trim();
  return full || p.full_name || p.search_full_name || p.player_id || "Unknown";
}
function normalizeSleeperPlayers(rawObj) {
  const arr = [];
  for (const id in rawObj) {
    const p = rawObj[id];
    if (!p) continue;
    const pos = p.position;
    if (!["QB", "RB", "WR", "TE"].includes(pos)) continue;
    arr.push({
      id: String(p.player_id || id),
      name: buildPlayerName(p),
      pos,
      nfl: p.team || "",
      status: p.status || "",
    });
  }
  return arr; // IMPORTANT: no ordenar acá
}

function statusLabel(s) {
  if (s === "AVAILABLE") return "Disponible";
  if (s === "LISTENING") return "En escucha";
  return "No disponible";
}
function nextStatus(current) {
  if (current === "NOT_AVAILABLE") return "LISTENING";
  if (current === "LISTENING") return "AVAILABLE";
  return "NOT_AVAILABLE";
}
function statusBadgeStyle(status) {
  if (status === "AVAILABLE") return { background: COLORS.success, color: "white", border: "none" };
  if (status === "LISTENING") return { background: COLORS.warn, color: "white", border: "none" };
  return { background: COLORS.danger, color: "white", border: "none" };
}

/** ========= Intereses ========= */
function interestLabel(lvl) {
  if (lvl === "LOW") return "Bajo";
  if (lvl === "MEDIUM") return "Medio";
  return "Alto";
}
function interestColor(level) {
  if (level === "LOW") return COLORS.danger;
  if (level === "MEDIUM") return COLORS.warn;
  return COLORS.danger;
}
function interestButtonStyle(isActive, level) {
  const bg = isActive ? interestColor(level) : COLORS.sky;
  const fg = isActive ? "white" : COLORS.navy;
  return {
    border: `1px solid ${COLORS.border}`,
    cursor: "pointer",
    outline: "none",
    boxShadow: "none",
    WebkitTapHighlightColor: "transparent",
    borderRadius: 10,
    padding: "6px 8px",
    fontSize: 12,
    fontWeight: 900,
    background: bg,
    color: fg,
  };
}
function interestBadgeStyle(level) {
  return {
    fontSize: 12,
    borderRadius: 999,
    padding: "6px 10px",
    fontWeight: 900,
    border: "none",
    background: interestColor(level),
    color: "white",
  };
}

/** ========= ADP fetch ========= */
async function fetchAdpWithFallback() {
  const url = `${import.meta.env.BASE_URL}adp.json`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`ADP local error ${res.status}`);

  const payload = await res.json();
  if (!payload?.players || !Array.isArray(payload.players)) throw new Error("ADP payload inválido");

  return { year: payload?.meta?.year ?? new Date().getFullYear(), players: payload.players };
}


/** ========= ROSTER VIEW (slots) ========= */
function sortByRankAsc(a, b) {
  const ra = Number.isFinite(a?._rank) ? a._rank : 999999;
  const rb = Number.isFinite(b?._rank) ? b._rank : 999999;
  return ra - rb;
}
function buildRosterView(players) {
  const pool = [...players].sort(sortByRankAsc);

  const qb = [];
  const rb = [];
  const wr = [];
  const te = [];
  const flex = [];
  const bench = [];

  for (const p of pool) {
    if (p.pos === "QB" && qb.length < ROSTER_SLOTS.QB) qb.push(p);
    else if (p.pos === "RB" && rb.length < ROSTER_SLOTS.RB) rb.push(p);
    else if (p.pos === "WR" && wr.length < ROSTER_SLOTS.WR) wr.push(p);
    else if (p.pos === "TE" && te.length < ROSTER_SLOTS.TE) te.push(p);
  }

  const used = new Set([...qb, ...rb, ...wr, ...te].map((x) => x.id));
  const leftovers = pool.filter((p) => !used.has(p.id));

  for (const p of leftovers) {
    if (flex.length < ROSTER_SLOTS.FLEX && FLEX_POS.has(p.pos)) flex.push(p);
    else bench.push(p);
  }

  return { qb, rb, wr, te, flex, bench: bench.slice(0, ROSTER_SLOTS.BENCH) };
}

function slotChipStyle(tag) {
  const base = {
    minWidth: 52,
    height: 40,
    borderRadius: 12,
    display: "grid",
    placeItems: "center",
    fontWeight: 900,
    fontSize: 12,
    border: `1px solid ${COLORS.border}`,
    flex: "0 0 auto",
    color: "white",
  };

  if (tag === "QB") return { ...base, background: POS_COLORS.QB };
  if (tag === "RB") return { ...base, background: POS_COLORS.RB };
  if (tag === "WR") return { ...base, background: POS_COLORS.WR };
  if (tag === "TE") return { ...base, background: POS_COLORS.TE };
  if (tag === "WRT" || tag === "FLEX") return { ...base, background: flexGradient(), color: "white" };
  if (tag === "BN" || tag === "BENCH") return { ...base, background: POS_COLORS.BENCH, color: "white" };
  return { ...base, background: COLORS.gray };
}

/** ========= Auth UI ========= */
function AuthPanel({ user }) {
  const [mode, setMode] = useState("login"); // login | signup
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const passwordsMatch = mode === "login" || pass === pass2;

  async function signIn() {
    setMsg("");
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    setLoading(false);
    setMsg(error ? error.message : "Sesión iniciada.");
  }

  async function signUp() {
    setMsg("");
    if (pass !== pass2) {
      setMsg("Las contraseñas no coinciden.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signUp({ email, password: pass });
    setLoading(false);
    setMsg(error ? error.message : "Cuenta creada. Si Supabase exige confirmación, revisá tu email.");
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  if (user) {
    return (
      <Card bg={COLORS.sky}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 900 }}>Sesión iniciada</div>
            <div style={{ fontSize: 13, color: COLORS.gray }}>{user.email}</div>
          </div>
          <button
            onClick={signOut}
            style={{
              border: `1px solid ${COLORS.border}`,
              background: COLORS.white,
              borderRadius: 12,
              padding: "10px 12px",
              cursor: "pointer",
              fontWeight: 900,
              color: COLORS.danger,
            }}
          >
            Cerrar sesión
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card bg={COLORS.sky}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div style={{ fontWeight: 900 }}>{mode === "login" ? "Entrar" : "Crear cuenta"}</div>
        <button
          onClick={() => {
            setMsg("");
            setPass2("");
            setMode((m) => (m === "login" ? "signup" : "login"));
          }}
          style={{
            border: `1px solid ${COLORS.border}`,
            background: COLORS.white,
            borderRadius: 12,
            padding: "8px 10px",
            cursor: "pointer",
            fontWeight: 900,
            color: COLORS.blue,
          }}
        >
          {mode === "login" ? "Crear cuenta" : "Tengo cuenta"}
        </button>
      </div>

      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email"
          style={{
            border: `1px solid ${COLORS.border}`,
            background: COLORS.white,
            color: COLORS.navy,
            borderRadius: 12,
            padding: "10px 12px",
            outline: "none",
          }}
        />
        <input
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="contraseña"
          type="password"
          style={{
            border: `1px solid ${COLORS.border}`,
            background: COLORS.white,
            color: COLORS.navy,
            borderRadius: 12,
            padding: "10px 12px",
            outline: "none",
          }}
        />

        {mode === "signup" && (
          <input
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
            placeholder="repetir contraseña"
            type="password"
            style={{
              border: `1px solid ${COLORS.border}`,
              background: COLORS.white,
              color: COLORS.navy,
              borderRadius: 12,
              padding: "10px 12px",
              outline: "none",
            }}
          />
        )}

        {mode === "signup" && pass2 && pass !== pass2 && (
          <div style={{ fontSize: 12, color: COLORS.danger, fontWeight: 900 }}>Las contraseñas no coinciden</div>
        )}

        <button
          disabled={loading || !email.includes("@") || pass.length < 6 || (mode === "signup" && !passwordsMatch)}
          onClick={mode === "login" ? signIn : signUp}
          style={{
            border: "none",
            borderRadius: 12,
            padding: "10px 12px",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 900,
            background: COLORS.blue,
            color: "white",
            opacity: loading || !email.includes("@") || pass.length < 6 || (mode === "signup" && !passwordsMatch) ? 0.6 : 1,
          }}
        >
          {loading ? "Cargando…" : mode === "login" ? "Entrar" : "Crear cuenta"}
        </button>

        <div style={{ fontSize: 12, color: COLORS.gray, fontWeight: 800 }}>La contraseña debe tener al menos 6 caracteres.</div>

        {msg ? <div style={{ fontSize: 13, fontWeight: 900, color: COLORS.gray }}>{msg}</div> : null}
      </div>
    </Card>
  );
}

/** ========= MAIN APP ========= */
export default function App() {
  /** ---- Theme (Light/Dark) ---- */
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(LS_KEYS.theme) || "light";
    } catch {
      return "light";
    }
  });
  const themeVars = theme === "dark" ? THEME_VARS.dark : THEME_VARS.light;

  // Breakpoints
  const isPhone = useMedia("(max-width: 480px)");
  const isMobile = useMedia("(max-width: 860px)");
  const isTablet = useMedia("(max-width: 1100px)");
  const isWide = useMedia("(min-width: 1400px)");
  const containerMax = isWide ? 1400 : 1200;

  // Layout: full-width (sin "maxWidth" fijo) para ocupar todo el monitor.
  const padX = isPhone ? 12 : isMobile ? 14 : 16;
  const contentPadBottom = isPhone ? 110 : 88;

  /** ---- Global page styles (override Vite default dark bg / centered root) ---- */
  useEffect(() => {
    if (typeof document === "undefined") return;

    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");

    const prev = {
      htmlBg: html.style.background,
      bodyBg: body.style.background,
      bodyMargin: body.style.margin,
      bodyDisplay: body.style.display,
      bodyPlaceItems: body.style.placeItems,
      bodyMinH: body.style.minHeight,
      bodyWidth: body.style.width,
      rootMaxW: root?.style.maxWidth || "",
      rootW: root?.style.width || "",
      rootMargin: root?.style.margin || "",
      rootPadding: root?.style.padding || "",
    };

    // Aplicar variables del tema en :root para que funcionen también fuera del contenedor React.
    Object.entries(themeVars).forEach(([k, v]) => {
      html.style.setProperty(k, v);
    });
    html.style.colorScheme = theme === "dark" ? "dark" : "light";

    // Fondo global (evita el "fondo negro/gris" cuando hay espacio a los costados)
    html.style.background = themeVars["--c-page"];
    body.style.background = themeVars["--c-page"];
    body.style.margin = "0";
    body.style.display = "block";
    body.style.placeItems = "initial";
    body.style.minHeight = "100vh";
    body.style.width = "100%";

    if (root) {
      root.style.maxWidth = "none";
      root.style.width = "100%";
      root.style.margin = "0";
      root.style.padding = "0";
    }

    return () => {
      html.style.background = prev.htmlBg;
      body.style.background = prev.bodyBg;
      body.style.margin = prev.bodyMargin;
      body.style.display = prev.bodyDisplay;
      body.style.placeItems = prev.bodyPlaceItems;
      body.style.minHeight = prev.bodyMinH;
      body.style.width = prev.bodyWidth;
      if (root) {
        root.style.maxWidth = prev.rootMaxW;
        root.style.width = prev.rootW;
        root.style.margin = prev.rootMargin;
        root.style.padding = prev.rootPadding;
      }
    };
  }, [theme, themeVars]);

  // Persistencia local del tema
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEYS.theme, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  /** ---- Auth session ---- */
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user || null);
      setAuthReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  /** ---- UI tabs ---- */
  const tabs = ["Inicio", "Liga", "Intereses", "Mi equipo"];
  const [tab, setTab] = useState("Mi equipo");

  /** ---- Perfil editable ---- */
  const [myDisplayName, setMyDisplayName] = useState(() => localStorage.getItem(LS_KEYS.displayName) || "");
  const [myTeamName, setMyTeamName] = useState(() => localStorage.getItem(LS_KEYS.teamName) || "");
  const [myTeamStatus, setMyTeamStatus] = useState(() => localStorage.getItem(LS_KEYS.teamStatus) || "Indefinido");

  /** ---- Roster ---- */
  const [myRoster, setMyRoster] = useState(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_KEYS.roster) || "null");
      if (parsed && Array.isArray(parsed.players) && Array.isArray(parsed.picks)) return parsed;
      return { players: [], picks: [] };
    } catch {
      return { players: [], picks: [] };
    }
  });

  /** ---- Overrides de status ---- */
  const [myStatusOverrides, setMyStatusOverrides] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEYS.statuses) || "{}");
    } catch {
      return {};
    }
  });

  /** ---- Asset values (pro) ---- */
  const [myAssetValues, setMyAssetValues] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEYS.assetValues) || "{}");
    } catch {
      return {};
    }
  });

  /** ---- Catalog players ---- */
  const [playerCatalog, setPlayerCatalog] = useState(() => {
    try {
      const cached = localStorage.getItem(PLAYERS_CACHE_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  const [playersLoading, setPlayersLoading] = useState(playerCatalog.length === 0);
  const [playersError, setPlayersError] = useState("");

  /** ---- ADP ranking map ---- */
  const [adpMap, setAdpMap] = useState(() => ({}));
  const [adpLoading, setAdpLoading] = useState(true);
  const [adpError, setAdpError] = useState("");

  /** ---- "Mi equipo" UI state ---- */
  const [assetPanel, setAssetPanel] = useState("players");
  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");
  const [dropdownOpen, setDropdownOpen] = useState(true);
  const [catalogScrolled, setCatalogScrolled] = useState(false);
  const onCatalogScroll = (e) => {
    const top = e.currentTarget?.scrollTop || 0;
    setCatalogScrolled(top > 6);
  };

  /** ========= Local persistence helpers ========= */
  const setAndStore = (key, value) => {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  };

  /** ========= Supabase state load/save ========= */
  const [remoteError, setRemoteError] = useState("");

  async function loadRemoteState(uid) {
    try {
      setRemoteError("");
      const { data, error } = await supabase.from(USER_STATE_TABLE).select("state").eq("user_id", uid).maybeSingle();
      if (error) throw error;
      return data?.state || null;
    } catch (e) {
      setRemoteError(e?.message || "No se pudo leer estado remoto");
      return null;
    }
  }

  async function saveRemoteState(uid, state) {
    try {
      setRemoteError("");

      // 1) Private state
      {
        const { error } = await supabase.from(USER_STATE_TABLE).upsert({ user_id: uid, state }, { onConflict: "user_id" });
        if (error) throw error;
      }
      // 2) League state (public for authenticated users)
{
  const row = {
    user_id: uid,
    display_name: cleanText(state.displayName),
    team_name: cleanText(state.teamName),
    team_status: cleanText(state.teamStatus),
    roster: state.roster || { players: [], picks: [] },
    status_overrides: state.statusOverrides || {},
    asset_values: state.assetValues || {},
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from(LEAGUE_TEAMS_TABLE)
    .upsert(row, { onConflict: "user_id" });

  if (error) throw error;

   // ✅ Update local cache so "Liga" reflects the change immediately
  setLeagueTeams((prev) => {
    const arr = prev || [];
    const idx = arr.findIndex((x) => x.user_id === uid);

    if (idx === -1) return [row, ...arr];

    const next = [...arr];
    next[idx] = { ...next[idx], ...row };
    return next;
  });
}

    } catch (e) {
      setRemoteError(e?.message || "No se pudo guardar estado remoto");
    }
  }

  // Al loguear: cargar state remoto (si existe) y aplicarlo
  useEffect(() => {
    if (!authReady) return;
    if (!user) return;

    (async () => {
      const state = await loadRemoteState(user.id);
      if (!state) return;

      if (state.displayName != null) setMyDisplayName(String(state.displayName));
      if (state.teamName != null) setMyTeamName(String(state.teamName));
      if (state.teamStatus != null) setMyTeamStatus(String(state.teamStatus));
      if (state.roster) setMyRoster(state.roster);
      if (state.statusOverrides) setMyStatusOverrides(state.statusOverrides);
      if (state.assetValues) setMyAssetValues(state.assetValues);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user?.id]);

  // Guardado remoto (debounced)
  useEffect(() => {
    if (!authReady) return;
    if (!user) return;

    const effectiveDisplayName = cleanText(myDisplayName) || (user?.email?.split("@")[0] || "");

const state = {
  displayName: effectiveDisplayName,
  teamName: cleanText(myTeamName),
  teamStatus: cleanText(myTeamStatus),
  roster: myRoster,
  statusOverrides: myStatusOverrides,
  assetValues: myAssetValues,
};



    const t = setTimeout(() => {
      saveRemoteState(user.id, state);
    }, 500);

    return () => clearTimeout(t);
  }, [authReady, user, myDisplayName, myTeamName, myTeamStatus, myRoster, myStatusOverrides, myAssetValues]);

  // Local persistence
  useEffect(() => setAndStore(LS_KEYS.displayName, myDisplayName), [myDisplayName]);
  useEffect(() => setAndStore(LS_KEYS.teamName, myTeamName), [myTeamName]);
  useEffect(() => setAndStore(LS_KEYS.teamStatus, myTeamStatus), [myTeamStatus]);
  useEffect(() => setAndStore(LS_KEYS.roster, myRoster), [myRoster]);
  useEffect(() => setAndStore(LS_KEYS.statuses, myStatusOverrides), [myStatusOverrides]);
  useEffect(() => setAndStore(LS_KEYS.assetValues, myAssetValues), [myAssetValues]);

  /** ========= Load Sleeper players ========= */
  useEffect(() => {
    let cancelled = false;

    async function loadPlayers() {
      try {
        setPlayersError("");

        const ts = Number(localStorage.getItem(PLAYERS_CACHE_TS_KEY) || "0");
        const cacheFresh = ts && Date.now() - ts < ONE_DAY_MS;
        const cached = localStorage.getItem(PLAYERS_CACHE_KEY);

        if (cacheFresh && cached) {
          const parsed = JSON.parse(cached);
          if (!cancelled) {
            setPlayerCatalog(parsed);
            setPlayersLoading(false);
          }
          return;
        }

        setPlayersLoading(true);
        const res = await fetch(SLEEPER_PLAYERS_URL);
        if (!res.ok) throw new Error(`Sleeper error ${res.status}`);

        const raw = await res.json();
        const normalized = normalizeSleeperPlayers(raw);

        localStorage.setItem(PLAYERS_CACHE_KEY, JSON.stringify(normalized));
        localStorage.setItem(PLAYERS_CACHE_TS_KEY, String(Date.now()));

        if (!cancelled) {
          setPlayerCatalog(normalized);
          setPlayersLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setPlayersLoading(false);
          setPlayersError(e?.message || "Error cargando jugadores");
        }
      }
    }

    if (playerCatalog.length === 0) loadPlayers();
    else {
      const ts = Number(localStorage.getItem(PLAYERS_CACHE_TS_KEY) || "0");
      const cacheFresh = ts && Date.now() - ts < ONE_DAY_MS;
      if (!cacheFresh) loadPlayers();
      else setPlayersLoading(false);
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ========= Load ADP ranking ========= */
  useEffect(() => {
    let cancelled = false;

    async function loadAdp() {
      try {
        setAdpError("");
        setAdpLoading(true);

        const { players } = await fetchAdpWithFallback();
        const sorted = players
          .filter((p) => p?.name && p?.position)
          .slice()
          .sort((a, b) => (Number(a.adp) || 9999) - (Number(b.adp) || 9999));

        const map = {};
        sorted.forEach((p, idx) => {
          const key = playerKey({ name: p.name, pos: (p.position || "").toUpperCase() });
          if (!map[key]) map[key] = { rank: idx + 1 };
        });

        if (!cancelled) {
          setAdpMap(map);
          setAdpLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setAdpLoading(false);
          setAdpError(e?.message || "Error cargando rankings");
        }
      }
    }

    loadAdp();
    return () => {
      cancelled = true;
    };
  }, []);

  /** ========= Derived: filtered catalogs ========= */
  const filteredPlayers = useMemo(() => {
    const q = normalize(search);
    const hasRanks = Object.keys(adpMap || {}).length > 0;

    const base = playerCatalog
      .filter((p) => {
        if (posFilter === "ALL") return true;
        if (posFilter === "FLEX") return FLEX_POS.has(p.pos);
        return p.pos === posFilter;
      })
      .filter((p) => (q ? normalize(p.name).includes(q) : true))
      .map((p) => {
        const key = playerKey(p);
        const rankObj = adpMap[key];
        return { ...p, _rank: rankObj?.rank ?? 999999 };
      });

    if (hasRanks) return base.sort((a, b) => a._rank - b._rank).slice(0, 400);
    return base.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 400);
  }, [search, posFilter, playerCatalog, adpMap]);

  /** ========= Picks catalog =========
   * 2026: 1.01 – 6.10 (10 equipos, 6 rondas)
   * 2027/2028: 1era–6ta por ronda
   */
  const TEAMS_COUNT = 10;
  const ROUNDS_COUNT = 6;

  const picks2026 = useMemo(() => {
    return Array.from({ length: ROUNDS_COUNT }, (_, rIdx) => {
      const round = rIdx + 1;
      return Array.from({ length: TEAMS_COUNT }, (_, tIdx) => {
        const slot = tIdx + 1;
        const slotLabel = String(slot).padStart(2, "0");
        return {
          id: `2026-${round}.${slotLabel}`,
          year: 2026,
          roundNum: round,
          slot,
          label: `${round}.${slotLabel} 2026`,
        };
      });
    }).flat();
  }, []);

  const roundsLabel = { 1: "1era", 2: "2da", 3: "3era", 4: "4ta", 5: "5ta", 6: "6ta" };

  const picksFuture = useMemo(() => {
    return [2027, 2028].flatMap((year) =>
      Array.from({ length: ROUNDS_COUNT }, (_, rIdx) => {
        const round = rIdx + 1;
        return {
          id: `${year}-${round}`,
          year,
          roundNum: round,
          label: `${roundsLabel[round]} ${year}`,
        };
      })
    );
  }, []);

  const pickCatalog = useMemo(() => [...picks2026, ...picksFuture], [picks2026, picksFuture]);

  const filteredPicks = useMemo(() => {
    const q = normalize(search);
    const label = (pk) => pk.label || `${pk.round} ${pk.year}`;

    return pickCatalog
      .filter((pk) => (q ? normalize(label(pk)).includes(q) : true))
      .sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        const ra = a.roundNum || 0;
        const rb = b.roundNum || 0;
        if (ra !== rb) return ra - rb;
        const sa = a.slot || 0;
        const sb = b.slot || 0;
        return sa - sb;
      });
  }, [search, pickCatalog]);

  /** ========= Actions: roster and overrides ========= */
  const addToMyTeam = (type, id) => {
    if (type === "player") {
      if (myRoster.players.includes(id)) return;

      if ((myRoster.players?.length || 0) >= MAX_ROSTER_PLAYERS) {
        alert(`Flaquito, solo podés tener ${MAX_ROSTER_PLAYERS} jugadores en el roster. Quitá uno antes de agregar otro o dejá de agregar jugadores que no son tuyos`);
        return;
      }

      setMyRoster((prev) => ({ ...prev, players: [...prev.players, id] }));

      const key = `player:${id}`;
      setMyStatusOverrides((prev) => (prev[key] ? prev : { ...prev, [key]: "LISTENING" }));
      return;
    }

    if (type === "pick") {
      if (myRoster.picks.includes(id)) return;
      setMyRoster((prev) => ({ ...prev, picks: [...prev.picks, id] }));

      const key = `pick:${id}`;
      setMyStatusOverrides((prev) => (prev[key] ? prev : { ...prev, [key]: "LISTENING" }));
    }
  };

  const removeFromMyTeam = (type, id) => {
    if (type === "player") {
      setMyRoster((prev) => ({ ...prev, players: prev.players.filter((x) => x !== id) }));
      return;
    }
    if (type === "pick") {
      setMyRoster((prev) => ({ ...prev, picks: prev.picks.filter((x) => x !== id) }));
    }
  };

  /** ========= Build "me" players from roster ids ========= */
  const myPlayers = useMemo(() => {
    return myRoster.players
      .map((id) => playerCatalog.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => {
        const key = playerKey(p);
        const rankObj = adpMap[key];
        const overrideKey = `player:${p.id}`;
        const status = myStatusOverrides[overrideKey] || "LISTENING";
        return { ...p, _rank: rankObj?.rank ?? 999999, status };
      });
  }, [myRoster.players, playerCatalog, adpMap, myStatusOverrides]);

  const myRosterView = useMemo(() => buildRosterView(myPlayers), [myPlayers]);

  /** ========= Picks in my roster ========= */
  const myPicks = useMemo(() => {
    return myRoster.picks
      .map((id) => pickCatalog.find((p) => p.id === id))
      .filter(Boolean)
      .map((pk) => {
        const k = `pick:${pk.id}`;
        const status = myStatusOverrides[k] || "LISTENING";
        return { ...pk, status };
      });
  }, [myRoster.picks, myStatusOverrides, pickCatalog]);

  /** ========= Asset values editor ========= */
  const [valueEditorOpen, setValueEditorOpen] = useState(false);
  const [valueEditorPlayer, setValueEditorPlayer] = useState(null);

  const openValueEditor = (playerObj) => {
    setValueEditorPlayer(playerObj);
    setValueEditorOpen(true);
  };
  const saveValueForPlayer = (playerId, payload) => {
    const key = `player:${playerId}`;
    setMyAssetValues((prev) => ({ ...prev, [key]: payload }));
  };
  const clearValueForPlayer = (playerId) => {
    const key = `player:${playerId}`;
    setMyAssetValues((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /** ========= League (Supabase) ========= */
  const [leagueTeams, setLeagueTeams] = useState([]);
  const [leagueLoading, setLeagueLoading] = useState(false);
  const [leagueErr, setLeagueErr] = useState("");

  const [selectedLeagueUserId, setSelectedLeagueUserId] = useState(null);

  useEffect(() => {
    if (!authReady || !user) return;

    (async () => {
      try {
        setLeagueErr("");
        setLeagueLoading(true);

        const { data, error } = await supabase
        .from(LEAGUE_TEAMS_TABLE)
        .select("user_id, display_name, team_name, team_status, roster, status_overrides, asset_values, updated_at")
        .order("updated_at", { ascending: false });


        if (error) throw error;

        const rows = data || [];
        setLeagueTeams(rows);
        setSelectedLeagueUserId((prev) => prev || rows[0]?.user_id || user.id);
        setLeagueLoading(false);
      } catch (e) {
        setLeagueLoading(false);
        setLeagueErr(e?.message || "No se pudo cargar la liga");
      }
    })();
  }, [authReady, user?.id]);

  const selectedLeagueTeam = useMemo(() => leagueTeams.find((t) => t.user_id === selectedLeagueUserId) || null, [leagueTeams, selectedLeagueUserId]);

  const leagueByUserId = useMemo(() => {
    const m = {};
    (leagueTeams || []).forEach((t) => (m[t.user_id] = t));
    return m;
  }, [leagueTeams]);

  const posCountsFromIds = (ids) => {
    const c = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const id of ids || []) {
      const p = playerCatalog.find((x) => x.id === id);
      if (p && c[p.pos] != null) c[p.pos]++;
    }
    return c;
  };

  const selectedLeaguePlayers = useMemo(() => {
    const ids = selectedLeagueTeam?.roster?.players || [];
    return ids
      .map((id) => playerCatalog.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => {
        const key = playerKey(p);
        const rankObj = adpMap[key];
        return { ...p, _rank: rankObj?.rank ?? 999999 };
      });
  }, [selectedLeagueTeam?.roster?.players, playerCatalog, adpMap]);

  const selectedLeaguePicks = useMemo(() => {
    const ids = selectedLeagueTeam?.roster?.picks || [];
    return ids.map((id) => pickCatalog.find((p) => p.id === id)).filter(Boolean);
  }, [selectedLeagueTeam?.roster?.picks, pickCatalog]);

  /** ========= League Interests (Supabase) ========= */
  const [myInterestsRemote, setMyInterestsRemote] = useState([]);
  const [incomingInterests, setIncomingInterests] = useState([]);
  const [interestsLoading, setInterestsLoading] = useState(false);
  const [interestsErr, setInterestsErr] = useState("");

  async function refreshInterests({ silent = false } = {}) {
    if (!authReady || !user) return;

    try {
      setInterestsErr("");
      if (!silent) setInterestsLoading(true);

      const mine = await supabase
        .from(LEAGUE_INTERESTS_TABLE)
        .select("id, from_user_id, to_user_id, asset_type, asset_id, level, note, updated_at")
        .eq("from_user_id", user.id)
        .order("updated_at", { ascending: false });

      if (mine.error) throw mine.error;

      const inc = await supabase
        .from(LEAGUE_INTERESTS_TABLE)
        .select("id, from_user_id, to_user_id, asset_type, asset_id, level, note, updated_at")
        .eq("to_user_id", user.id)
        .order("updated_at", { ascending: false });

      if (inc.error) throw inc.error;

      setMyInterestsRemote(mine.data || []);
      setIncomingInterests(inc.data || []);
      if (!silent) setInterestsLoading(false);
    } catch (e) {
      if (!silent) setInterestsLoading(false);
      setInterestsErr(e?.message || "No se pudieron cargar intereses");
    }
  }

  useEffect(() => {
    if (!authReady || !user) return;
    refreshInterests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user?.id]);

  const myInterestsByKey = useMemo(() => {
    const m = {};
    for (const i of myInterestsRemote) {
      const key = `${i.asset_type}:${i.asset_id}:${i.to_user_id}`;
      m[key] = i;
    }
    return m;
  }, [myInterestsRemote]);

  function optimisticUpsertInterest({ toUserId, assetType, assetId, level }) {
    if (!user) return;
    const now = new Date().toISOString();
    setMyInterestsRemote((prev) => {
      const arr = prev || [];
      const idx = arr.findIndex(
        (i) =>
          i.from_user_id === user.id &&
          i.to_user_id === toUserId &&
          i.asset_type === assetType &&
          String(i.asset_id) === String(assetId)
      );

      const nextItem = {
        ...(idx >= 0 ? arr[idx] : {}),
        id: idx >= 0 ? arr[idx].id : `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        from_user_id: user.id,
        to_user_id: toUserId,
        asset_type: assetType,
        asset_id: String(assetId),
        level,
        updated_at: now,
      };

      if (idx === -1) return [nextItem, ...arr];
      const copy = [...arr];
      copy[idx] = nextItem;
      return copy;
    });
  }

  function optimisticDeleteInterest({ toUserId, assetType, assetId }) {
    if (!user) return;
    setMyInterestsRemote((prev) =>
      (prev || []).filter(
        (i) =>
          !(
            i.from_user_id === user.id &&
            i.to_user_id === toUserId &&
            i.asset_type === assetType &&
            String(i.asset_id) === String(assetId)
          )
      )
    );
  }

  async function upsertInterest({ toUserId, assetType, assetId, level }) {
    if (!user) return;

    // Optimistic UI
    optimisticUpsertInterest({ toUserId, assetType, assetId, level });

    const payload = {
      from_user_id: user.id,
      to_user_id: toUserId,
      asset_type: assetType,
      asset_id: String(assetId),
      level,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from(LEAGUE_INTERESTS_TABLE).upsert(payload, {
      onConflict: "from_user_id,to_user_id,asset_type,asset_id",
    });

    if (!error) return refreshInterests({ silent: true });

    // Re-sync if something went wrong
    setInterestsErr(error?.message || "No se pudo guardar interés");
    return refreshInterests({ silent: false });
  }

  async function deleteInterest({ toUserId, assetType, assetId }) {
    if (!user) return;

    // Optimistic UI
    optimisticDeleteInterest({ toUserId, assetType, assetId });

    const { error } = await supabase
      .from(LEAGUE_INTERESTS_TABLE)
      .delete()
      .match({
        from_user_id: user.id,
        to_user_id: toUserId,
        asset_type: assetType,
        asset_id: String(assetId),
      });

    if (!error) return refreshInterests({ silent: true });

    setInterestsErr(error?.message || "No se pudo borrar interés");
    return refreshInterests({ silent: false });
  }

  async function toggleInterest({ toUserId, assetType, assetId, level, existingLevel }) {
    if (existingLevel === level) {
      return deleteInterest({ toUserId, assetType, assetId });
    }
    return upsertInterest({ toUserId, assetType, assetId, level });
  }


  const resolveAssetLabel = (asset_type, asset_id) => {
    if (asset_type === "player") {
      const p = playerCatalog.find((x) => x.id === asset_id);
      return p ? `${p.name} (${p.pos})` : `Jugador ${asset_id}`;
    }
    if (asset_type === "pick") {
      const pk = pickCatalog.find((x) => x.id === asset_id);
      return pk ? pk.label : `Pick ${asset_id}`;
    }
    return `${asset_type}:${asset_id}`;
  };

  /** ========= BLOCKING: auth gating ========= */
  if (!authReady) {
    return <div style={{ padding: 20, fontWeight: 900 }}>Cargando…</div>;
  }
  if (!user) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: COLORS.page, fontFamily: "Inter, system-ui, Arial", ...themeVars }}>
        <div style={{ width: "100%", maxWidth: 420 }}>
          <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 10, color: COLORS.navy }}>Fantasy Trade Board</div>
          <AuthPanel user={null} />
          <div style={{ marginTop: 10, fontSize: 12, color: COLORS.gray, fontWeight: 800 }}>Tenés que iniciar sesión para ver la app.</div>
        </div>
      </div>
    );
  }

  /** ========= UI ========= */
  return (
    <div
      style={{
        ...themeVars,
        minHeight: "100vh",
        width: "100%",
        overflowX: "hidden",
        background: COLORS.page,
        color: COLORS.navy,
        fontFamily: "Inter, system-ui, Arial",
      }}
    >
      {/* Full-width + fondo consistente (evita "franjas" negras/grises en monitores wide) */}
      <style>{`
          :root { background: var(--c-page) !important; color-scheme: ${theme === "dark" ? "dark" : "light"}; }
          html, body, #root {
            width: 100%;
            height: 100%;
            margin: 0;
            padding: 0;
            background: var(--c-page) !important;
            overflow-x: hidden;
          }
          body {
            display: block !important;
            min-height: 100vh;
            min-width: 0;
          }
          #root {
            max-width: none !important;
            padding: 0 !important;
            margin: 0 !important;
          }
        `}</style>
      {/* Topbar */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          borderBottom: `1px solid ${COLORS.border}`,
          background: "var(--c-topbar)",
          backdropFilter: "blur(8px)",
        }}
      >
        <div
          style={{
            maxWidth: containerMax,
            margin: "0 auto",
            padding: `12px ${padX}px`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>Fantasy Trade Board</div>
            
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 12, background: COLORS.sky, border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: "6px 10px", fontWeight: 900 }}>{user.email}</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: containerMax, margin: "0 auto", padding: `16px ${padX}px ${contentPadBottom}px` }}>
        {tab === "Inicio" && (
          <div style={{ display: "grid", gap: 12 }}>
            <AuthPanel user={user} />

            {remoteError ? (
              <Card>
                <div style={{ fontWeight: 900, color: COLORS.danger }}>Aviso Supabase</div>
                <div style={{ fontSize: 13, color: COLORS.gray, marginTop: 6 }}>{remoteError}</div>
                <div style={{ fontSize: 13, color: COLORS.gray, marginTop: 6 }}>
                  Si es tu primera vez: asegurate de haber creado la tabla <b>{USER_STATE_TABLE}</b> con RLS.
                </div>
              </Card>
            ) : null}

            <Card bg={COLORS.sky}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>Apariencia</div>
                  <div style={{ fontSize: 13, color: COLORS.gray, marginTop: 6 }}>Elegí tema claro u oscuro.</div>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    padding: 4,
                    borderRadius: 999,
                    border: `1px solid ${COLORS.border}`,
                    background: COLORS.white,
                  }}
                >
                  <button
                    onClick={() => setTheme("light")}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      borderRadius: 999,
                      padding: "8px 12px",
                      fontWeight: 900,
                      background: theme === "light" ? COLORS.blue : "transparent",
                      color: theme === "light" ? "white" : COLORS.navy,
                      outline: "none",
                      boxShadow: "none",
                    }}
                    title="Tema claro"
                  >
                    Claro
                  </button>
                  <button
                    onClick={() => setTheme("dark")}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      borderRadius: 999,
                      padding: "8px 12px",
                      fontWeight: 900,
                      background: theme === "dark" ? COLORS.blue : "transparent",
                      color: theme === "dark" ? "white" : COLORS.navy,
                      outline: "none",
                      boxShadow: "none",
                    }}
                    title="Tema oscuro"
                  >
                    Oscuro
                  </button>
                </div>
              </div>
            </Card>

            <Card bg={COLORS.sky}>
              <div style={{ fontWeight: 900 }}>Tip rápido</div>
              <div style={{ fontSize: 13, color: COLORS.gray, marginTop: 6 }}>Tu equipo/estados/valores se guardan automáticamente en tu cuenta.</div>
            </Card>
          </div>
        )}

        {tab === "Mi equipo" && (
          <div style={{ display: "grid", gap: 12 }}>
            <Card bg={COLORS.sky}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ minWidth: 280 }}>
                  <div style={{ fontWeight: 900 }}>{myDisplayName || user.email.split("@")[0]}</div>
                  <div style={{ fontSize: 13, color: COLORS.gray }}>{myTeamName || "Mi equipo"}</div>
                  <div style={{ fontSize: 12, color: COLORS.gray, marginTop: 6 }}>
                    Formato: <b>1 QB · 2 RB · 2 WR · 1 TE · 3 FLEX · 21 BN</b>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    value={myDisplayName}
                    onChange={(e) => setMyDisplayName(e.target.value)}
                    placeholder="Tu nombre"
                    style={{
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.white,
                      borderRadius: 12,
                      padding: "10px 12px",
                      outline: "none",
                      minWidth: isMobile ? 0 : 220,
                      width: isMobile ? "100%" : undefined,
                    }}
                  />
                  <input
                    value={myTeamName}
                    onChange={(e) => setMyTeamName(e.target.value)}
                    placeholder="Nombre del equipo"
                    style={{
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.white,
                      borderRadius: 12,
                      padding: "10px 12px",
                      outline: "none",
                      minWidth: isMobile ? 0 : 220,
                      width: isMobile ? "100%" : undefined,
                    }}
                  />

                  <select
                    value={myTeamStatus}
                    onChange={(e) => setMyTeamStatus(e.target.value)}
                    style={{
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.white,
                      borderRadius: 12,
                      padding: "10px 12px",
                      fontWeight: 900,
                      color: COLORS.navy,
                      cursor: "pointer",
                      minWidth: isMobile ? 0 : 170,
                      width: isMobile ? "100%" : undefined,
                    }}
                  >
                    <option>Contendiente</option>
                    <option>Reconstrucción</option>
                    <option>Indefinido</option>
                  </select>
                </div>
              </div>
            </Card>

            {/* Two-column layout */}
            <div style={{ display: "grid", gridTemplateColumns: isTablet ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)", gap: 12, alignItems: "start" }}>
              {/* LEFT: Catalog */}
              <Card>

                {dropdownOpen && (
                  <>
                    <div
                      style={{
                        marginTop: 10,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 16,
                        overflow: "hidden",
                        background: COLORS.white,
                      }}
                    >
                      {/* Sticky header (pro) */}
                      <div
                        style={{
                          position: "sticky",
                          top: 0,
                          zIndex: 2,
                          background: "var(--c-topbar)",
                          backdropFilter: "blur(8px)",
                          borderBottom: `1px solid ${COLORS.border}`,
                          padding: 10,
                          boxShadow: catalogScrolled ? "0 8px 16px rgba(0,0,0,0.06)" : "none",
                        }}
                      >
                        {/* Toggle players/picks */}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            onClick={() => setAssetPanel("players")}
                            style={{
                              flex: 1,
                              border: "none",
                              cursor: "pointer",
                              borderRadius: 12,
                              padding: "10px 12px",
                              fontWeight: 900,
                              background: assetPanel === "players" ? COLORS.blue : COLORS.sky,
                              color: assetPanel === "players" ? "white" : COLORS.blue,
                            }}
                          >
                            Jugadores
                          </button>
                          <button
                            onClick={() => setAssetPanel("picks")}
                            style={{
                              flex: 1,
                              border: "none",
                              cursor: "pointer",
                              borderRadius: 12,
                              padding: "10px 12px",
                              fontWeight: 900,
                              background: assetPanel === "picks" ? COLORS.blue : COLORS.sky,
                              color: assetPanel === "picks" ? "white" : COLORS.blue,
                            }}
                          >
                            Picks
                          </button>
                        </div>

                        {/* Search */}
                        <div style={{ marginTop: 10 }}>
                          <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={assetPanel === "players" ? "Buscar jugador por nombre…" : "Buscar pick (ej: 1.01 2026 / 2da 2027)…"}
                            style={{
                              width: "100%",
                              border: `1px solid ${COLORS.border}`,
                              borderRadius: 12,
                              padding: "10px 12px",
                              outline: "none",
                              background: COLORS.white,
                              color: COLORS.navy,
                              boxSizing: "border-box",
                              minWidth: 0,
                            }}
                          />
                        </div>

                        {/* POS filter (scrollable on phone) */}
                        {assetPanel === "players" && (
                          <div
                            style={{
                              marginTop: 10,
                              display: "flex",
                              gap: 8,
                              overflowX: isPhone ? "auto" : "visible",
                              paddingBottom: isPhone ? 4 : 0,
                              WebkitOverflowScrolling: "touch",
                              scrollbarWidth: "none",
                            }}
                          >
                            {['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX'].map((p) => (
                              <button
                                key={p}
                                onClick={() => setPosFilter(p)}
                                style={{
                                  flex: "0 0 auto",
                                  border: `1px solid ${COLORS.border}`,
                                  background: posFilter === p ? COLORS.blue : COLORS.white,
                                  color: posFilter === p ? "white" : COLORS.navy,
                                  borderRadius: 999,
                                  padding: "8px 10px",
                                  cursor: "pointer",
                                  fontWeight: 900,
                                  fontSize: 12,
                                }}
                              >
                                {p === "ALL" ? "Todos" : p}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Scroll list */}
                      <div
                        onScroll={onCatalogScroll}
                        style={{
                          maxHeight: isMobile ? "60vh" : 520,
                          overflowY: "auto",
                          overflowX: "hidden",
                          padding: "10px 10px 12px",
                          minWidth: 0,
                        }}
                      >
                        {assetPanel === "players" && playersLoading && (
                          <div style={{ padding: "10px 0", color: COLORS.gray, fontWeight: 800 }}>Cargando jugadores desde Sleeper…</div>
                        )}
                        {assetPanel === "players" && !playersLoading && adpLoading && (
                          <div style={{ padding: "10px 0", color: COLORS.gray, fontWeight: 800 }}>Cargando rankings…</div>
                        )}
                        {assetPanel === "players" && playersError && (
                          <div style={{ padding: "10px 0", color: COLORS.danger, fontWeight: 900 }}>Error cargando jugadores: {playersError}</div>
                        )}
                        {assetPanel === "players" && !playersError && adpError && (
                          <div style={{ padding: "10px 0", color: COLORS.warn, fontWeight: 900 }}>Rankings no disponibles (orden alfabético). {adpError}</div>
                        )}

                      {/* Players list */}
                      {assetPanel === "players" &&
                        !playersLoading &&
                        !playersError &&
                        filteredPlayers.map((p) => {
                          const inTeam = myRoster.players.includes(p.id);
                          return (
                            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: `1px solid ${COLORS.border}`, alignItems: "center" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <Headshot id={p.id} name={p.name} size={34} />
                                <div>
                                  <div style={{ fontWeight: 900 }}>{p.name}</div>
                                  <div style={{ fontSize: 13, color: COLORS.gray, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                    <PosChip pos={p.pos} />
                                    <span>{p.nfl || "-"}</span>
                                  </div>
                                </div>
                              </div>

                              <button
                                disabled={inTeam}
                                onClick={() => addToMyTeam("player", p.id)}
                                style={{
                                  cursor: inTeam ? "not-allowed" : "pointer",
                                  opacity: inTeam ? 0.5 : 1,
                                  borderRadius: 12,
                                  padding: "8px 10px",
                                  fontWeight: 900,
                                  border: `1px solid ${COLORS.border}`,
                                  background: inTeam ? COLORS.soft : COLORS.sky,
                                  color: COLORS.blue,
                                  height: 40,
                                }}
                              >
                                {inTeam ? "Agregado" : "+ Agregar"}
                              </button>
                            </div>
                          );
                        })}

                      {/* Picks list */}
                      {assetPanel === "picks" &&
                        filteredPicks.map((pk) => {
                          const inTeam = myRoster.picks.includes(pk.id);
                          const label = pk.label || `${pk.round} ${pk.year}`;
                          return (
                            <div key={pk.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: `1px solid ${COLORS.border}` }}>
                              <div>
                                <div style={{ fontWeight: 900 }}>{label}</div>
                                <div style={{ fontSize: 13, color: COLORS.gray }}>Pick de draft</div>
                              </div>

                              <button
                                disabled={inTeam}
                                onClick={() => addToMyTeam("pick", pk.id)}
                                style={{
                                  cursor: inTeam ? "not-allowed" : "pointer",
                                  opacity: inTeam ? 0.5 : 1,
                                  borderRadius: 12,
                                  padding: "8px 10px",
                                  fontWeight: 900,
                                  border: `1px solid ${COLORS.border}`,
                                  background: inTeam ? COLORS.soft : COLORS.sky,
                                  color: COLORS.blue,
                                  height: 40,
                                }}
                              >
                                {inTeam ? "Agregado" : "+ Agregar"}
                              </button>
                            </div>
                          );
                        })}
                    </div>
                    </div>
                  </>
                )}
              </Card>

              {/* RIGHT: My Team */}
              <Card>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>Mi equipo (slots)</div>
                <div style={{ fontSize: 13, color: COLORS.gray, marginBottom: 10 }}>
                  Tocá el botón de estado: <b>Disponible → En escucha → No disponible</b>
                </div>

                {(() => {
                  const getShownStatus = (pid, fallbackStatus) => {
                    const k = `player:${pid}`;
                    return myStatusOverrides[k] || fallbackStatus || "LISTENING";
                  };

                  const toggleStatus = (pid, current) => {
                    const k = `player:${pid}`;
                    const next = nextStatus(current);
                    setMyStatusOverrides((prev) => ({ ...prev, [k]: next }));
                  };

                  const renderGroup = (title, chip, arr, needed) => {
                    const rows = [];
                    for (let i = 0; i < needed; i++) {
                      const p = arr[i];
                      if (p) {
                        const shown = getShownStatus(p.id, p.status);
                        rows.push(
                          <PlayerRow
                            key={`${title}-${p.id}-${i}`}
                            p={p}
                            isPhone={isPhone}
                            chip={chip}
                            status={shown}
                            value={myAssetValues[`player:${p.id}`]}
                            onEditValue={() => openValueEditor(p)}
                            onToggleStatus={() => toggleStatus(p.id, shown)}
                            onRemove={() => removeFromMyTeam("player", p.id)}
                          />
                        );
                      } else {
                        rows.push(<EmptySlotRow key={`${title}-empty-${i}`} chip={chip} label={`${title} #${i + 1}`} />);
                      }
                    }

                    return (
                      <div style={{ display: "grid", gap: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
                          <div style={{ fontWeight: 900 }}>{title}</div>
                          <div style={{ fontSize: 12, color: COLORS.gray, fontWeight: 900 }}>
                            {arr.length}/{needed}
                          </div>
                        </div>
                        {rows}
                      </div>
                    );
                  };

                  return (
                    <div style={{ display: "grid", gap: 14 }}>
                      {renderGroup("QB", "QB", myRosterView.qb, ROSTER_SLOTS.QB)}
                      {renderGroup("RB", "RB", myRosterView.rb, ROSTER_SLOTS.RB)}
                      {renderGroup("WR", "WR", myRosterView.wr, ROSTER_SLOTS.WR)}
                      {renderGroup("TE", "TE", myRosterView.te, ROSTER_SLOTS.TE)}
                      {renderGroup("FLEX", "WRT", myRosterView.flex, ROSTER_SLOTS.FLEX)}

                      <div style={{ height: 4 }} />

                      <div style={{ fontWeight: 900, padding: "6px 0" }}>BENCH</div>
                      <div style={{ display: "grid", gap: 10 }}>
                        {myRosterView.bench.length === 0 ? (
                          <EmptyHint text="Todavía no tenés jugadores en el bench." />
                        ) : (
                          myRosterView.bench.map((p, idx) => {
                            const shown = getShownStatus(p.id, p.status);
                            return (
                              <PlayerRow
                                key={`BN-${p.id}-${idx}`}
                                p={p}
                                isPhone={isPhone}
                                chip="BN"
                                status={shown}
                                value={myAssetValues[`player:${p.id}`]}
                                onEditValue={() => openValueEditor(p)}
                                onToggleStatus={() => toggleStatus(p.id, shown)}
                                onRemove={() => removeFromMyTeam("player", p.id)}
                              />
                            );
                          })
                        )}
                      </div>

                      <div style={{ height: 10 }} />

                      <SectionTitle title="Picks" count={myPicks.length} />
                      <div style={{ display: "grid", gap: 10 }}>
                        {myPicks.length === 0 ? (
                          <EmptyHint text="Todavía no agregaste picks." />
                        ) : (
                          myPicks.map((pk) => {
                            const key = `pick:${pk.id}`;
                            const shown = myStatusOverrides[key] || pk.status || "LISTENING";
                            return (
                              <RowCard key={pk.id}>
                                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                                  <div>
                                    <div style={{ fontWeight: 900 }}>{pk.label}</div>
                                    <div style={{ fontSize: 13, color: COLORS.gray }}>Pick de draft</div>
                                  </div>

                                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                    <button
                                      onClick={() => {
                                        const next = nextStatus(shown);
                                        setMyStatusOverrides((prev) => ({ ...prev, [key]: next }));
                                      }}
                                      style={{ cursor: "pointer", borderRadius: 999, padding: "10px 12px", fontWeight: 900, ...statusBadgeStyle(shown) }}
                                    >
                                      {statusLabel(shown)}
                                    </button>

                                    <button
                                      onClick={() => removeFromMyTeam("pick", pk.id)}
                                      title="Quitar del equipo"
                                      style={{
                                        cursor: "pointer",
                                        borderRadius: 12,
                                        padding: "10px 10px",
                                        border: `1px solid ${COLORS.border}`,
                                        background: COLORS.white,
                                        color: COLORS.danger,
                                        fontWeight: 900,
                                      }}
                                    >
                                      ✕
                                    </button>
                                  </div>
                                </div>
                              </RowCard>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })()}
              </Card>
            </div>
          </div>
        )}

        {tab === "Liga" && (
          <div style={{ display: "grid", gap: 12 }}>
            <Card bg={COLORS.sky}>
              <div style={{ fontWeight: 900, fontSize: 18 }}>The Royal Dynasty</div>
            </Card>

            {leagueErr ? (
              <Card>
                <div style={{ fontWeight: 900, color: COLORS.danger }}>{leagueErr}</div>
              </Card>
            ) : null}

            <div style={{ display: "grid", gap: 12, gridTemplateColumns: isMobile ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1.2fr)", alignItems: "start" }}>
              {/* Left: Teams */}
              <Card bg={COLORS.sky}>
                <div style={{ fontWeight: 900, marginBottom: 10 }}>Equipos</div>
                {leagueLoading ? <div style={{ fontSize: 13, color: COLORS.gray, fontWeight: 800 }}>Cargando liga…</div> : null}

                <div style={{ display: "grid", gap: 10 }}>
                  {(leagueTeams || []).map((t) => {
                    const active = t.user_id === selectedLeagueUserId;
                    const counts = posCountsFromIds(t.roster?.players || []);
                    return (
                      <button
                        key={t.user_id}
                        onClick={() => setSelectedLeagueUserId(t.user_id)}
                        style={{
                          textAlign: "left",
                          border: `2px solid ${active ? COLORS.blue : "transparent"}`,
                          background: COLORS.white,
                          borderRadius: 18,
                          padding: 14,
                          cursor: "pointer",
                          outline: "none",
                          WebkitTapHighlightColor: "transparent",
                          boxShadow: "0 1px 8px rgba(0,0,0,0.04)",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{
                                fontWeight: 900,
                                fontSize: 14,
                                color: COLORS.navy,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {safeTeamName(t.team_name)}
                            </div>
                            <div style={{ fontSize: 12, color: COLORS.gray, fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {safeDisplayName(t.display_name, t.user_id.slice(0, 6))}
                            </div>
                            <div style={{ fontSize: 13, color: COLORS.gray }}>
                              {t.team_status || "Indefinido"} · QB: {counts.QB} RB: {counts.RB} WR: {counts.WR} TE: {counts.TE}
                            </div>
                          </div>

                          {t.user_id === user.id ? <Pill>Vos</Pill> : <Pill>Manager</Pill>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Card>

              {/* Right: Selected team */}
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 18 }}>{safeTeamName(selectedLeagueTeam?.team_name)}</div>
                    <div style={{ fontSize: 13, color: COLORS.gray, fontWeight: 900 }}>{safeDisplayName(selectedLeagueTeam?.display_name, "Sin nombre")}</div>
                  </div>
                  <Pill>{selectedLeagueTeam?.team_status || "Indefinido"}</Pill>
                </div>

                <div style={{ marginTop: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>Roster</div>

                  {selectedLeaguePlayers.length === 0 ? (
                    <EmptyHint text="Este equipo no tiene jugadores cargados." />
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {selectedLeaguePlayers
                        .slice()
                        .sort((a, b) => {
                          const order = { QB: 1, RB: 2, WR: 3, TE: 4 };
                          const oa = order[a.pos] || 9;
                          const ob = order[b.pos] || 9;
                          if (oa !== ob) return oa - ob;
                          return (a._rank || 999999) - (b._rank || 999999);
                        })
                        .map((p) => {
                          const shownStatus = (selectedLeagueTeam?.status_overrides || {})[`player:${p.id}`] || "LISTENING";
                          const valueObj = (selectedLeagueTeam?.asset_values || {})[`player:${p.id}`];

                          const showInterestButtons = selectedLeagueTeam?.user_id && selectedLeagueTeam.user_id !== user.id;
                          const interestKey = `player:${p.id}:${selectedLeagueTeam?.user_id}`;
                          const existing = myInterestsByKey[interestKey];

                          return (
                            <div
                              key={p.id}
                              style={{
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 16,
                                padding: "12px 12px",
                                background: COLORS.white,
                                display: "flex",
                                flexDirection: isMobile ? "column" : "row",
                                justifyContent: "space-between",
                                alignItems: isMobile ? "stretch" : "center",
                                gap: 12,
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 900, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
                                  <PosChip pos={p.pos} />
                                  <span style={{ fontSize: 12, color: COLORS.gray, fontWeight: 900 }}>{p.nfl || "-"}</span>
                                </div>
                              </div>

                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: isMobile ? "flex-start" : "flex-end" }}>
                                <span style={{ fontSize: 12, borderRadius: 999, padding: "6px 10px", fontWeight: 900, ...statusBadgeStyle(shownStatus), whiteSpace: "nowrap" }}>
                                  {statusLabel(shownStatus)}
                                </span>

                                <ValuePill value={valueObj} />

                                {showInterestButtons ? (
                                  <div style={{ display: "flex", gap: 6 }}>
                                    {["LOW", "MEDIUM", "HIGH"].map((lvl) => (
                                      <button
                                        key={lvl}
                                        type="button"
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() =>
                                          toggleInterest({
                                            toUserId: selectedLeagueTeam.user_id,
                                            assetType: "player",
                                            assetId: p.id,
                                            level: lvl,
                                            existingLevel: existing?.level || null,
                                          })
                                        }
                                        style={interestButtonStyle(existing?.level === lvl, lvl)}
                                        title="Marcar interés"
                                      >
                                        {interestLabel(lvl)}
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  )}

                  <div style={{ height: 14 }} />

                  <SectionTitle title="Picks" count={selectedLeaguePicks.length} />
                  <div style={{ display: "grid", gap: 8 }}>
                    {selectedLeaguePicks.length === 0 ? (
                      <EmptyHint text="Sin picks." />
                    ) : (
                      selectedLeaguePicks.map((pk) => {
                        const shown = (selectedLeagueTeam?.status_overrides || {})[`pick:${pk.id}`] || "LISTENING";

                        const showInterestButtons = selectedLeagueTeam?.user_id && selectedLeagueTeam.user_id !== user.id;
                        const interestKey = `pick:${pk.id}:${selectedLeagueTeam?.user_id}`;
                        const existing = myInterestsByKey[interestKey];

                        return (
                          <div
                            key={pk.id}
                            style={{
                              border: `1px solid ${COLORS.border}`,
                              borderRadius: 16,
                              padding: "12px 12px",
                              background: COLORS.white,
                              display: "flex",
                              flexDirection: isMobile ? "column" : "row",
                              justifyContent: "space-between",
                              alignItems: isMobile ? "stretch" : "center",
                              gap: 12,
                            }}
                          >
                            <div style={{ fontWeight: 900, fontSize: 14 }}>{pk.label}</div>

                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: isMobile ? "flex-start" : "flex-end" }}>
                              <span style={{ fontSize: 12, borderRadius: 999, padding: "6px 10px", fontWeight: 900, ...statusBadgeStyle(shown) }}>
                                {statusLabel(shown)}
                              </span>

                              {showInterestButtons ? (
                                <div style={{ display: "flex", gap: 6 }}>
                                  {["LOW", "MEDIUM", "HIGH"].map((lvl) => (
                                    <button
                                      key={lvl}
                                        type="button"
                                        onMouseDown={(e) => e.preventDefault()}
                                      onClick={() =>
                                      toggleInterest({
                                        toUserId: selectedLeagueTeam.user_id,
                                        assetType: "pick",
                                        assetId: pk.id,
                                        level: lvl,
                                        existingLevel: existing?.level || null,
                                      })
                                    }
                                      style={interestButtonStyle(existing?.level === lvl, lvl)}
                                    >
                                      {interestLabel(lvl)}
                                    </button>
                                  ))}
                                </div>
                              ) : null}

                              {existing?.level ? <span style={interestBadgeStyle(existing.level)}>{interestLabel(existing.level)}</span> : null}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}

        {tab === "Intereses" && (
          <div style={{ display: "grid", gap: 12 }}>
            {interestsErr ? (
              <Card>
                <div style={{ fontWeight: 900, color: COLORS.danger }}>{interestsErr}</div>
              </Card>
            ) : null}

            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)", gap: 12, alignItems: "start" }}>
              {/* IZQUIERDA: lo que yo quiero */}
              <Card>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>Lo que me interesa</div>

                {interestsLoading ? (
                  <div style={{ fontSize: 13, color: COLORS.gray, fontWeight: 800 }}>Cargando…</div>
                ) : myInterestsRemote.length === 0 ? (
                  <div style={{ fontSize: 13, color: COLORS.gray }}>Todavía no marcaste intereses.</div>
                ) : (
                  myInterestsRemote.map((i) => {
                    const owner = leagueByUserId[i.to_user_id];
                    const ownerName = owner?.team_name || owner?.display_name || i.to_user_id?.slice(0, 6);

                    const assetType = i.asset_type;
                    const assetId = i.asset_id;

                    return (
                      <div key={i.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: `1px solid ${COLORS.border}`, alignItems: "center" }}>
                        <div style={{ minWidth: 0 }}>
                          {assetType === "player" ? (
                            (() => {
                              const p = playerCatalog.find((x) => x.id === assetId);
                              return (
                                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                  <div style={{ fontWeight: 900, fontSize: 13 }}>{p?.name || `Jugador ${assetId}`}</div>
                                  <PosChip pos={p?.pos || ""} />
                                  <span style={{ fontSize: 12, color: COLORS.gray, fontWeight: 800 }}>{p?.nfl || "-"}</span>
                                </div>
                              );
                            })()
                          ) : (
                            <div style={{ fontWeight: 900, fontSize: 13 }}>{resolveAssetLabel(assetType, assetId)}</div>
                          )}

                          <div style={{ fontSize: 12, color: COLORS.gray, fontWeight: 900, marginTop: 4 }}>Dueño: {ownerName}</div>
                          {i.note ? <div style={{ fontSize: 12, color: COLORS.gray }}>Nota: {i.note}</div> : null}
                        </div>

                        <span style={interestBadgeStyle(i.level)}>{interestLabel(i.level)}</span>
                      </div>
                    );
                  })
                )}
              </Card>

              {/* DERECHA: lo que otros quieren de mí */}
              <Card>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>Otros interesados en mi equipo</div>

                {interestsLoading ? (
                  <div style={{ fontSize: 13, color: COLORS.gray, fontWeight: 800 }}>Cargando…</div>
                ) : incomingInterests.length === 0 ? (
                  <div style={{ fontSize: 13, color: COLORS.gray }}>Todavía nadie marcó intereses en tus assets.</div>
                ) : (
                  incomingInterests.map((i) => {
                    const who = leagueByUserId[i.from_user_id];
                    const whoName = who?.team_name || who?.display_name || i.from_user_id?.slice(0, 6);

                    const assetType = i.asset_type;
                    const assetId = i.asset_id;

                    return (
                      <div key={i.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: `1px solid ${COLORS.border}`, alignItems: "center" }}>
                        <div style={{ minWidth: 0 }}>
                          {assetType === "player" ? (
                            (() => {
                              const p = playerCatalog.find((x) => x.id === assetId);
                              return (
                                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                  <div style={{ fontWeight: 900, fontSize: 13 }}>{p?.name || `Jugador ${assetId}`}</div>
                                  <PosChip pos={p?.pos || ""} />
                                  <span style={{ fontSize: 12, color: COLORS.gray, fontWeight: 800 }}>{p?.nfl || "-"}</span>
                                </div>
                              );
                            })()
                          ) : (
                            <div style={{ fontWeight: 900, fontSize: 13 }}>{resolveAssetLabel(assetType, assetId)}</div>
                          )}

                          <div style={{ fontSize: 12, color: COLORS.gray, fontWeight: 900, marginTop: 4 }}>Interesado: {whoName}</div>
                          {i.note ? <div style={{ fontSize: 12, color: COLORS.gray }}>Nota: {i.note}</div> : null}
                        </div>

                        <span style={interestBadgeStyle(i.level)}>{interestLabel(i.level)}</span>
                      </div>
                    );
                  })
                )}
              </Card>
            </div>
          </div>
        )}
      </div>

      {/* Value editor modal */}
      <ValueEditorModal
        open={valueEditorOpen}
        onClose={() => setValueEditorOpen(false)}
        player={valueEditorPlayer}
        initialValue={valueEditorPlayer ? myAssetValues[`player:${valueEditorPlayer.id}`] : null}
        onSave={(payload) => saveValueForPlayer(valueEditorPlayer.id, payload)}
        onClear={() => clearValueForPlayer(valueEditorPlayer.id)}
      />

      {/* Bottom Tabs */}
      <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, borderTop: `1px solid ${COLORS.border}`, background: COLORS.white }}>
        <div style={{ width: "100%", margin: 0, display: "flex", justifyContent: "space-around", padding: isPhone ? 8 : 10, paddingBottom: `calc(${isPhone ? 8 : 10}px + env(safe-area-inset-bottom))` }}>
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                border: "none",
                background: tab === t ? COLORS.sky : "transparent",
                color: tab === t ? COLORS.blue : COLORS.gray,
                fontWeight: 900,
                borderRadius: 14,
                padding: isPhone ? "8px 10px" : "10px 12px",
                fontSize: isPhone ? 12 : 14,
                cursor: "pointer",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** ========= PLAYER ROWS ========= */
function PlayerRow({ p, chip, onRemove, status, onToggleStatus, value, onEditValue, isPhone }) {
  return (
    <RowCard>
      <div style={{ display: "flex", flexDirection: isPhone ? "column" : "row", alignItems: isPhone ? "stretch" : "center", gap: 12, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={slotChipStyle(chip)}>{chip}</div>
          <Headshot id={p.id} name={p.name} size={38} />
          <div>
            <div style={{ fontWeight: 900 }}>{p.name}</div>
            <div style={{ fontSize: 13, color: COLORS.gray, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <PosChip pos={p.pos} />
              <span>{p.nfl || "-"}</span>
            </div>
            {value ? (
              <div style={{ marginTop: 6 }}>
                <ValuePill value={value} />
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: isPhone ? "flex-start" : "flex-end" }}>
          <button
            onClick={onEditValue}
            style={{
              cursor: "pointer",
              borderRadius: 12,
              padding: "10px 12px",
              border: `1px solid ${COLORS.border}`,
              background: COLORS.white,
              color: COLORS.blue,
              fontWeight: 900,
            }}
            title="Editar valor"
          >
            {value ? "Editar valor" : "Valor"}
          </button>

          <button
            onClick={onToggleStatus}
            style={{
              cursor: "pointer",
              borderRadius: 999,
              padding: "10px 12px",
              fontWeight: 900,
              ...statusBadgeStyle(status),
            }}
            title="Disponibilidad"
          >
            {statusLabel(status)}
          </button>

          <button
            onClick={onRemove}
            title="Quitar del equipo"
            style={{
              cursor: "pointer",
              borderRadius: 12,
              padding: "10px 10px",
              border: `1px solid ${COLORS.border}`,
              background: COLORS.white,
              color: COLORS.danger,
              fontWeight: 900,
            }}
          >
            ✕
          </button>
        </div>
      </div>
    </RowCard>
  );
}

function EmptySlotRow({ chip, label }) {
  return (
    <RowCard>
      <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={slotChipStyle(chip)}>{chip}</div>
          <div style={{ color: COLORS.gray, fontWeight: 800 }}>{label}</div>
        </div>
        <div style={{ color: COLORS.gray, fontWeight: 800, fontSize: 13 }}>Vacío</div>
      </div>
    </RowCard>
  );
}

/** ========= UI COMPONENTS ========= */
function Card({ children, bg = COLORS.white }) {
  return <div style={{ background: bg, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 14, boxShadow: "0 1px 8px rgba(0,0,0,0.04)", minWidth: 0 }}>{children}</div>;
}
function RowCard({ children }) {
  return <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 12, background: COLORS.white, minWidth: 0 }}>{children}</div>;
}
function Pill({ children }) {
  return <span style={{ fontSize: 12, background: COLORS.sky, color: COLORS.blue, borderRadius: 999, padding: "6px 10px", fontWeight: 900 }}>{children}</span>;
}
function SectionTitle({ title, count }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
      <div style={{ fontWeight: 900 }}>{title}</div>
      <span style={{ fontSize: 12, color: COLORS.gray, fontWeight: 900 }}>{count}</span>
    </div>
  );
}
function EmptyHint({ text }) {
  return (
    <div style={{ border: `1px dashed ${COLORS.border}`, background: COLORS.soft, borderRadius: 16, padding: 12, color: COLORS.gray, fontWeight: 800, fontSize: 13 }}>
      {text}
    </div>
  );
}

/** ========= ASSET VALUE (PRO) ========= */
const TIER_OPTIONS = [1, 2, 3, 4, 5];

const PICK_PRESETS = [
  { id: "2x2nd", label: "2x 2da", picks: [{ round: 2, qty: 2 }] },
  { id: "1x2nd", label: "1x 2da", picks: [{ round: 2, qty: 1 }] },
  { id: "1x1st", label: "1x 1era", picks: [{ round: 1, qty: 1 }] },
  { id: "late1st", label: "Late 1era", picks: [{ round: 1, qty: 1, tag: "late" }] },
  { id: "mid1st", label: "Mid 1era", picks: [{ round: 1, qty: 1, tag: "mid" }] },
  { id: "early1st", label: "Early 1era", picks: [{ round: 1, qty: 1, tag: "early" }] },
  { id: "1st+2nd", label: "1era + 2da", picks: [{ round: 1, qty: 1 }, { round: 2, qty: 1 }] },
  { id: "2nd+3rd", label: "2da + 3era", picks: [{ round: 2, qty: 1 }, { round: 3, qty: 1 }] },
  { id: "3x2nd", label: "3x 2da", picks: [{ round: 2, qty: 3 }] },
];

function roundLabelEs(round) {
  if (round === 1) return "1era";
  if (round === 2) return "2da";
  if (round === 3) return "3era";
  if (round === 4) return "4ta";
  if (round === 5) return "5ta";
  if (round === 6) return "6ta";
  return `${round}a`;
}

function buildPicksLabel(picks) {
  if (!picks || picks.length === 0) return "";
  const parts = picks.map((p) => {
    const qty = p.qty || 1;
    const base = `${qty}x ${roundLabelEs(p.round)}`;
    if (p.tag) return `${p.tag} ${base}`;
    return base;
  });
  return parts.join(" + ");
}

function buildValueLabel(v) {
  if (!v) return "";
  if (v.customLabel && String(v.customLabel).trim()) return String(v.customLabel).trim();

  const tier = v.tier ? `Tier ${v.tier}` : "";
  const picks = buildPicksLabel(v.picks);
  if (tier && picks) return `${tier} · ${picks}`;
  return tier || picks || "";
}

function ValuePill({ value }) {
  const text = buildValueLabel(value);
  if (!text) return null;

  return (
    <span
      style={{
        fontSize: 12,
        borderRadius: 999,
        padding: "6px 10px",
        fontWeight: 900,
        border: `1px solid ${COLORS.border}`,
        background: COLORS.sky,
        color: COLORS.blue,
        whiteSpace: "nowrap",
      }}
      title={value?.note || ""}
    >
      {text}
    </span>
  );
}

function Modal({ open, onClose, children, title }) {
  const isPhone = useMedia("(max-width: 480px)");

  if (!open) return null;
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: 50,
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div style={{ width: "100%", maxWidth: isPhone ? "96vw" : 520, maxHeight: isPhone ? "86vh" : undefined, overflow: isPhone ? "auto" : undefined, background: COLORS.white, borderRadius: 18, border: `1px solid ${COLORS.border}`, boxShadow: "0 16px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ padding: 14, borderBottom: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 14 }}>{title}</div>
          <button
            onClick={onClose}
            style={{
              border: `1px solid ${COLORS.border}`,
              background: COLORS.white,
              borderRadius: 12,
              padding: "8px 10px",
              cursor: "pointer",
              fontWeight: 900,
              color: COLORS.gray,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 14 }}>{children}</div>
      </div>
    </div>
  );
}

function ValueEditorModal({ open, onClose, player, initialValue, onSave, onClear }) {
  const [tier, setTier] = useState(initialValue?.tier || "");
  const [picks, setPicks] = useState(initialValue?.picks || []);
  const [customLabel, setCustomLabel] = useState(initialValue?.customLabel || "");
  const [note, setNote] = useState(initialValue?.note || "");

  useEffect(() => {
    if (!open) return;
    setTier(initialValue?.tier || "");
    setPicks(initialValue?.picks || []);
    setCustomLabel(initialValue?.customLabel || "");
    setNote(initialValue?.note || "");
  }, [open, initialValue]);

  const applyPreset = (preset) => {
    setPicks(preset.picks || []);
    setCustomLabel("");
  };

  return (
    <Modal open={open} onClose={onClose} title={`Valor del asset · ${player?.name || ""}`}>
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 900, fontSize: 13 }}>Tier</div>
          {TIER_OPTIONS.map((t) => (
            <button
              key={t}
              onClick={() => setTier(tier === t ? "" : t)}
              style={{
                border: `1px solid ${COLORS.border}`,
                background: tier === t ? COLORS.blue : COLORS.white,
                color: tier === t ? "white" : COLORS.navy,
                borderRadius: 999,
                padding: "8px 10px",
                cursor: "pointer",
                fontWeight: 900,
                fontSize: 12,
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div>
          <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 8 }}>Picks (presets)</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {PICK_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset(p)}
                style={{
                  border: `1px solid ${COLORS.border}`,
                  background: COLORS.sky,
                  color: COLORS.blue,
                  borderRadius: 999,
                  padding: "8px 10px",
                  cursor: "pointer",
                  fontWeight: 900,
                  fontSize: 12,
                }}
              >
                {p.label}
              </button>
            ))}
            <button
              onClick={() => setPicks([])}
              style={{
                border: `1px solid ${COLORS.border}`,
                background: COLORS.white,
                color: COLORS.gray,
                borderRadius: 999,
                padding: "8px 10px",
                cursor: "pointer",
                fontWeight: 900,
                fontSize: 12,
              }}
              title="Borrar picks"
            >
              Limpiar picks
            </button>
          </div>

          {picks?.length ? (
            <div style={{ marginTop: 8, fontSize: 12, color: COLORS.gray, fontWeight: 900 }}>Picks actuales: {buildPicksLabel(picks)}</div>
          ) : null}
        </div>

        <div>
          <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 8 }}>Texto custom (opcional)</div>
          <input
            value={customLabel}
            onChange={(e) => setCustomLabel(e.target.value)}
            placeholder="Ej: Late 1era + 2da / RB Tier 2 / 2x2da + 3era…"
            style={{
              width: "100%",
              border: `1px solid ${COLORS.border}`,
              background: COLORS.white,
              color: COLORS.navy,
              borderRadius: 12,
              padding: "10px 12px",
              outline: "none",
              fontWeight: 800,
            }}
          />
          <div style={{ marginTop: 6, fontSize: 12, color: COLORS.gray, fontWeight: 800 }}>Si ponés texto custom, pisa el armado automático (Tier/Picks).</div>
        </div>

        <div>
          <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 8 }}>Nota (opcional)</div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ej: Solo por upgrade, no vendo por picks. / Busco RB joven."
            rows={3}
            style={{
              width: "100%",
              border: `1px solid ${COLORS.border}`,
              background: COLORS.white,
              color: COLORS.navy,
              borderRadius: 12,
              padding: "10px 12px",
              outline: "none",
              resize: "vertical",
              fontWeight: 700,
            }}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: COLORS.gray, fontWeight: 900 }}>Preview:</div>
            <ValuePill value={{ tier, picks, customLabel, note }} />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                onClear();
                onClose();
              }}
              style={{
                border: `1px solid ${COLORS.border}`,
                background: COLORS.white,
                borderRadius: 12,
                padding: "10px 12px",
                cursor: "pointer",
                fontWeight: 900,
                color: COLORS.danger,
              }}
              title="Eliminar valor"
            >
              Borrar
            </button>

            <button
              onClick={() => {
                const payload = { tier: tier || null, picks: picks || [], customLabel: customLabel || "", note: note || "", updatedAt: new Date().toISOString() };
                onSave(payload);
                onClose();
              }}
              style={{
                border: "none",
                background: COLORS.blue,
                color: "white",
                borderRadius: 12,
                padding: "10px 12px",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              Guardar
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

