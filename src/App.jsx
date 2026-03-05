import { useEffect, useMemo, useState } from "react";

/**
 * Fantasy Trades — App.jsx (stable + conflict-proof)
 *
 * Persistencia GitHub:
 *  - data/users.json
 *  - data/interests.json
 *  - data/teams/<user_id>.json  (1 file por usuario)
 *
 * Fallback legacy (solo lectura):
 *  - data/league_teams.json
 *
 * ENV:
 *  VITE_GH_OWNER, VITE_GH_REPO, VITE_GH_BRANCH, VITE_GH_TOKEN
 */

const GH_OWNER = import.meta.env.VITE_GH_OWNER;
const GH_REPO = import.meta.env.VITE_GH_REPO;
const GH_BRANCH = import.meta.env.VITE_GH_BRANCH || "main";
const GH_TOKEN = import.meta.env.VITE_GH_TOKEN;

const GH_API = "https://api.github.com";
const PATH_USERS = "data/users.json";
const PATH_INTERESTS = "data/interests.json";

const TEAMS_DIR = "data/teams";
const PATH_TEAMS_LEGACY = "data/league_teams.json"; // fallback lectura

const LEAGUE_SIZE = 10;

// Slots: 1 QB, 2 RB, 1 WR, 1 TE, 3 FLEX, 21 BN
const SLOT_LIMITS = [
  { key: "QB", label: "QB", limit: 1, accepts: ["QB"] },
  { key: "RB", label: "RB", limit: 2, accepts: ["RB"] },
  { key: "WR", label: "WR", limit: 1, accepts: ["WR"] },
  { key: "TE", label: "TE", limit: 1, accepts: ["TE"] },
  { key: "FLEX", label: "FLEX", limit: 3, accepts: ["RB", "WR", "TE"] },
  { key: "BENCH", label: "BN", limit: 21, accepts: ["QB", "RB", "WR", "TE"] },
];

// Estado de disponibilidad (dueño del asset)
const STATUS_CYCLE = ["AVAILABLE", "LISTENING", "NOT_AVAILABLE"];
const STATUS_LABEL = {
  AVAILABLE: "Disponible",
  LISTENING: "En escucha",
  NOT_AVAILABLE: "No disponible",
};

// Intereses (usuario mirando assets ajenos)
const INTEREST_LABEL = { NONE: "—", LOW: "Bajo", MEDIUM: "Medio", HIGH: "Alto" };

// ---------- helpers ----------
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
function uid(prefix = "user") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
function normPos(pos) {
  const p = String(pos || "").toUpperCase();
  if (["QB", "RB", "WR", "TE"].includes(p)) return p;
  return p || "?";
}
function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] || "" : parts[0]?.[1] || "";
  return (a + b).toUpperCase();
}
function cycleStatus(curr) {
  const i = STATUS_CYCLE.indexOf(curr);
  return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length];
}

// ---------- picks ----------
function pickCatalog() {
  const out = [];
  for (let rnd = 1; rnd <= 6; rnd++) {
    for (let slot = 1; slot <= LEAGUE_SIZE; slot++) {
      const id = `2026-${rnd}.${String(slot).padStart(2, "0")}`;
      out.push({ id, label: `${rnd}.${String(slot).padStart(2, "0")} 2026` });
    }
  }
  const future = (year) => {
    for (let rnd = 1; rnd <= 6; rnd++) {
      const suf =
        rnd === 1 ? "1era" : rnd === 2 ? "2da" : rnd === 3 ? "3era" : rnd === 4 ? "4ta" : rnd === 5 ? "5ta" : "6ta";
      out.push({ id: `${year}-${rnd}`, label: `${suf} ${year}` });
    }
  };
  future(2027);
  future(2028);
  return out;
}
const PICKS = pickCatalog();
const PICK_LABEL = new Map(PICKS.map((p) => [String(p.id), p.label]));

// ---------- github api ----------
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
async function ghError(res) {
  const text = await res.text();
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.message ? String(j.message) : text;
  } catch {}
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
    const e = await ghError(res);
    e.code = 409;
    throw e;
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
  const txt = JSON.stringify(data, null, 2) + "\n";
  return ghPutFile(path, txt, sha, message);
}

// serializa escrituras en esta pestaña
let ghWriteQueue = Promise.resolve();
function ghEnqueueWrite(fn) {
  ghWriteQueue = ghWriteQueue.then(fn, fn);
  return ghWriteQueue;
}

// retry para archivos compartidos (users/interests)
async function ghPutJsonWithRetry(path, mutator, label) {
  return ghEnqueueWrite(async () => {
    const MAX = 10;
    for (let attempt = 0; attempt < MAX; attempt++) {
      const { data, sha } = await ghGetJson(path, []);
      const arr = Array.isArray(data) ? data : [];
      const next = mutator(arr);
      try {
        await ghPutJson(path, next, sha, label);
        return next;
      } catch (e) {
        if (e?.status === 409 || e?.code === 409) {
          const ms = 140 + attempt * 220;
          await new Promise((r) => setTimeout(r, ms));
          continue;
        }
        throw e;
      }
    }
    throw new Error(`No se pudo guardar (muchos 409) en ${path}`);
  });
}

