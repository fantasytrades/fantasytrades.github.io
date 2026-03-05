import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Fantasy Trade Board (GitHub Pages friendly)
 * Persistencia: JSON en /data/* dentro del repo, usando GitHub Contents API.
 * Requiere (en la raíz del repo):
 *   - data/users.json
 *   - data/league_teams.json
 *   - data/interests.json
 *
 * ENV (GitHub Pages / Vite):
 *   - VITE_GH_OWNER
 *   - VITE_GH_REPO
 *   - VITE_GH_BRANCH (ej: main)
 *   - VITE_GH_TOKEN (PAT con Contents: Read/Write)
 *
 * Nota: Esto es “inseguro” (token en frontend). OK para liga chica de amigos.
 */

/** -------------------- UI Theme -------------------- */
const COLORS = {
  bg: "#0b1220",
  card: "rgba(255,255,255,0.06)",
  card2: "rgba(255,255,255,0.08)",
  border: "rgba(255,255,255,0.14)",
  text: "rgba(255,255,255,0.92)",
  muted: "rgba(255,255,255,0.65)",
  accent: "#6ee7ff",
  accent2: "#a78bfa",
  good: "#34d399",
  warn: "#fbbf24",
  bad: "#fb7185",
  white: "#ffffff",
};

function GlobalStyles() {
  return (
    <style>{`
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
        background: radial-gradient(1200px 500px at 30% 0%, rgba(110,231,255,.16), transparent 60%),
                    radial-gradient(900px 500px at 70% 10%, rgba(167,139,250,.16), transparent 60%),
                    ${COLORS.bg};
        color: ${COLORS.text};
      }
      a { color: inherit; }
      .container { max-width: 1200px; margin: 0 auto; padding: 18px 14px 90px; }
      .row { display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
      .grid2 { display:grid; gap:14px; grid-template-columns: 1fr; }
      @media (min-width: 980px) { .grid2 { grid-template-columns: 1fr 1fr; } }
      .pill { padding: 6px 10px; border-radius: 999px; font-weight: 800; font-size: 12px; border: 1px solid ${COLORS.border}; background:${COLORS.card}; }
      .btn { border: 1px solid ${COLORS.border}; background:${COLORS.card2}; color:${COLORS.text}; padding:10px 12px; border-radius: 12px; font-weight: 900; cursor:pointer; }
      .btn:disabled { opacity:.5; cursor:not-allowed; }
      .btnGhost { border:1px dashed ${COLORS.border}; background: transparent; }
      .btnPrimary { border-color: rgba(110,231,255,.35); background: rgba(110,231,255,.14); }
      .btnBad { border-color: rgba(251,113,133,.35); background: rgba(251,113,133,.12); }
      .btnGood { border-color: rgba(52,211,153,.35); background: rgba(52,211,153,.12); }
      .input {
        width:100%;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid ${COLORS.border};
        background:${COLORS.card};
        color:${COLORS.text};
        outline: none;
      }
      .card {
        border: 1px solid ${COLORS.border};
        background: ${COLORS.card};
        border-radius: 18px;
        padding: 14px;
        box-shadow: 0 8px 30px rgba(0,0,0,.25);
      }
      .title { font-size: 22px; font-weight: 1000; letter-spacing: .2px; margin: 0; }
      .subtitle { margin: 2px 0 0; color:${COLORS.muted}; }
      .hr { height:1px; background:${COLORS.border}; margin: 12px 0; }
      .tabsBar {
        position: fixed;
        left: 0; right: 0; bottom: 0;
        background: rgba(5,10,20,.85);
        backdrop-filter: blur(10px);
        border-top: 1px solid ${COLORS.border};
        padding: 10px 12px;
        display:flex; justify-content:center;
      }
      .tabsInner { width:min(900px, 100%); display:flex; gap:10px; justify-content:space-between; }
      .tabBtn { flex:1; text-align:center; padding: 10px 12px; border-radius: 14px; border:1px solid ${COLORS.border}; background:${COLORS.card}; font-weight: 1000; cursor:pointer; }
      .tabBtnActive { border-color: rgba(110,231,255,.45); background: rgba(110,231,255,.16); }
      .small { font-size:12px; color:${COLORS.muted}; }
      .badge {
        display:inline-flex; align-items:center; gap:6px;
        padding: 6px 10px; border-radius: 999px; font-weight: 900; font-size: 12px;
        border: 1px solid ${COLORS.border}; background: ${COLORS.card};
      }
      .pos {
        width: 38px; text-align:center; padding: 6px 0; border-radius: 12px;
        font-weight: 1000; border: 1px solid ${COLORS.border};
      }
      .break { word-break: break-word; }
    `}</style>
  );
}

function Card({ children, style }) {
  return (
    <div className="card" style={style}>
      {children}
    </div>
  );
}
function Button({ children, variant = "default", ...props }) {
  const cls =
    "btn " +
    (variant === "primary" ? "btnPrimary" : variant === "ghost" ? "btnGhost" : variant === "bad" ? "btnBad" : variant === "good" ? "btnGood" : "");
  return (
    <button className={cls} {...props}>
      {children}
    </button>
  );
}
function Pill({ children, tone = "neutral" }) {
  const bg =
    tone === "good" ? "rgba(52,211,153,.16)" : tone === "bad" ? "rgba(251,113,133,.16)" : tone === "warn" ? "rgba(251,191,36,.16)" : COLORS.card;
  const bc =
    tone === "good" ? "rgba(52,211,153,.35)" : tone === "bad" ? "rgba(251,113,133,.35)" : tone === "warn" ? "rgba(251,191,36,.35)" : COLORS.border;
  return (
    <span className="pill" style={{ background: bg, borderColor: bc }}>
      {children}
    </span>
  );
}

function posColor(pos) {
  if (pos === "QB") return "rgba(248,113,113,.25)";
  if (pos === "RB") return "rgba(52,211,153,.22)";
  if (pos === "WR") return "rgba(96,165,250,.22)";
  if (pos === "TE") return "rgba(167,139,250,.22)";
  return "rgba(255,255,255,.10)";
}

/** -------------------- GitHub Persistence -------------------- */
const GH_OWNER = import.meta.env.VITE_GH_OWNER || "";
const GH_REPO = import.meta.env.VITE_GH_REPO || "";
const GH_BRANCH = import.meta.env.VITE_GH_BRANCH || "main";
const GH_TOKEN = import.meta.env.VITE_GH_TOKEN || "";

// archivos
const PATH_USERS = "data/users.json";
const PATH_TEAMS = "data/league_teams.json";
const PATH_INTERESTS = "data/interests.json";

// Cola global: 1 escritura a la vez (evita 409 por SHA viejo)
let ghWriteChain = Promise.resolve();
function ghEnqueueWrite(fn) {
  ghWriteChain = ghWriteChain.then(fn, fn);
  return ghWriteChain;
}

async function ghApi(path, options = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    ...(options.headers || {}),
  };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { ...options, headers });
  const txt = await res.text();
  let json;
  try {
    json = txt ? JSON.parse(txt) : null;
  } catch {
    json = { message: txt };
  }
  if (!res.ok) throw { status: res.status, body: json };
  return json;
}

async function ghGetFile(path) {
  const data = await ghApi(`/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${encodeURIComponent(GH_BRANCH)}`);
  // data.content base64
  const content = atob((data.content || "").replace(/\n/g, ""));
  return { sha: data.sha, json: content ? JSON.parse(content) : null };
}