// listar carpeta
async function ghListDir(path) {
  const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw await ghError(res);
  const j = await res.json();
  return Array.isArray(j) ? j : [];
}

// team file helpers
async function ghGetTeamFile(userId) {
  return ghGetJson(`${TEAMS_DIR}/${userId}.json`, null);
}
async function ghPutTeamFile(userId, teamObj, sha, message) {
  const txt = JSON.stringify(teamObj, null, 2) + "\n";
  return ghPutFile(`${TEAMS_DIR}/${userId}.json`, txt, sha, message);
}

// retry para tu team file (soluciona 409 en tu propio archivo)
async function ghPutTeamWithRetry(userId, mutator, label) {
  return ghEnqueueWrite(async () => {
    const MAX = 10;
    for (let attempt = 0; attempt < MAX; attempt++) {
      const { data: curr, sha } = await ghGetTeamFile(userId);

      const base = normalizeTeamRow(
        curr || {
          user_id: userId,
          display_name: "",
          team_name: "",
          team_status: "Contendiendo",
          roster: [],
          picks: [],
          updated_at: nowIso(),
        }
      );

      const next = normalizeTeamRow(mutator({ ...base, updated_at: nowIso() }));

      try {
        await ghPutTeamFile(userId, next, sha || null, label);
        return next;
      } catch (e) {
        if (e?.status === 409 || e?.code === 409) {
          const ms = 140 + attempt * 220;
          await new Promise((r) => setTimeout(r, ms));
          continue;
        }
        throw e;
      }
    }
    throw new Error(`No se pudo guardar: demasiados 409 en data/teams/${userId}.json`);
  });
}

// ---------- normalize schema ----------
function normalizeTeamRow(row) {
  const out = { ...row };

  const roster = Array.isArray(row?.roster) ? row.roster : [];
  out.roster = roster
    .map((x) => {
      if (!x) return null;
      if (typeof x === "string" || typeof x === "number") {
        const id = String(x);
        return { id, name: `Jugador ${id}`, pos: "?", nfl: "", status: "AVAILABLE" };
      }
      if (typeof x === "object") {
        const id = x.id != null ? String(x.id) : x.player_id != null ? String(x.player_id) : "";
        if (!id) return null;
        return {
          id,
          name: x.name || x.player_name || `Jugador ${id}`,
          pos: normPos(x.pos || x.position || x.player_pos || "?"),
          nfl: x.nfl || x.team || x.player_team || "",
          status: x.status || x.availability || "AVAILABLE",
        };
      }
      return null;
    })
    .filter(Boolean);

  const picks = Array.isArray(row?.picks) ? row.picks : [];
  out.picks = picks
    .map((x) => {
      if (!x) return null;
      if (typeof x === "string" || typeof x === "number") {
        const id = String(x);
        return { id, label: PICK_LABEL.get(id) || id, status: "AVAILABLE" };
      }
      if (typeof x === "object") {
        const id = String(x.id || x.pick_id || "");
        if (!id) return null;
        return { id, label: x.label || PICK_LABEL.get(id) || id, status: x.status || "AVAILABLE" };
      }
      return null;
    })
    .filter(Boolean);

  // availability viejo
  if (row?.availability && typeof row.availability === "object") {
    const av = row.availability;
    out.roster = out.roster.map((r) => (av[`PLAYER:${r.id}`] ? { ...r, status: av[`PLAYER:${r.id}`] } : r));
    out.picks = out.picks.map((p) => (av[`PICK:${p.id}`] ? { ...p, status: av[`PICK:${p.id}`] } : p));
  }

  return out;
}

// ---------- slots ----------
function assignSlots(roster) {
  const remaining = roster.slice();
  const slots = Object.fromEntries(SLOT_LIMITS.map((s) => [s.key, []]));

  const take = (accepts) => {
    const idx = remaining.findIndex((p) => accepts.includes(normPos(p.pos)));
    if (idx === -1) return null;
    return remaining.splice(idx, 1)[0];
  };

  for (const s of SLOT_LIMITS.filter((x) => x.key !== "BENCH")) {
    while (slots[s.key].length < s.limit) {
      const p = take(s.accepts);
      if (!p) break;
      slots[s.key].push(p);
    }
  }

  slots.BENCH = remaining.slice(0, SLOT_LIMITS.find((x) => x.key === "BENCH").limit);
  return slots;
}

// ---------- styles ----------
function Styles() {
  return (
    <style>{`
      :root{
        --bg:#0B1220; --card:#0F172A; --soft:#0B1324; --sky:#111B2F;
        --text:#E6EEFF; --muted:#A8B3C7; --border:#22304A; --blue:#3B82F6;
        --danger:#EF4444; --shadow:0 10px 30px rgba(0,0,0,0.18);
      }
      body{ margin:0; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; }
      *{ box-sizing:border-box; }
      .wrap{ max-width:1180px; margin:0 auto; padding:16px 14px 94px; }
      .top{ position:sticky; top:0; z-index:50; background:var(--bg); border-bottom:1px solid var(--border); }
      .topin{ max-width:1180px; margin:0 auto; padding:10px 14px; display:flex; gap:10px; align-items:center; }
      .sp{ flex:1; }
      .chip{ padding:7px 10px; border-radius:999px; border:1px solid var(--border); background:var(--sky); color:var(--text); font-weight:900; font-size:12px; cursor:pointer; }
      .grid2{ display:grid; grid-template-columns:1fr; gap:12px; align-items:start; }
      @media(min-width:980px){ .grid2{ grid-template-columns:1fr 1fr; } }
      .card{ background:var(--card); border:1px solid var(--border); border-radius:16px; padding:14px; box-shadow:var(--shadow); }
      .row{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
      .title{ margin:6px 0 14px; letter-spacing:-0.02em; }
      input,select{ padding:12px 12px; border-radius:12px; border:1px solid var(--border); background:var(--sky); color:var(--text); outline:none; font-weight:800; width:100%; }
      button{ padding:12px 12px; border-radius:12px; border:1px solid transparent; background:var(--blue); color:white; font-weight:900; cursor:pointer; }
      button.ghost{ background:transparent; border:1px solid var(--border); color:var(--text); }
      button.danger{ background:var(--danger); }
      button:disabled{ opacity:0.6; cursor:not-allowed; }
      .muted{ color:var(--muted); }
      .dock{ position:fixed; left:0; right:0; bottom:0; background:var(--bg); border-top:1px solid var(--border); z-index:60; }
      .dockin{ max-width:1180px; margin:0 auto; padding:10px 12px; display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
      .dockbtn{ background:transparent; border:1px solid transparent; color:var(--muted); }
      .dockbtn.active{ background:var(--sky); border:1px solid var(--border); color:var(--text); }
      .list{ display:grid; gap:10px; }
      .item{ display:flex; justify-content:space-between; gap:10px; align-items:center; padding:10px 12px; border-radius:14px; border:1px solid var(--border); background:var(--soft); }
      .left{ display:flex; gap:10px; align-items:center; min-width:0; }
      .av{ width:34px; height:34px; border-radius:999px; background:var(--sky); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-weight:1000; }
      .name{ font-weight:1000; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .sub{ font-size:12px; font-weight:900; }
      .slots{ display:grid; gap:12px; }
      .slot{ border:1px solid var(--border); background:var(--card); border-radius:14px; padding:12px; }
      .slothead{ display:flex; justify-content:space-between; align-items:baseline; }
      .seg{ display:flex; flex-wrap:wrap; gap:8px; }
      .seg button{ padding:8px 10px; border-radius:999px; }
      .seg button.active{ background:var(--blue); }
      .pill{ display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; border:1px solid var(--border); background:var(--sky); font-weight:1000; font-size:12px; }
      .badge{ padding:6px 10px; border-radius:999px; border:1px solid var(--border); background:var(--sky); font-weight:1000; font-size:12px; }
    `}</style>
  );
}