async function ghPutJsonWithRetry(path, jsonObj, message, maxRetries = 4) {
  return ghEnqueueWrite(async () => {
    let attempt = 0;
    // siempre refrescar sha adentro de la cola
    while (attempt <= maxRetries) {
      try {
        const current = await ghGetFile(path);
        const body = {
          message: message || `update ${path}`,
          branch: GH_BRANCH,
          sha: current.sha,
          content: btoa(unescape(encodeURIComponent(JSON.stringify(jsonObj, null, 2)))),
        };
        const out = await ghApi(`/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        return out;
      } catch (e) {
        // 409 = sha mismatch / conflict
        if (e?.status === 409 && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt)));
          attempt += 1;
          continue;
        }
        throw e;
      }
    }
  });
}

/** -------------------- Domain models -------------------- */
const SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "BN"];
const SLOT_LIMITS = { QB: 1, RB: 2, WR: 1, TE: 1, FLEX: 3, BN: 21 };

const PLAYER_STATUS = ["AVAILABLE", "LISTENING", "NOT_AVAILABLE"];
const PLAYER_STATUS_LABEL = {
  AVAILABLE: "Disponible",
  LISTENING: "En escucha",
  NOT_AVAILABLE: "No disponible",
};
const PLAYER_STATUS_TONE = { AVAILABLE: "good", LISTENING: "warn", NOT_AVAILABLE: "bad" };

const INTEREST_LEVELS = ["LOW", "MEDIUM", "HIGH"];
const INTEREST_LABEL = { LOW: "Bajo", MEDIUM: "Medio", HIGH: "Alto" };
const INTEREST_TONE = { LOW: "neutral", MEDIUM: "warn", HIGH: "good" };

function nowISO() {
  return new Date().toISOString();
}

function buildPicks() {
  const picks = [];
  // 2026 1.01 .. 6.10
  for (let r = 1; r <= 6; r++) {
    for (let i = 1; i <= 10; i++) {
      const id = `2026-${r}.${String(i).padStart(2, "0")}`;
      picks.push({ id, label: `${r}.${String(i).padStart(2, "0")} 2026`, year: 2026, round: r, overall: i });
    }
  }
  // 2027/2028 rounds (sin pick number)
  for (const year of [2027, 2028]) {
    for (let r = 1; r <= 6; r++) {
      const id = `${year}-R${r}`;
      picks.push({ id, label: `${r}ra ${year}`.replace("1ra", "1era"), year, round: r });
    }
  }
  return picks;
}

function normalizePlayer(p) {
  // soporta distintos esquemas de /public/adp.json
  const id = String(p.id ?? p.player_id ?? p.pid ?? p.sleeper_id ?? p.name);
  const name = p.name ?? p.full_name ?? p.player ?? "Jugador";
  const pos = (p.pos ?? p.position ?? "").toUpperCase() || "FLEX";
  const team = (p.nfl ?? p.team ?? p.pro_team ?? "").toUpperCase() || "";
  return { id, name, pos: ["QB", "RB", "WR", "TE"].includes(pos) ? pos : "FLEX", team };
}

function findBestSlotForPlayer(team, playerPos) {
  const roster = team.roster || {};
  const counts = Object.fromEntries(SLOT_ORDER.map((s) => [s, (roster[s] || []).length]));
  const trySlot = (slot) => counts[slot] < (SLOT_LIMITS[slot] ?? 0);

  // prefer pos slot
  if (["QB", "RB", "WR", "TE"].includes(playerPos) && trySlot(playerPos)) return playerPos;
  // then FLEX
  if (trySlot("FLEX")) return "FLEX";
  // then BN
  if (trySlot("BN")) return "BN";
  return "BN";
}

function ensureTeamShape(t, user) {
  return {
    user_id: t?.user_id ?? user?.id ?? "",
    display_name: t?.display_name ?? user?.display_name ?? user?.email ?? "Usuario",
    team_name: t?.team_name ?? user?.team_name ?? "Mi equipo",
    team_status: t?.team_status ?? "Contendiente",
    roster: t?.roster ?? { QB: [], RB: [], WR: [], TE: [], FLEX: [], BN: [] },
    player_status: t?.player_status ?? {}, // {playerId: AVAILABLE|LISTENING|NOT_AVAILABLE}
    picks: t?.picks ?? [],
    updated_at: t?.updated_at ?? nowISO(),
  };
}

/** -------------------- App -------------------- */
export default function App() {
  const [bootError, setBootError] = useState("");

  // auth (simple)
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem("ftb_user");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [authEmail, setAuthEmail] = useState("");
  const [authName, setAuthName] = useState("");
  const [authTeamName, setAuthTeamName] = useState("");

  // data
  const [users, setUsers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [interests, setInterests] = useState([]);
  const [players, setPlayers] = useState([]);
  const picks = useMemo(() => buildPicks(), []);

  // ui
  const [tab, setTab] = useState("MY_TEAM"); // MY_TEAM | LEAGUE | INTERESTS
  const [toast, setToast] = useState("");
  const toastRef = useRef(null);

  // selection for league
  const [selectedLeagueUserId, setSelectedLeagueUserId] = useState("");

  useEffect(() => {
    if (!toast) return;
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(""), 2400);
  }, [toast]);

  // boot checks
  useEffect(() => {
    const missing = [];
    if (!GH_OWNER) missing.push("VITE_GH_OWNER");
    if (!GH_REPO) missing.push("VITE_GH_REPO");
    if (!GH_BRANCH) missing.push("VITE_GH_BRANCH");
    if (!GH_TOKEN) missing.push("VITE_GH_TOKEN");
    if (missing.length) {
      setBootError(`Faltan ENV: ${missing.join(", ")}`);
    } else {
      setBootError("");
    }
  }, []);

  // load players
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL || "/"}adp.json`, { cache: "no-store" });
        if (!res.ok) throw new Error("no adp");
        const json = await res.json();
        const list = Array.isArray(json) ? json : json?.players || json?.data || [];
        const norm = (list || []).map(normalizePlayer);
        if (!cancelled) setPlayers(norm);
      } catch {
        if (cancelled) return;
        // demo fallback
        setPlayers(
          [
            { id: "p1", name: "Ja'Marr Chase", pos: "WR", team: "CIN" },
            { id: "p2", name: "Bijan Robinson", pos: "RB", team: "ATL" },
            { id: "p3", name: "Justin Jefferson", pos: "WR", team: "MIN" },
            { id: "p4", name: "Jahmyr Gibbs", pos: "RB", team: "DET" },
            { id: "p5", name: "Travis Kelce", pos: "TE", team: "KC" },
            { id: "p6", name: "Josh Allen", pos: "QB", team: "BUF" },
          ].map(normalizePlayer)
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // load repo data
  useEffect(() => {
    if (bootError) return;
    (async () => {
      try {
        const [u, t, i] = await Promise.all([ghGetFile(PATH_USERS), ghGetFile(PATH_TEAMS), ghGetFile(PATH_INTERESTS)]);
        setUsers(Array.isArray(u.json) ? u.json : []);
        setTeams(Array.isArray(t.json) ? t.json : []);
        setInterests(Array.isArray(i.json) ? i.json : []);
      } catch (e) {
        setBootError(
          `No pude leer data del repo: ${e?.body?.message || e?.message || "error"}. Asegurate de que existan /data/users.json, /data/league_teams.json, /data/interests.json`
        );
      }
    })();
  }, [bootError]);

  // derived maps
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const teamsByUser = useMemo(() => new Map(teams.map((t) => [t.user_id, t])), [teams]);
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const pickById = useMemo(() => new Map(picks.map((p) => [p.id, p])), [picks]);

  // ensure selected league user
  useEffect(() => {
    if (!user) return;
    const others = teams.filter((t) => t.user_id !== user.id);
    if (!selectedLeagueUserId && others.length) setSelectedLeagueUserId(others[0].user_id);
    if (selectedLeagueUserId && !others.some((x) => x.user_id === selectedLeagueUserId)) {
      setSelectedLeagueUserId(others[0]?.user_id || "");
    }
  }, [teams, user?.id]);

  function persistLocal() {
    localStorage.setItem("ftb_cache_users", JSON.stringify(users));
    localStorage.setItem("ftb_cache_teams", JSON.stringify(teams));
    localStorage.setItem("ftb_cache_interests", JSON.stringify(interests));
  }

  async function saveAll(nextUsers, nextTeams, nextInterests, reason = "save") {
    // optimistic update
    setUsers(nextUsers);
    setTeams(nextTeams);
    setInterests(nextInterests);
    // local cache
    try {
      persistLocal();
    } catch {}
    // remote
    try {
      await Promise.all([
        ghPutJsonWithRetry(PATH_USERS, nextUsers, `${reason}: users`),
        ghPutJsonWithRetry(PATH_TEAMS, nextTeams, `${reason}: teams`),
        ghPutJsonWithRetry(PATH_INTERESTS, nextInterests, `${reason}: interests`),
      ]);
      setToast("Guardado ✅");
    } catch (e) {
      setBootError(
        `No pude guardar: ${JSON.stringify({
          message: e?.body?.message || e?.message || "error",
          status: e?.status,
        })}`
      );
    }
  }

  async function loginOrSignup() {
    const email = authEmail.trim().toLowerCase();
    if (!email) return;
    const existing = users.find((u) => u.email === email);
    if (existing) {
      setUser(existing);
      localStorage.setItem("ftb_user", JSON.stringify(existing));
      setToast("Sesión iniciada ✅");
      return;
    }
    const id = `u_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const newUser = {
      id,
      email,
      display_name: authName.trim() || email.split("@")[0],
      team_name: authTeamName.trim() || "Mi equipo",
      created_at: nowISO(),
    };
    const nextUsers = [...users, newUser];
    const myTeam = ensureTeamShape(null, newUser);
    const nextTeams = [...teams.filter((t) => t.user_id !== id), myTeam];
    const nextInterests = [...interests];
    await saveAll(nextUsers, nextTeams, nextInterests, "signup");
    setUser(newUser);
    localStorage.setItem("ftb_user", JSON.stringify(newUser));
    setToast("Cuenta creada ✅");
  }

  function logout() {
    setUser(null);
    localStorage.removeItem("ftb_user");
  }

  if (!user) {
    return (
      <>
        <GlobalStyles />
        <div className="container">
          <Card style={{ maxWidth: 520, margin: "40px auto" }}>
            <h1 className="title">Fantasy Trade Board</h1>
            <p className="subtitle">Login simple por email (sin Supabase). Guarda en GitHub.</p>
            {bootError ? (
              <div style={{ marginTop: 10, color: COLORS.bad, fontWeight: 900 }}>{bootError}</div>
            ) : (
              <div className="small" style={{ marginTop: 10 }}>
                Repo: {GH_OWNER}/{GH_REPO} · Branch: {GH_BRANCH}
              </div>
            )}

            <div className="hr" />

            <div style={{ display: "grid", gap: 10 }}>
              <input className="input" placeholder="tu@email.com" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} />
              <input className="input" placeholder="Nombre (opcional)" value={authName} onChange={(e) => setAuthName(e.target.value)} />
              <input className="input" placeholder="Nombre del equipo (opcional)" value={authTeamName} onChange={(e) => setAuthTeamName(e.target.value)} />
              <Button variant="primary" onClick={loginOrSignup} disabled={!!bootError}>
                Entrar
              </Button>
              <div className="small">
                Tip: si ya existe ese email en <code>data/users.json</code>, hace login; si no, crea usuario y su equipo.
              </div>
            </div>
          </Card>
        </div>
      </>
    );
  }

  const meTeam = ensureTeamShape(teamsByUser.get(user.id), user);
  const otherTeams = teams.filter((t) => t.user_id !== user.id);

  // update my team meta
  async function updateMyTeamMeta(patch) {
    const next = { ...meTeam, ...patch, updated_at: nowISO() };
    const nextTeams = [...teams.filter((t) => t.user_id !== user.id), next];
    await saveAll(users, nextTeams, interests, "team meta");
  }

  async function addPlayerToMyTeam(playerId) {
    const p = playerById.get(playerId);
    if (!p) return;
    const next = ensureTeamShape(meTeam, user);
    // avoid duplicates
    const allIds = SLOT_ORDER.flatMap((s) => next.roster[s] || []);
    if (allIds.includes(playerId)) return;

    const slot = findBestSlotForPlayer(next, p.pos);
    next.roster = { ...next.roster, [slot]: [...(next.roster[slot] || []), playerId] };
    next.player_status = { ...next.player_status, [playerId]: next.player_status[playerId] || "AVAILABLE" };
    next.updated_at = nowISO();

    const nextTeams = [...teams.filter((t) => t.user_id !== user.id), next];
    await saveAll(users, nextTeams, interests, "add player");
  }

  async function movePlayerSlot(playerId, toSlot) {
    const next = ensureTeamShape(meTeam, user);
    // remove from all slots
    const roster = {};
    for (const s of SLOT_ORDER) roster[s] = (next.roster[s] || []).filter((id) => id !== playerId);
    // add to target if capacity (soft, allow over but warn? we will cap)
    const currentCount = roster[toSlot].length;
    if (currentCount >= (SLOT_LIMITS[toSlot] ?? 999)) {
      setToast("Ese slot está lleno");
      return;
    }
    roster[toSlot] = [...roster[toSlot], playerId];
    next.roster = roster;
    next.updated_at = nowISO();

    const nextTeams = [...teams.filter((t) => t.user_id !== user.id), next];
    await saveAll(users, nextTeams, interests, "move player");
  }

  async function cyclePlayerStatus(playerId) {
    const next = ensureTeamShape(meTeam, user);
    const cur = next.player_status?.[playerId] || "AVAILABLE";
    const idx = PLAYER_STATUS.indexOf(cur);
    const nextStatus = PLAYER_STATUS[(idx + 1) % PLAYER_STATUS.length];
    next.player_status = { ...(next.player_status || {}), [playerId]: nextStatus };
    next.updated_at = nowISO();
    const nextTeams = [...teams.filter((t) => t.user_id !== user.id), next];
    await saveAll(users, nextTeams, interests, "player status");
  }

  async function removePlayerFromMyTeam(playerId) {
    const next = ensureTeamShape(meTeam, user);
    const roster = {};
    for (const s of SLOT_ORDER) roster[s] = (next.roster[s] || []).filter((id) => id !== playerId);
    next.roster = roster;
    const ps = { ...(next.player_status || {}) };
    delete ps[playerId];
    next.player_status = ps;
    next.updated_at = nowISO();
    const nextTeams = [...teams.filter((t) => t.user_id !== user.id), next];
    await saveAll(users, nextTeams, interests, "remove player");
  }

  async function addPickToMyTeam(pickId) {
    const next = ensureTeamShape(meTeam, user);
    if ((next.picks || []).includes(pickId)) return;
    next.picks = [...(next.picks || []), pickId];
    next.updated_at = nowISO();
    const nextTeams = [...teams.filter((t) => t.user_id !== user.id), next];
    await saveAll(users, nextTeams, interests, "add pick");
  }

  async function removePickFromMyTeam(pickId) {
    const next = ensureTeamShape(meTeam, user);
    next.picks = (next.picks || []).filter((x) => x !== pickId);
    next.updated_at = nowISO();
    const nextTeams = [...teams.filter((t) => t.user_id !== user.id), next];
    await saveAll(users, nextTeams, interests, "remove pick");
  }

  async function setInterest(toUserId, assetType, assetId, level) {
    const existingIdx = interests.findIndex(
      (x) => x.from_user_id === user.id && x.to_user_id === toUserId && x.asset_type === assetType && x.asset_id === assetId
    );
    const nextInterests = [...interests];
    const record = {
      from_user_id: user.id,
      to_user_id: toUserId,
      asset_type: assetType,
      asset_id: assetId,
      level,
      updated_at: nowISO(),
    };
    if (existingIdx >= 0) nextInterests[existingIdx] = { ...nextInterests[existingIdx], ...record };
    else nextInterests.push(record);
    await saveAll(users, teams, nextInterests, "interest");
  }

  const incomingInterests = useMemo(
    () => interests.filter((x) => x.to_user_id === user.id),
    [interests, user.id]
  );
  const myInterests = useMemo(
    () => interests.filter((x) => x.from_user_id === user.id),
    [interests, user.id]
  );

  return (
    <>
      <GlobalStyles />
      <div className="container">
        <TopBar user={user} onLogout={logout} />

        {bootError ? (
          <Card style={{ borderColor: "rgba(251,113,133,.45)", background: "rgba(251,113,133,.10)" }}>
            <div style={{ fontWeight: 1000, color: COLORS.bad }}>Error</div>
            <div style={{ marginTop: 8 }} className="break">
              {bootError}
            </div>
            <div className="hr" />
            <div className="small">Checklist:</div>
            <ul className="small" style={{ marginTop: 6 }}>
              <li>Definí VITE_GH_OWNER / VITE_GH_REPO / VITE_GH_BRANCH</li>
              <li>Definí VITE_GH_TOKEN con permisos de lectura/escritura de Contents</li>
              <li>Existencia de /data/users.json, /data/league_teams.json, /data/interests.json</li>
            </ul>
            <Button onClick={() => setBootError("")}>Cerrar</Button>
          </Card>
        ) : null}

        {/* Header info + quick edit */}
        <Card>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="title">{user.display_name || user.email}</div>
              <div className="subtitle">{meTeam.team_name} · Formato: 1 QB · 2 RB · 1 WR · 1 TE · 3 FLEX · 21 BN</div>
            </div>
            <div className="row">
              <input className="input" style={{ width: 240 }} value={meTeam.display_name} onChange={(e) => updateMyTeamMeta({ display_name: e.target.value })} />
              <input className="input" style={{ width: 240 }} value={meTeam.team_name} onChange={(e) => updateMyTeamMeta({ team_name: e.target.value })} />
              <select
                className="input"
                style={{ width: 190 }}
                value={meTeam.team_status || "Contendiente"}
                onChange={(e) => updateMyTeamMeta({ team_status: e.target.value })}
              >
                <option>Contendiente</option>
                <option>Reconstrucción</option>
                <option>Medio</option>
              </select>
            </div>
          </div>
        </Card>

        <div style={{ height: 14 }} />

        {tab === "MY_TEAM" ? (
          <MyTeamTab
            me={user}
            team={meTeam}
            players={players}
            picks={picks}
            playerById={playerById}
            pickById={pickById}
            onAddPlayer={addPlayerToMyTeam}
            onMovePlayer={movePlayerSlot}
            onCycleStatus={cyclePlayerStatus}
            onRemovePlayer={removePlayerFromMyTeam}
            onAddPick={addPickToMyTeam}
            onRemovePick={removePickFromMyTeam}
          />
        ) : null}

        {tab === "LEAGUE" ? (
          <LeagueTab
            me={user}
            teams={otherTeams}
            selectedUserId={selectedLeagueUserId}
            onSelectUserId={setSelectedLeagueUserId}
            teamsByUser={teamsByUser}
            playerById={playerById}
            pickById={pickById}
            myInterests={myInterests}
            onSetInterest={setInterest}
          />
        ) : null}

        {tab === "INTERESTS" ? (
          <InterestsTab
            me={user}
            myInterests={myInterests}
            incomingInterests={incomingInterests}
            teamsByUser={teamsByUser}
            usersById={usersById}
            playerById={playerById}
            pickById={pickById}
          />
        ) : null}
      </div>

      {toast ? (
        <div
          style={{
            position: "fixed",
            right: 14,
            top: 14,
            padding: "10px 12px",
            borderRadius: 14,
            border: `1px solid ${COLORS.border}`,
            background: "rgba(0,0,0,.55)",
            backdropFilter: "blur(10px)",
            fontWeight: 900,
          }}
        >
          {toast}
        </div>
      ) : null}

      <BottomTabs tab={tab} setTab={setTab} />
    </>
  );
}

/** -------------------- Top / Tabs -------------------- */
function TopBar({ user, onLogout }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
      <div className="row">
        <div style={{ fontWeight: 1000, fontSize: 18 }}>Fantasy Trade Board</div>
      </div>
      <div className="row">
        <span className="badge">{user.email}</span>
        <Button variant="ghost" onClick={onLogout}>
          Salir
        </Button>
      </div>
    </div>
  );
}

function BottomTabs({ tab, setTab }) {
  const items = [
    { id: "MY_TEAM", label: "Mi equipo" },
    { id: "LEAGUE", label: "Liga" },
    { id: "INTERESTS", label: "Intereses" },
  ];
  return (
    <div className="tabsBar">
      <div className="tabsInner">
        {items.map((it) => (
          <button
            key={it.id}
            className={"tabBtn " + (tab === it.id ? "tabBtnActive" : "")}
            onClick={() => setTab(it.id)}
            type="button"
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** -------------------- My Team Tab -------------------- */
function MyTeamTab({
  team,
  players,
  picks,
  playerById,
  pickById,
  onAddPlayer,
  onMovePlayer,
  onCycleStatus,
  onRemovePlayer,
  onAddPick,
  onRemovePick,
}) {
  const [leftMode, setLeftMode] = useState("PLAYERS"); // PLAYERS | PICKS
  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");

  const myPlayerIds = useMemo(() => SLOT_ORDER.flatMap((s) => team.roster?.[s] || []), [team]);

  const filteredPlayers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return players
      .filter((p) => (posFilter === "ALL" ? true : p.pos === posFilter))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      .slice(0, 200);
  }, [players, search, posFilter]);

  const myPicks = useMemo(() => (team.picks || []).map((id) => pickById.get(id) || { id, label: id }), [team.picks, pickById]);

  return (
    <div className="grid2">
      <Card>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row" style={{ gap: 10 }}>
            <button className={"btn " + (leftMode === "PLAYERS" ? "btnPrimary" : "")} onClick={() => setLeftMode("PLAYERS")}>
              Jugadores
            </button>
            <button className={"btn " + (leftMode === "PICKS" ? "btnPrimary" : "")} onClick={() => setLeftMode("PICKS")}>
              Picks
            </button>
          </div>
        </div>

        {leftMode === "PLAYERS" ? (
          <>
            <div style={{ marginTop: 12 }} className="row">
              <input className="input" placeholder="Buscar jugador por nombre..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              {["ALL", "QB", "RB", "WR", "TE", "FLEX"].map((p) => (
                <button
                  key={p}
                  className={"btn " + (posFilter === p ? "btnPrimary" : "")}
                  onClick={() => setPosFilter(p)}
                  style={{ padding: "8px 10px", borderRadius: 999 }}
                >
                  {p === "ALL" ? "Todos" : p}
                </button>
              ))}
            </div>

            <div style={{ marginTop: 12, display: "grid", gap: 10, maxHeight: 560, overflow: "auto", paddingRight: 4 }}>
              {filteredPlayers.map((p) => {
                const already = myPlayerIds.includes(p.id);
                return (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: 12,
                      borderRadius: 16,
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.card2,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div className="pos" style={{ background: posColor(p.pos) }}>
                        {p.pos}
                      </div>
                      <div>
                        <div style={{ fontWeight: 1000 }}>{p.name}</div>
                        <div className="small">
                          {p.team ? `${p.team}` : ""} {p.team ? "·" : ""} {p.id}
                        </div>
                      </div>
                    </div>
                    <div>
                      <Button variant={already ? "ghost" : "primary"} disabled={already} onClick={() => onAddPlayer(p.id)}>
                        {already ? "Agregado" : "+ Agregar"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: 12 }} className="small">
              2026: 1.01 a 6.10 (10 picks por ronda). 2027/2028: por ronda.
            </div>
            <div style={{ marginTop: 10, display: "grid", gap: 10, maxHeight: 560, overflow: "auto", paddingRight: 4 }}>
              {picks.map((p) => {
                const already = (team.picks || []).includes(p.id);
                return (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: 12,
                      borderRadius: 16,
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.card2,
                    }}
                  >
                    <div className="break" style={{ fontWeight: 900 }}>
                      {p.label}
                    </div>
                    <Button variant={already ? "ghost" : "primary"} disabled={already} onClick={() => onAddPick(p.id)}>
                      {already ? "Agregado" : "+ Agregar"}
                    </Button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

      <Card>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Mi equipo (slots)</h2>
          <div className="small">Tocá el botón de estado: Disponible → En escucha → No disponible</div>
        </div>

        <div style={{ marginTop: 12, display: "grid", gap: 14 }}>
          {SLOT_ORDER.map((slot) => {
            const ids = team.roster?.[slot] || [];
            return (
              <div key={slot} style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 1000 }}>{slot}</div>
                  <div className="small">
                    {ids.length}/{SLOT_LIMITS[slot]}
                  </div>
                </div>

                {ids.length === 0 ? <div className="small" style={{ marginTop: 8 }}>Vacío</div> : null}

                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  {ids.map((playerId) => {
                    const p = playerById.get(playerId) || { id: playerId, name: `PLAYER ${playerId}`, pos: "FLEX", team: "" };
                    const status = team.player_status?.[playerId] || "AVAILABLE";
                    return (
                      <div
                        key={playerId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                          padding: 12,
                          borderRadius: 16,
                          border: `1px solid ${COLORS.border}`,
                          background: "rgba(0,0,0,.18)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <div className="pos" style={{ background: posColor(p.pos) }}>
                            {p.pos}
                          </div>
                          <div>
                            <div style={{ fontWeight: 1000 }}>{p.name}</div>
                            <div className="small">{p.team ? `${p.team} · ` : ""}{p.id}</div>
                          </div>
                        </div>

                        <div className="row" style={{ gap: 10 }}>
                          <select
                            className="input"
                            style={{ width: 120 }}
                            value={slot}
                            onChange={(e) => onMovePlayer(playerId, e.target.value)}
                          >
                            {SLOT_ORDER.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>

                          <Button variant="ghost" onClick={() => onCycleStatus(playerId)}>
                            <Pill tone={PLAYER_STATUS_TONE[status]}>{PLAYER_STATUS_LABEL[status]}</Pill>
                          </Button>

                          <Button variant="bad" onClick={() => onRemovePlayer(playerId)}>
                            ✕
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div style={{ fontWeight: 1000 }}>Picks</div>
              <div className="small">{myPicks.length}</div>
            </div>
            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              {myPicks.length === 0 ? <div className="small">No agregaste picks.</div> : null}
              {myPicks.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    border: `1px solid ${COLORS.border}`,
                    background: "rgba(0,0,0,.18)",
                  }}
                >
                  <div style={{ fontWeight: 900 }}>{p.label}</div>
                  <Button variant="bad" onClick={() => onRemovePick(p.id)}>
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** -------------------- League Tab -------------------- */
function LeagueTab({ me, teams, selectedUserId, onSelectUserId, teamsByUser, playerById, pickById, myInterests, onSetInterest }) {
  const selectedTeam = selectedUserId ? teamsByUser.get(selectedUserId) : null;

  const interestFor = (toUserId, assetType, assetId) =>
    myInterests.find((x) => x.to_user_id === toUserId && x.asset_type === assetType && x.asset_id === assetId);

  const setLevel = (toUserId, assetType, assetId, level) => onSetInterest(toUserId, assetType, assetId, level);

  return (
    <div className="grid2">
      <Card>
        <h2 style={{ margin: 0 }}>Equipos</h2>
        <div className="small" style={{ marginTop: 6 }}>
          Elegí un equipo para ver su roster y marcar tu interés.
        </div>

        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {teams.length === 0 ? <div className="small">No hay otros equipos cargados.</div> : null}
          {teams.map((t) => {
            const active = t.user_id === selectedUserId;
            const countPlayers = SLOT_ORDER.reduce((acc, s) => acc + (t.roster?.[s]?.length || 0), 0);
            return (
              <button
                key={t.user_id}
                className={"btn " + (active ? "btnPrimary" : "")}
                style={{ textAlign: "left", padding: 12, borderRadius: 16 }}
                onClick={() => onSelectUserId(t.user_id)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 1000 }}>{t.display_name}</div>
                    <div className="small">{t.team_name || ""}</div>
                    <div className="small">
                      {t.team_status || "—"} · Jugadores: {countPlayers} · Picks: {(t.picks || []).length}
                    </div>
                  </div>
                  <div>{active ? <Pill tone="good">Seleccionado</Pill> : <Pill>Ver</Pill>}</div>
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Roster</h2>
          {selectedTeam ? <Pill>{selectedTeam.team_status || "—"}</Pill> : null}
        </div>

        {!selectedTeam ? (
          <div className="small" style={{ marginTop: 10 }}>
            Elegí un equipo de la izquierda.
          </div>
        ) : (
          <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
            <div style={{ fontSize: 18, fontWeight: 1000 }}>
              {selectedTeam.display_name} {selectedTeam.team_name ? `— ${selectedTeam.team_name}` : ""}
            </div>

            {/* Players */}
            <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
              <h3 style={{ margin: 0 }}>Jugadores</h3>
              <div className="small" style={{ marginTop: 6 }}>
                Marcá interés: Bajo / Medio / Alto
              </div>

              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {SLOT_ORDER.flatMap((slot) => (selectedTeam.roster?.[slot] || []).map((id) => ({ slot, id }))).map(({ slot, id }) => {
                  const p = playerById.get(id) || { id, name: `PLAYER ${id}`, pos: "FLEX", team: "" };
                  const avail = selectedTeam.player_status?.[id] || "AVAILABLE";
                  const cur = interestFor(selectedTeam.user_id, "PLAYER", id)?.level || "";
                  return (
                    <div
                      key={`${slot}-${id}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        padding: 12,
                        borderRadius: 16,
                        border: `1px solid ${COLORS.border}`,
                        background: "rgba(0,0,0,.18)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div className="pos" style={{ background: posColor(p.pos) }}>{p.pos}</div>
                        <div>
                          <div style={{ fontWeight: 1000 }}>{p.name}</div>
                          <div className="small">
                            {p.team ? `${p.team} · ` : ""}{slot} · <Pill tone={PLAYER_STATUS_TONE[avail]}>{PLAYER_STATUS_LABEL[avail]}</Pill>
                          </div>
                        </div>
                      </div>

                      <div className="row" style={{ gap: 8 }}>
                        {INTEREST_LEVELS.map((lvl) => (
                          <button
                            key={lvl}
                            className={"btn " + (cur === lvl ? "btnPrimary" : "")}
                            onClick={() => setLevel(selectedTeam.user_id, "PLAYER", id, lvl)}
                            style={{ padding: "8px 10px", borderRadius: 999 }}
                          >
                            {INTEREST_LABEL[lvl]}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {SLOT_ORDER.every((s) => (selectedTeam.roster?.[s] || []).length === 0) ? (
                  <div className="small">Este equipo no cargó jugadores.</div>
                ) : null}
              </div>
            </div>

            {/* Picks */}
            <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
              <h3 style={{ margin: 0 }}>Picks</h3>
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {(selectedTeam.picks || []).map((id) => {
                  const p = pickById.get(id) || { id, label: id };
                  const cur = interestFor(selectedTeam.user_id, "PICK", id)?.level || "";
                  return (
                    <div
                      key={id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        padding: 12,
                        borderRadius: 16,
                        border: `1px solid ${COLORS.border}`,
                        background: "rgba(0,0,0,.18)",
                      }}
                    >
                      <div style={{ fontWeight: 900 }}>{p.label}</div>
                      <div className="row" style={{ gap: 8 }}>
                        {INTEREST_LEVELS.map((lvl) => (
                          <button
                            key={lvl}
                            className={"btn " + (cur === lvl ? "btnPrimary" : "")}
                            onClick={() => setLevel(selectedTeam.user_id, "PICK", id, lvl)}
                            style={{ padding: "8px 10px", borderRadius: 999 }}
                          >
                            {INTEREST_LABEL[lvl]}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {(selectedTeam.picks || []).length === 0 ? <div className="small">Este equipo no cargó picks.</div> : null}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/** -------------------- Interests Tab -------------------- */
function InterestsTab({ me, myInterests, incomingInterests, teamsByUser, usersById, playerById, pickById }) {
  const left = useMemo(() => {
    // lo que me interesa (yo -> otros)
    return myInterests
      .map((r) => {
        const ownerTeam = teamsByUser.get(r.to_user_id);
        const ownerName = ownerTeam?.display_name || usersById.get(r.to_user_id)?.display_name || r.to_user_id;
        const assetLabel =
          r.asset_type === "PLAYER"
            ? playerById.get(r.asset_id)?.name || `PLAYER ${r.asset_id}`
            : pickById.get(r.asset_id)?.label || r.asset_id;
        return { ...r, ownerName, assetLabel };
      })
      .sort((a, b) => INTEREST_LEVELS.indexOf(b.level) - INTEREST_LEVELS.indexOf(a.level));
  }, [myInterests, teamsByUser, usersById, playerById, pickById]);

  const right = useMemo(() => {
    // interesados en mi equipo (otros -> yo)
    return incomingInterests
      .map((r) => {
        const from = usersById.get(r.from_user_id);
        const fromName = from?.display_name || from?.email || r.from_user_id;
        const assetLabel =
          r.asset_type === "PLAYER"
            ? playerById.get(r.asset_id)?.name || `PLAYER ${r.asset_id}`
            : pickById.get(r.asset_id)?.label || r.asset_id;
        return { ...r, fromName, assetLabel };
      })
      .sort((a, b) => INTEREST_LEVELS.indexOf(b.level) - INTEREST_LEVELS.indexOf(a.level));
  }, [incomingInterests, usersById, playerById, pickById]);

  return (
    <div className="grid2">
      <Card>
        <h2 style={{ margin: 0 }}>Lo que me interesa</h2>
        <div className="small" style={{ marginTop: 6 }}>
          Jugadores/picks que marcaste en Liga.
        </div>
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {left.length === 0 ? <div className="small">Todavía no marcaste intereses.</div> : null}
          {left.map((r) => (
            <div
              key={`${r.to_user_id}-${r.asset_type}-${r.asset_id}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: 12,
                borderRadius: 16,
                border: `1px solid ${COLORS.border}`,
                background: "rgba(0,0,0,.18)",
              }}
            >
              <div>
                <div style={{ fontWeight: 1000 }}>{r.assetLabel}</div>
                <div className="small">Dueño: {r.ownerName}</div>
              </div>
              <Pill tone={INTEREST_TONE[r.level]}>{INTEREST_LABEL[r.level]}</Pill>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h2 style={{ margin: 0 }}>Otros interesados en mi equipo</h2>
        <div className="small" style={{ marginTop: 6 }}>
          Intereses que otros marcaron sobre tus assets.
        </div>
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {right.length === 0 ? <div className="small">Nadie marcó intereses sobre tu equipo (todavía).</div> : null}
          {right.map((r) => (
            <div
              key={`${r.from_user_id}-${r.asset_type}-${r.asset_id}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: 12,
                borderRadius: 16,
                border: `1px solid ${COLORS.border}`,
                background: "rgba(0,0,0,.18)",
              }}
            >
              <div>
                <div style={{ fontWeight: 1000 }}>{r.assetLabel}</div>
                <div className="small">Interesado: {r.fromName}</div>
              </div>
              <Pill tone={INTEREST_TONE[r.level]}>{INTEREST_LABEL[r.level]}</Pill>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