// ---------- Views ----------
function MyTeamView({
  players,
  myRoster,
  myPicks,
  slots,
  onAddPlayer,
  onRemovePlayer,
  onTogglePlayerStatus,
  onAddPick,
  onRemovePick,
  onTogglePickStatus,
  saving,
}) {
  const [mode, setMode] = useState("players");
  const [q, setQ] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");

  const filtered = useMemo(() => {
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

  const rosterIds = useMemo(() => new Set((myRoster || []).map((r) => String(r.id))), [myRoster]);
  const pickIds = useMemo(() => new Set((myPicks || []).map((p) => String(p.id))), [myPicks]);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Mi equipo</h2>
          <div className="muted" style={{ fontWeight: 900 }}>
            Estado: {STATUS_LABEL.AVAILABLE} → {STATUS_LABEL.LISTENING} → {STATUS_LABEL.NOT_AVAILABLE}
          </div>
          <div className="sp" />
          <div className="seg">
            <button className={mode === "players" ? "active" : ""} onClick={() => setMode("players")}>
              Jugadores
            </button>
            <button className={mode === "picks" ? "active" : ""} onClick={() => setMode("picks")}>
              Picks
            </button>
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          {mode === "players" ? (
            <>
              <div style={{ display: "grid", gap: 10 }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar jugador..." />
                <div className="seg">
                  {["ALL", "QB", "RB", "WR", "TE"].map((p) => (
                    <button key={p} className={posFilter === p ? "active" : ""} onClick={() => setPosFilter(p)}>
                      {p === "ALL" ? "Todos" : p}
                    </button>
                  ))}
                </div>
              </div>

              <div className="list" style={{ marginTop: 12 }}>
                {filtered.map((p) => {
                  const id = String(p.player_id);
                  const added = rosterIds.has(id);
                  return (
                    <div key={id} className="item">
                      <div className="left">
                        <div className="av">{initials(p.name)}</div>
                        <div style={{ minWidth: 0 }}>
                          <div className="name">{p.name}</div>
                          <div className="muted sub">
                            {normPos(p.position)} · {p.team || "-"} · ADP {p.adp_formatted || "-"}
                          </div>
                        </div>
                      </div>
                      <button className={added ? "ghost" : ""} disabled={added || saving} onClick={() => onAddPlayer(p)}>
                        {added ? "Agregado" : "+ Agregar"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="muted" style={{ fontWeight: 900, marginBottom: 10 }}>
                2026: 1.01–6.10 · 2027/2028: rondas (1era…6ta)
              </div>
              <select
                defaultValue=""
                disabled={saving}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) onAddPick(v);
                  e.target.value = "";
                }}
              >
                <option value="">+ Agregar pick…</option>
                {PICKS.filter((p) => !pickIds.has(String(p.id))).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        <div className="card">
          {mode === "players" ? (
            <>
              <h3 style={{ marginTop: 0 }}>Slots</h3>
              <div className="muted sub">Auto: QB/RB/WR/TE → FLEX → BN</div>

              <div className="slots" style={{ marginTop: 12 }}>
                {SLOT_LIMITS.map((s) => {
                  const list = slots[s.key] || [];
                  return (
                    <div key={s.key} className="slot">
                      <div className="slothead">
                        <div style={{ fontWeight: 1000 }}>{s.label}</div>
                        <div className="muted sub">
                          {list.length}/{s.limit}
                        </div>
                      </div>

                      <div className="list" style={{ marginTop: 10 }}>
                        {list.length === 0 ? <div className="muted">—</div> : null}
                        {list.map((r) => (
                          <div key={r.id} className="item">
                            <div className="left">
                              <div className="av">{initials(r.name)}</div>
                              <div style={{ minWidth: 0 }}>
                                <div className="name">{r.name}</div>
                                <div className="muted sub">
                                  {normPos(r.pos)} · {r.nfl || "-"}
                                </div>
                              </div>
                            </div>
                            <div className="row" style={{ justifyContent: "flex-end" }}>
                              <button className="ghost" disabled={saving} onClick={() => onTogglePlayerStatus(r.id)}>
                                {STATUS_LABEL[r.status] || r.status}
                              </button>
                              <button className="danger" disabled={saving} onClick={() => onRemovePlayer(r.id)}>
                                ✕
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <h3 style={{ marginTop: 0 }}>Mis picks</h3>
              <div className="list" style={{ marginTop: 12 }}>
                {myPicks.length === 0 ? <div className="muted">No agregaste picks todavía.</div> : null}
                {myPicks
                  .slice()
                  .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                  .map((p) => (
                    <div key={p.id} className="item">
                      <div style={{ minWidth: 0 }}>
                        <div className="name">{p.label || p.id}</div>
                        <div className="muted sub">{p.id}</div>
                      </div>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button className="ghost" disabled={saving} onClick={() => onTogglePickStatus(p.id)}>
                          {STATUS_LABEL[p.status] || p.status}
                        </button>
                        <button className="danger" disabled={saving} onClick={() => onRemovePick(p.id)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LeagueView({ me, teams, interests, onSetInterest }) {
  const [selectedId, setSelectedId] = useState("");
  const others = useMemo(() => teams.filter((t) => t.user_id !== me.id), [teams, me]);

  useEffect(() => {
    if (!selectedId && others.length) setSelectedId(others[0].user_id);
  }, [others, selectedId]);

  const selected = useMemo(() => others.find((t) => t.user_id === selectedId), [others, selectedId]);
  const selectedRoster = selected?.roster || [];
  const selectedPicks = selected?.picks || [];

  return (
    <div style={{ marginTop: 12 }}>
      <div className="card" style={{ background: "var(--sky)" }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>Liga</h2>
          <div className="sp" />
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} style={{ maxWidth: 420 }}>
            {others.map((t) => (
              <option key={t.user_id} value={t.user_id}>
                {(t.display_name || t.user_id).slice(0, 30)} {t.team_name ? `— ${t.team_name}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!selected ? (
        <div className="muted" style={{ marginTop: 12 }}>
          No hay equipo seleccionado.
        </div>
      ) : (
        <div className="grid2" style={{ marginTop: 12 }}>
          <div className="card">
            <div style={{ fontWeight: 1000, fontSize: 18 }}>
              {selected.display_name} {selected.team_name ? `— ${selected.team_name}` : ""}
            </div>
            <div className="muted" style={{ fontWeight: 900, marginTop: 4 }}>
              {selected.team_status || "—"}
            </div>

            <h3 style={{ marginTop: 14 }}>Jugadores</h3>
            <div className="muted sub">Marcá tu interés: Bajo / Medio / Alto</div>

            <div className="list" style={{ marginTop: 12 }}>
              {selectedRoster.length === 0 ? <div className="muted">Sin roster cargado.</div> : null}
              {selectedRoster.map((r) => {
                const key = `${me.id}::${selected.user_id}::PLAYER::${r.id}`;
                const cur = interests.find((x) => x.key === key)?.level || "NONE";
                return (
                  <div key={r.id} className="item">
                    <div className="left">
                      <div className="av">{initials(r.name)}</div>
                      <div style={{ minWidth: 0 }}>
                        <div className="name">{r.name}</div>
                        <div className="muted sub">
                          {normPos(r.pos)} · {r.nfl || "-"} · <span className="pill">{STATUS_LABEL[r.status] || r.status}</span>
                        </div>
                      </div>
                    </div>

                    <select
                      value={cur}
                      onChange={(e) => onSetInterest(selected.user_id, "PLAYER", r.id, e.target.value)}
                      style={{ maxWidth: 160 }}
                    >
                      <option value="NONE">—</option>
                      <option value="LOW">Bajo</option>
                      <option value="MEDIUM">Medio</option>
                      <option value="HIGH">Alto</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Picks</h3>
            <div className="list" style={{ marginTop: 12 }}>
              {selectedPicks.length === 0 ? <div className="muted">Sin picks cargados.</div> : null}
              {selectedPicks.map((p) => {
                const key = `${me.id}::${selected.user_id}::PICK::${p.id}`;
                const cur = interests.find((x) => x.key === key)?.level || "NONE";
                return (
                  <div key={p.id} className="item">
                    <div style={{ minWidth: 0 }}>
                      <div className="name">{p.label || p.id}</div>
                      <div className="muted sub">
                        {p.id} · <span className="pill">{STATUS_LABEL[p.status] || p.status}</span>
                      </div>
                    </div>
                    <select
                      value={cur}
                      onChange={(e) => onSetInterest(selected.user_id, "PICK", p.id, e.target.value)}
                      style={{ maxWidth: 160 }}
                    >
                      <option value="NONE">—</option>
                      <option value="LOW">Bajo</option>
                      <option value="MEDIUM">Medio</option>
                      <option value="HIGH">Alto</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InterestsView({ teamsByUser, myOutgoing, myIncoming, metaById }) {
  const fmtAsset = (x) => {
    if (x.asset_type === "PLAYER") {
      const m = metaById.get(String(x.asset_id));
      return m ? `${m.name} (${m.pos} ${m.nfl || "-"})` : `Jugador ${x.asset_id}`;
    }
    return PICK_LABEL.get(String(x.asset_id)) || String(x.asset_id);
  };

  return (
    <div className="grid2" style={{ marginTop: 12 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Mis intereses</h2>
        {myOutgoing.length === 0 ? (
          <div className="muted">No marcaste intereses todavía.</div>
        ) : (
          <div className="list">
            {myOutgoing
              .slice()
              .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
              .map((x) => {
                const owner = teamsByUser.get(x.to_user_id);
                return (
                  <div key={x.key} className="item">
                    <div style={{ minWidth: 0 }}>
                      <div className="name">{fmtAsset(x)}</div>
                      <div className="muted sub">
                        Dueño: {owner?.display_name || x.to_user_id} {owner?.team_name ? `— ${owner.team_name}` : ""}
                      </div>
                    </div>
                    <div className="badge">{INTEREST_LABEL[x.level] || x.level}</div>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Interesados en mi equipo</h2>
        {myIncoming.length === 0 ? (
          <div className="muted">Todavía nadie marcó interés.</div>
        ) : (
          <div className="list">
            {myIncoming
              .slice()
              .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
              .map((x) => {
                const who = teamsByUser.get(x.from_user_id);
                return (
                  <div key={x.key} className="item">
                    <div style={{ minWidth: 0 }}>
                      <div className="name">{fmtAsset(x)}</div>
                      <div className="muted sub">
                        Interesado: {who?.display_name || x.from_user_id} {who?.team_name ? `— ${who.team_name}` : ""}
                      </div>
                    </div>
                    <div className="badge">{INTEREST_LABEL[x.level] || x.level}</div>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- App ----------
export default function App() {
  const [bootError, setBootError] = useState("");

  const [me, setMe] = useState(() => {
    const s = localStorage.getItem("ft_session");
    return s ? safeJsonParse(s, null) : null;
  });

  const [authMode, setAuthMode] = useState("login");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [authErr, setAuthErr] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [tab, setTab] = useState(() => localStorage.getItem("ft_tab") || "team");
  useEffect(() => localStorage.setItem("ft_tab", tab), [tab]);

  const [teams, setTeams] = useState([]);
  const [interests, setInterests] = useState([]);
  const [players, setPlayers] = useState([]);
  const [playersLoading, setPlayersLoading] = useState(false);

  const [myDisplayName, setMyDisplayName] = useState("");
  const [myTeamName, setMyTeamName] = useState("");
  const [myTeamStatus, setMyTeamStatus] = useState("Contendiendo");

  const [saveInfo, setSaveInfo] = useState("");
  const saving = saveInfo === "Guardando...";

  useEffect(() => {
    if (!GH_OWNER || !GH_REPO) setBootError("Faltan VITE_GH_OWNER / VITE_GH_REPO");
    else if (!GH_TOKEN) setBootError("Falta VITE_GH_TOKEN");
  }, []);

  useEffect(() => {
    if (me) localStorage.setItem("ft_session", JSON.stringify(me));
    else localStorage.removeItem("ft_session");
  }, [me]);

  function friendlyAuthError(e) {
    const s = e?.status;
    if (s === 401) return "GitHub 401: token inválido";
    if (s === 403) return "GitHub 403: sin permisos / rate limit";
    if (s === 404) return "GitHub 404: faltan /data/*.json";
    return String(e?.message || e);
  }

  async function loadPlayers() {
    setPlayersLoading(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL || "/"}adp.json`, { cache: "no-store" });
      const j = await res.json();
      setPlayers(Array.isArray(j?.players) ? j.players : []);
    } catch {
      setPlayers([]);
    } finally {
      setPlayersLoading(false);
    }
  }

  async function refreshData() {
    // interests
    const { data: i } = await ghGetJson(PATH_INTERESTS, []);
    setInterests(Array.isArray(i) ? i : []);

    // teams new
    const items = await ghListDir(TEAMS_DIR);
    if (items.length > 0) {
      const jsonFiles = items.filter((x) => x.type === "file" && String(x.name || "").endsWith(".json"));
      const arr = [];
      for (const f of jsonFiles) {
        try {
          const { data } = await ghGetJson(`${TEAMS_DIR}/${f.name}`, null);
          if (data?.user_id) arr.push(normalizeTeamRow(data));
        } catch {}
      }
      setTeams(arr);
      return;
    }

    // legacy fallback
    const { data: legacy } = await ghGetJson(PATH_TEAMS_LEGACY, []);
    setTeams((Array.isArray(legacy) ? legacy : []).map(normalizeTeamRow));
  }

  async function ensureTeamFile(userId, userEmail) {
    const existing = await ghGetTeamFile(userId);
    if (existing?.data?.user_id) return;

    const team = normalizeTeamRow({
      user_id: userId,
      display_name: userEmail.split("@")[0],
      team_name: "",
      team_status: "Contendiendo",
      roster: [],
      picks: [],
      updated_at: nowIso(),
    });

    await ghPutTeamFile(userId, team, null, `create team ${userId}`);
  }

  // boot after login
  useEffect(() => {
    if (!me) return;
    (async () => {
      try {
        await Promise.all([loadPlayers(), refreshData()]);
      } catch (e) {
        setBootError(String(e?.message || e));
      }
    })();
  }, [me?.id]);

  const teamsByUser = useMemo(() => new Map(teams.map((t) => [t.user_id, t])), [teams]);
  const myRow = useMemo(() => (me ? teamsByUser.get(me.id) : null), [me, teamsByUser]);

  useEffect(() => {
    if (!me) return;
    const row = teamsByUser.get(me.id);
    if (row) {
      setMyDisplayName(row.display_name || "");
      setMyTeamName(row.team_name || "");
      setMyTeamStatus(row.team_status || "Contendiendo");
    } else {
      setMyDisplayName(me.email?.split("@")?.[0] || "");
      setMyTeamName("");
      setMyTeamStatus("Contendiendo");
    }
  }, [me, teamsByUser]);

  const myOutgoing = useMemo(() => (me ? interests.filter((x) => x.from_user_id === me.id) : []), [me, interests]);
  const myIncoming = useMemo(() => (me ? interests.filter((x) => x.to_user_id === me.id) : []), [me, interests]);

  const myRoster = useMemo(() => (Array.isArray(myRow?.roster) ? myRow.roster : []), [myRow]);
  const myPicks = useMemo(() => (Array.isArray(myRow?.picks) ? myRow.picks : []), [myRow]);
  const slots = useMemo(() => assignSlots(myRoster), [myRoster]);

  const metaById = useMemo(() => {
    const m = new Map();
    for (const p of players) {
      m.set(String(p.player_id), { name: p.name, pos: normPos(p.position), nfl: p.team || "" });
    }
    for (const t of teams) {
      for (const r of t.roster || []) {
        const id = String(r.id);
        if (!m.has(id)) m.set(id, { name: r.name, pos: normPos(r.pos), nfl: r.nfl || "" });
      }
    }
    return m;
  }, [players, teams]);

  async function signup() {
    setAuthBusy(true);
    setAuthErr("");
    try {
      const em = email.trim().toLowerCase();
      if (!em.includes("@")) throw new Error("Email inválido");
      if (pass.length < 4) throw new Error("Contraseña muy corta");
      if (pass !== pass2) throw new Error("No coinciden");

      const pwHash = await sha256Hex(pass);
      const userId = uid("user");

      await ghPutJsonWithRetry(
        PATH_USERS,
        (cur) => [...cur, { id: userId, email: em, pass_hash: pwHash, created_at: nowIso() }],
        "create user"
      );

      await ensureTeamFile(userId, em);
      setMe({ id: userId, email: em });
      setPass("");
      setPass2("");
      await refreshData();
    } catch (e) {
      setAuthErr(friendlyAuthError(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function login() {
    setAuthBusy(true);
    setAuthErr("");
    try {
      const em = email.trim().toLowerCase();
      if (!em.includes("@")) throw new Error("Email inválido");

      const { data: users } = await ghGetJson(PATH_USERS, []);
      const u = (Array.isArray(users) ? users : []).find((x) => String(x.email).toLowerCase() === em);
      if (!u) throw new Error("Usuario no encontrado");

      const pwHash = await sha256Hex(pass);
      if (String(u.pass_hash) !== pwHash) throw new Error("Contraseña incorrecta");

      await ensureTeamFile(u.id, u.email);
      setMe({ id: u.id, email: u.email });
      setPass("");
      setPass2("");
      await refreshData();
    } catch (e) {
      setAuthErr(friendlyAuthError(e));
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
      await ghPutTeamWithRetry(
        me.id,
        (t) => ({
          ...t,
          display_name: myDisplayName.trim(),
          team_name: myTeamName.trim(),
          team_status: myTeamStatus,
        }),
        "update profile"
      );
      await refreshData();
      setSaveInfo("Guardado ✅");
      setTimeout(() => setSaveInfo(""), 900);
    } catch (e) {
      setSaveInfo(friendlyAuthError(e));
    }
  }

  async function updateMyTeam(mutator, label) {
    if (!me) return;
    setSaveInfo("Guardando...");
    try {
      await ghPutTeamWithRetry(me.id, mutator, label);
      await refreshData();
      setSaveInfo("Guardado ✅");
      setTimeout(() => setSaveInfo(""), 650);
    } catch (e) {
      setSaveInfo(friendlyAuthError(e));
    }
  }

  async function setInterest(toUserId, assetType, assetId, level) {
    if (!me) return;
    const key = `${me.id}::${toUserId}::${assetType}::${assetId}`;
    try {
      const next = await ghPutJsonWithRetry(
        PATH_INTERESTS,
        (cur) => {
          const rest = cur.filter((x) => x.key !== key);
          if (level === "NONE") return rest;
          return [
            ...rest,
            {
              key,
              from_user_id: me.id,
              to_user_id: toUserId,
              asset_type: assetType,
              asset_id: assetId,
              level,
              updated_at: nowIso(),
            },
          ];
        },
        "set interest"
      );
      setInterests(next);
    } catch (e) {
      setSaveInfo(friendlyAuthError(e));
      setTimeout(() => setSaveInfo(""), 1200);
    }
  }

  if (bootError) {
    return (
      <>
        <Styles />
        <div className="wrap">
          <h2 className="title">Error</h2>
          <div className="card">
            <div style={{ fontWeight: 1000, color: "var(--danger)" }}>{bootError}</div>
            <div className="muted" style={{ marginTop: 10 }}>
              Revisá ENV y que existan data/users.json y data/interests.json.
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Styles />

      <div className="top">
        <div className="topin">
          <div style={{ fontWeight: 1000 }}>Fantasy Trades</div>
          <div className="sp" />
          {playersLoading ? <div className="chip" style={{ cursor: "default" }}>ADP…</div> : null}
          {me ? <div className="chip" style={{ cursor: "default" }}>{me.email}</div> : null}
          {me ? (
            <button className="chip" onClick={logout}>
              Salir
            </button>
          ) : null}
        </div>
      </div>

      <div className="wrap">
        <h1 className="title">Trade Board</h1>

        {!me ? (
          <div className="card">
            <div className="row">
              <div style={{ fontWeight: 1000, fontSize: 18 }}>{authMode === "login" ? "Iniciar sesión" : "Crear cuenta"}</div>
              <div className="sp" />
              <button
                className="ghost"
                onClick={() => {
                  setAuthMode(authMode === "login" ? "signup" : "login");
                  setAuthErr("");
                }}
              >
                {authMode === "login" ? "Crear cuenta" : "Tengo cuenta"}
              </button>
            </div>

            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
              <input value={pass} onChange={(e) => setPass(e.target.value)} placeholder="contraseña" type="password" />
              {authMode === "signup" ? (
                <input value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder="repetir contraseña" type="password" />
              ) : null}

              {authErr ? <div style={{ fontWeight: 1000, color: "var(--danger)" }}>{authErr}</div> : null}

              <button disabled={authBusy} onClick={authMode === "login" ? login : signup}>
                {authBusy ? "..." : authMode === "login" ? "Entrar" : "Crear"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="card" style={{ background: "var(--sky)" }}>
              <div className="grid2">
                <div>
                  <div style={{ fontWeight: 1000, fontSize: 18 }}>{myDisplayName || me.email}</div>
                  <div className="muted" style={{ fontWeight: 900 }}>{myTeamName || "Sin nombre de equipo"}</div>
                  <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                    Slots: 1QB 2RB 1WR 1TE 3FLEX 21BN · Picks 2026 (1.01–6.10) + 2027/2028 por ronda
                  </div>
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  <div className="row">
                    <input value={myDisplayName} onChange={(e) => setMyDisplayName(e.target.value)} placeholder="Tu nombre" />
                    <input value={myTeamName} onChange={(e) => setMyTeamName(e.target.value)} placeholder="Nombre del equipo" />
                    <select value={myTeamStatus} onChange={(e) => setMyTeamStatus(e.target.value)}>
                      <option>Contendiendo</option>
                      <option>Reconstrucción</option>
                      <option>Re-tool</option>
                      <option>Tanqueando</option>
                    </select>
                  </div>
                  <div className="row">
                    <button disabled={saving} onClick={saveMyProfile}>Guardar perfil</button>
                    {saveInfo ? <div className="muted" style={{ fontWeight: 900 }}>{saveInfo}</div> : null}
                  </div>
                </div>
              </div>
            </div>

            {tab === "home" ? (
              <InterestsView teamsByUser={teamsByUser} myOutgoing={myOutgoing} myIncoming={myIncoming} metaById={metaById} />
            ) : tab === "league" ? (
              <LeagueView me={me} teams={teams} interests={interests} onSetInterest={setInterest} />
            ) : tab === "interests" ? (
              <InterestsView teamsByUser={teamsByUser} myOutgoing={myOutgoing} myIncoming={myIncoming} metaById={metaById} />
            ) : (
              <MyTeamView
                players={players}
                myRoster={myRoster}
                myPicks={myPicks}
                slots={slots}
                saving={saving}
                onAddPlayer={(adpPlayer) =>
                  updateMyTeam(
                    (t) => {
                      const exists = (t.roster || []).some((r) => String(r.id) === String(adpPlayer.player_id));
                      if (exists) return t;
                      return {
                        ...t,
                        roster: [
                          ...(t.roster || []),
                          {
                            id: String(adpPlayer.player_id),
                            name: adpPlayer.name,
                            pos: normPos(adpPlayer.position),
                            nfl: adpPlayer.team || "",
                            status: "AVAILABLE",
                          },
                        ],
                      };
                    },
                    "add player"
                  )
                }
                onRemovePlayer={(id) => updateMyTeam((t) => ({ ...t, roster: (t.roster || []).filter((r) => String(r.id) !== String(id)) }), "remove player")}
                onTogglePlayerStatus={(id) =>
                  updateMyTeam(
                    (t) => ({
                      ...t,
                      roster: (t.roster || []).map((r) =>
                        String(r.id) !== String(id) ? r : { ...r, status: cycleStatus(r.status || "AVAILABLE") }
                      ),
                    }),
                    "toggle player status"
                  )
                }
                onAddPick={(pickId) =>
                  updateMyTeam(
                    (t) => {
                      const exists = (t.picks || []).some((p) => String(p.id) === String(pickId));
                      if (exists) return t;
                      const label = PICK_LABEL.get(String(pickId)) || String(pickId);
                      return { ...t, picks: [...(t.picks || []), { id: String(pickId), label, status: "AVAILABLE" }] };
                    },
                    "add pick"
                  )
                }
                onRemovePick={(pickId) => updateMyTeam((t) => ({ ...t, picks: (t.picks || []).filter((p) => String(p.id) !== String(pickId)) }), "remove pick")}
                onTogglePickStatus={(pickId) =>
                  updateMyTeam(
                    (t) => ({
                      ...t,
                      picks: (t.picks || []).map((p) =>
                        String(p.id) !== String(pickId) ? p : { ...p, status: cycleStatus(p.status || "AVAILABLE") }
                      ),
                    }),
                    "toggle pick status"
                  )
                }
              />
            )}
          </>
        )}
      </div>

      {me ? (
        <div className="dock">
          <div className="dockin">
            <button className={`dockbtn ${tab === "home" ? "active" : ""}`} onClick={() => setTab("home")}>Inicio</button>
            <button className={`dockbtn ${tab === "league" ? "active" : ""}`} onClick={() => setTab("league")}>Liga</button>
            <button className={`dockbtn ${tab === "interests" ? "active" : ""}`} onClick={() => setTab("interests")}>Intereses</button>
            <button className={`dockbtn ${tab === "team" ? "active" : ""}`} onClick={() => setTab("team")}>Mi equipo</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
