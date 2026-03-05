import { useEffect, useMemo, useState } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  query,
  where,
  deleteDoc,
} from "firebase/firestore";

/**
 * Fantasy Trades — App.jsx (Firebase Firestore)
 *
 * Colecciones Firestore:
 *  - users/{userId}     → { email, pass_hash, created_at }
 *  - teams/{userId}     → { user_id, display_name, team_name, team_status, roster[], picks[], updated_at }
 *  - interests/{key}   → { key, from_user_id, to_user_id, asset_type, asset_id, level, updated_at }
 */

// ---- Firebase init ----
const firebaseConfig = {
  apiKey: "AIzaSyCDOOwEbbXDio00xSnRg7pGYnzs51bZ1vE",
  authDomain: "fantasy-trades-d992a.firebaseapp.com",
  projectId: "fantasy-trades-d992a",
  storageBucket: "fantasy-trades-d992a.firebasestorage.app",
  messagingSenderId: "111630512150",
  appId: "1:111630512150:web:9c379e792b0d40e1fb8537",
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

// ---- Constants ----
const LEAGUE_SIZE = 10;

const SLOT_LIMITS = [
  { key: "QB",    label: "QB",   limit: 1,  accepts: ["QB"] },
  { key: "RB",    label: "RB",   limit: 2,  accepts: ["RB"] },
  { key: "WR",    label: "WR",   limit: 2,  accepts: ["WR"] },
  { key: "TE",    label: "TE",   limit: 1,  accepts: ["TE"] },
  { key: "FLEX",  label: "FLEX", limit: 3,  accepts: ["RB", "WR", "TE"] },
  { key: "BENCH", label: "BN",   limit: 21, accepts: ["QB", "RB", "WR", "TE"] },
];

const STATUS_CYCLE = ["AVAILABLE", "LISTENING", "NOT_AVAILABLE"];
const STATUS_LABEL = {
  AVAILABLE:     "Disponible",
  LISTENING:     "En escucha",
  NOT_AVAILABLE: "No disponible",
};
const INTEREST_LABEL = { NONE: "—", LOW: "Bajo", MEDIUM: "Medio", HIGH: "Alto" };

// ---- Helpers ----
function nowIso() { return new Date().toISOString(); }
function safeJsonParse(txt, fallback) {
  try { return JSON.parse(txt); } catch { return fallback; }
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
  return ["QB", "RB", "WR", "TE"].includes(p) ? p : p || "?";
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

// ---- Picks catalog ----
function pickCatalog() {
  const out = [];
  for (let rnd = 1; rnd <= 6; rnd++) {
    for (let slot = 1; slot <= LEAGUE_SIZE; slot++) {
      const id = `2026-${rnd}.${String(slot).padStart(2, "0")}`;
      out.push({ id, label: `${rnd}.${String(slot).padStart(2, "0")} 2026` });
    }
  }
  const future = (year) => {
    const names = ["1era", "2da", "3era", "4ta", "5ta", "6ta"];
    for (let rnd = 1; rnd <= 6; rnd++) {
      out.push({ id: `${year}-${rnd}`, label: `${names[rnd - 1]} ${year}` });
    }
  };
  future(2027);
  future(2028);
  return out;
}
const PICKS = pickCatalog();
const PICK_LABEL = new Map(PICKS.map((p) => [String(p.id), p.label]));

// ---- Firestore helpers ----
async function fsGetUser(email) {
  const snap = await getDocs(query(collection(db, "users"), where("email", "==", email)));
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function fsCreateUser(userId, email, passHash) {
  await setDoc(doc(db, "users", userId), { email, pass_hash: passHash, created_at: nowIso() });
}
async function fsGetTeam(userId) {
  const snap = await getDoc(doc(db, "teams", userId));
  if (!snap.exists()) return null;
  return { user_id: userId, ...snap.data() };
}
async function fsSetTeam(userId, data) {
  await setDoc(doc(db, "teams", userId), { ...data, updated_at: nowIso() });
}
async function fsGetAllTeams() {
  const snap = await getDocs(collection(db, "teams"));
  return snap.docs.map((d) => ({ user_id: d.id, ...d.data() }));
}
async function fsGetAllInterests() {
  const snap = await getDocs(collection(db, "interests"));
  return snap.docs.map((d) => d.data());
}
async function fsSetInterest(key, data) {
  await setDoc(doc(db, "interests", key), data);
}
async function fsDeleteInterest(key) {
  await deleteDoc(doc(db, "interests", key));
}

// ---- Normalize team ----
function normalizeTeamRow(row) {
  const out = { ...row };
  const roster = Array.isArray(row?.roster) ? row.roster : [];
  out.roster = roster.map((x) => {
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
        pos: normPos(x.pos || x.position || "?"),
        nfl: x.nfl || x.team || "",
        status: x.status || "AVAILABLE",
      };
    }
    return null;
  }).filter(Boolean);

  const picks = Array.isArray(row?.picks) ? row.picks : [];
  out.picks = picks.map((x) => {
    if (!x) return null;
    if (typeof x === "string" || typeof x === "number") {
      const id = String(x);
      return { id, label: PICK_LABEL.get(id) || id, status: "AVAILABLE" };
    }
    if (typeof x === "object") {
      const id = String(x.id || "");
      if (!id) return null;
      return { id, label: x.label || PICK_LABEL.get(id) || id, status: x.status || "AVAILABLE" };
    }
    return null;
  }).filter(Boolean);

  return out;
}

// ---- Slots ----
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

// ---- Styles ----
function Styles() {
  return (
    <style>{`
      :root{
        --bg:#0B1220; --card:#0F172A; --soft:#0B1324; --sky:#111B2F;
        --text:#E6EEFF; --muted:#A8B3C7; --border:#22304A; --blue:#3B82F6;
        --danger:#EF4444; --ok:#22C55E; --warn:#EAB308; --pos-qb:#FF2D83; --pos-rb:#11D6C7; --pos-wr:#63A7FF; --pos-te:#FFB04A; --pos-bn:#9FB4C8; --shadow:0 10px 30px rgba(0,0,0,0.18);
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
      /* === Roster slot tags (QB/RB/WR/TE/WRT/BN) === */
      .rosterItem{ gap:12px; }
      .posTag{
        width:54px; height:44px; border-radius:14px;
        display:flex; align-items:center; justify-content:center;
        font-weight:1100; letter-spacing:0.02em;
        color:#07111f;
        box-shadow:0 6px 16px rgba(0,0,0,0.18);
      }
      .pos-QB{ background:var(--pos-qb); }
      .pos-RB{ background:var(--pos-rb); }
      .pos-WR{ background:var(--pos-wr); }
      .pos-TE{ background:var(--pos-te); }
      .pos-BENCH{ background:var(--pos-bn); }
      .pos-FLEX{ background:linear-gradient(90deg, var(--pos-wr) 0 34%, var(--pos-rb) 34% 67%, var(--pos-te) 67% 100%); }

      @media(max-width:520px){
        .posTag{ width:48px; height:40px; border-radius:13px; }
      }

      /* === Status colors === */
      .statusBtn{ border:1px solid var(--border); }
      .status-AVAILABLE{ background:rgba(34,197,94,0.20); border-color:rgba(34,197,94,0.40); color:#D7FFE4; }
      .status-LISTENING{ background:rgba(234,179,8,0.20); border-color:rgba(234,179,8,0.45); color:#FFF2B8; }
      .status-NOT_AVAILABLE{ background:rgba(239,68,68,0.20); border-color:rgba(239,68,68,0.45); color:#FFD0D0; }
      .pill-AVAILABLE{ background:rgba(34,197,94,0.20); border-color:rgba(34,197,94,0.40); color:#D7FFE4; }
      .pill-LISTENING{ background:rgba(234,179,8,0.20); border-color:rgba(234,179,8,0.45); color:#FFF2B8; }
      .pill-NOT_AVAILABLE{ background:rgba(239,68,68,0.20); border-color:rgba(239,68,68,0.45); color:#FFD0D0; }

    `}</style>
  );
}

// ---- MyTeamView ----
function MyTeamView({
  players, myRoster, myPicks, slots,
  onAddPlayer, onRemovePlayer, onTogglePlayerStatus,
  onAddPick, onRemovePick, onTogglePickStatus,
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
  const pickIds   = useMemo(() => new Set((myPicks  || []).map((p) => String(p.id))), [myPicks]);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Mi equipo</h2>
          <div className="muted" style={{ fontWeight: 900 }}>
            Estado: <span className={`pill pill-AVAILABLE`}>{STATUS_LABEL.AVAILABLE}</span> → <span className={`pill pill-LISTENING`}>{STATUS_LABEL.LISTENING}</span> → <span className={`pill pill-NOT_AVAILABLE`}>{STATUS_LABEL.NOT_AVAILABLE}</span>
          </div>
          <div className="sp" />
          <div className="seg">
            <button className={mode === "players" ? "active" : ""} onClick={() => setMode("players")}>Jugadores</button>
            <button className={mode === "picks"   ? "active" : ""} onClick={() => setMode("picks")}>Picks</button>
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
                          <div className="muted sub">{normPos(p.position)} · {p.team || "-"} · ADP {p.adp_formatted || "-"}</div>
                        </div>
                      </div>
                      <button className={added ? "ghost" : ""} disabled={added || saving} onClick={() => onAddPlayer(p)}>
                        {added ? "Agregado" : saving ? "..." : "+ Agregar"}
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
                onChange={(e) => { const v = e.target.value; if (v) onAddPick(v); e.target.value = ""; }}
              >
                <option value="">+ Agregar pick…</option>
                {PICKS.filter((p) => !pickIds.has(String(p.id))).map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
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
                        <div className="muted sub">{list.length}/{s.limit}</div>
                      </div>
                      <div className="list" style={{ marginTop: 10 }}>
                        {list.length === 0 ? <div className="muted">—</div> : null}
                        {list.map((r) => (
                          <div key={r.id} className="item rosterItem">
                            <div className={`posTag pos-${s.key}`}>{s.key === "FLEX" ? "WRT" : s.label}</div>
                            <div className="left">
                              <div className="av">{initials(r.name)}</div>
                              <div style={{ minWidth: 0 }}>
                                <div className="name">{r.name}</div>
                                <div className="muted sub">{normPos(r.pos)} · {r.nfl || "-"}</div>
                              </div>
                            </div>
                            <div className="row" style={{ justifyContent: "flex-end" }}>
                              <button className={`ghost statusBtn status-${r.status || "AVAILABLE"}`} disabled={saving} onClick={() => onTogglePlayerStatus(r.id)}>
                                {STATUS_LABEL[r.status] || r.status}
                              </button>
                              <button className="danger" disabled={saving} onClick={() => onRemovePlayer(r.id)}>✕</button>
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
                {myPicks.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).map((p) => (
                  <div key={p.id} className="item">
                    <div style={{ minWidth: 0 }}>
                      <div className="name">{p.label || p.id}</div>
                      <div className="muted sub">{p.id}</div>
                    </div>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button className={`ghost statusBtn status-${p.status || "AVAILABLE"}`} disabled={saving} onClick={() => onTogglePickStatus(p.id)}>
                        {STATUS_LABEL[p.status] || p.status}
                      </button>
                      <button className="danger" disabled={saving} onClick={() => onRemovePick(p.id)}>✕</button>
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

// ---- LeagueView ----
function LeagueView({ me, teams, interests, onSetInterest }) {
  const [selectedId, setSelectedId] = useState("");
  const others = useMemo(() => teams.filter((t) => t.user_id !== me.id), [teams, me]);

  useEffect(() => {
    if (!selectedId && others.length) setSelectedId(others[0].user_id);
  }, [others, selectedId]);

  const selected       = useMemo(() => others.find((t) => t.user_id === selectedId), [others, selectedId]);
  const selectedRoster = selected?.roster || [];
  const selectedPicks  = selected?.picks  || [];

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
        <div className="muted" style={{ marginTop: 12 }}>No hay equipo seleccionado.</div>
      ) : (
        <div className="grid2" style={{ marginTop: 12 }}>
          <div className="card">
            <div style={{ fontWeight: 1000, fontSize: 18 }}>
              {selected.display_name} {selected.team_name ? `— ${selected.team_name}` : ""}
            </div>
            <div className="muted" style={{ fontWeight: 900, marginTop: 4 }}>{selected.team_status || "—"}</div>
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
                          {normPos(r.pos)} · {r.nfl || "-"} · <span className={`pill pill-${r.status || "AVAILABLE"}`}>{STATUS_LABEL[r.status] || r.status}</span>
                        </div>
                      </div>
                    </div>
                    <select value={cur} onChange={(e) => onSetInterest(selected.user_id, "PLAYER", r.id, e.target.value)} style={{ maxWidth: 160 }}>
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
                        {p.id} · <span className={`pill pill-${p.status || "AVAILABLE"}`}>{STATUS_LABEL[p.status] || p.status}</span>
                      </div>
                    </div>
                    <select value={cur} onChange={(e) => onSetInterest(selected.user_id, "PICK", p.id, e.target.value)} style={{ maxWidth: 160 }}>
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

// ---- InterestsView ----
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
            {myOutgoing.slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).map((x) => {
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
            {myIncoming.slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).map((x) => {
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

// ---- App ----
export default function App() {
  const [me, setMe] = useState(() => {
    const s = localStorage.getItem("ft_session");
    return s ? safeJsonParse(s, null) : null;
  });

  const [authMode, setAuthMode] = useState("login");
  const [email,    setEmail]    = useState("");
  const [pass,     setPass]     = useState("");
  const [pass2,    setPass2]    = useState("");
  const [authErr,  setAuthErr]  = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [tab, setTab] = useState(() => localStorage.getItem("ft_tab") || "team");
  useEffect(() => localStorage.setItem("ft_tab", tab), [tab]);

  const [teams,          setTeams]          = useState([]);
  const [interests,      setInterests]      = useState([]);
  const [players,        setPlayers]        = useState([]);
  const [playersLoading, setPlayersLoading] = useState(false);

  const [myDisplayName, setMyDisplayName] = useState("");
  const [myTeamName,    setMyTeamName]    = useState("");
  const [myTeamStatus,  setMyTeamStatus]  = useState("Contendiendo");

  const [saveInfo, setSaveInfo] = useState("");
  const [saving,   setSaving]   = useState(false);

  useEffect(() => {
    if (me) localStorage.setItem("ft_session", JSON.stringify(me));
    else localStorage.removeItem("ft_session");
  }, [me]);

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
    const [allTeams, allInterests] = await Promise.all([
      fsGetAllTeams(),
      fsGetAllInterests(),
    ]);
    setTeams(allTeams.map(normalizeTeamRow));
    setInterests(allInterests);
  }

  useEffect(() => {
    if (!me) return;
    Promise.all([loadPlayers(), refreshData()]).catch(console.error);
  }, [me?.id]);

  const teamsByUser = useMemo(() => new Map(teams.map((t) => [t.user_id, t])), [teams]);
  const myRow       = useMemo(() => (me ? teamsByUser.get(me.id) : null), [me, teamsByUser]);

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
  const myIncoming = useMemo(() => (me ? interests.filter((x) => x.to_user_id   === me.id) : []), [me, interests]);
  const myRoster   = useMemo(() => (Array.isArray(myRow?.roster) ? myRow.roster : []), [myRow]);
  const myPicks    = useMemo(() => (Array.isArray(myRow?.picks)  ? myRow.picks  : []), [myRow]);
  const slots      = useMemo(() => assignSlots(myRoster), [myRoster]);

  const metaById = useMemo(() => {
    const m = new Map();
    for (const p of players) {
      m.set(String(p.player_id), { name: p.name, pos: normPos(p.position), nfl: p.team || "" });
    }
    for (const t of teams) {
      for (const r of t.roster || []) {
        if (!m.has(String(r.id))) m.set(String(r.id), { name: r.name, pos: normPos(r.pos), nfl: r.nfl || "" });
      }
    }
    return m;
  }, [players, teams]);

  // ---- Auth ----
  async function signup() {
    setAuthBusy(true);
    setAuthErr("");
    try {
      const em = email.trim().toLowerCase();
      if (!em.includes("@")) throw new Error("Email inválido");
      if (pass.length < 4)   throw new Error("Contraseña muy corta");
      if (pass !== pass2)    throw new Error("No coinciden");

      const existing = await fsGetUser(em);
      if (existing) throw new Error("Ya existe una cuenta con ese email");

      const pwHash = await sha256Hex(pass);
      const userId = uid("user");
      await fsCreateUser(userId, em, pwHash);
      await fsSetTeam(userId, normalizeTeamRow({
        user_id: userId,
        display_name: em.split("@")[0],
        team_name: "",
        team_status: "Contendiendo",
        roster: [],
        picks: [],
      }));

      setMe({ id: userId, email: em });
      setPass(""); setPass2("");
      await refreshData();
    } catch (e) {
      setAuthErr(String(e?.message || e));
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

      const u = await fsGetUser(em);
      if (!u) throw new Error("Usuario no encontrado");

      const pwHash = await sha256Hex(pass);
      if (String(u.pass_hash) !== pwHash) throw new Error("Contraseña incorrecta");

      const existingTeam = await fsGetTeam(u.id);
      if (!existingTeam) {
        await fsSetTeam(u.id, normalizeTeamRow({
          user_id: u.id,
          display_name: em.split("@")[0],
          team_name: "",
          team_status: "Contendiendo",
          roster: [],
          picks: [],
        }));
      }

      setMe({ id: u.id, email: u.email });
      setPass(""); setPass2("");
      await refreshData();
    } catch (e) {
      setAuthErr(String(e?.message || e));
    } finally {
      setAuthBusy(false);
    }
  }

  function logout() {
    setMe(null);
    setEmail(""); setPass(""); setPass2("");
    setTab("team");
  }

  // ---- Team mutations — instantáneas con Firestore ----
  async function updateMyTeam(mutator, label) {
    if (!me) return;
    setSaving(true);
    try {
      const current = normalizeTeamRow(
        (await fsGetTeam(me.id)) || {
          user_id: me.id,
          display_name: myDisplayName,
          team_name: myTeamName,
          team_status: myTeamStatus,
          roster: [],
          picks: [],
        }
      );
      const next = normalizeTeamRow(mutator({ ...current, updated_at: nowIso() }));
      await fsSetTeam(me.id, next);
      // Actualizar estado local sin recargar todos los equipos
      setTeams((prev) => {
        const idx = prev.findIndex((t) => t.user_id === me.id);
        if (idx === -1) return [...prev, next];
        const copy = [...prev];
        copy[idx] = next;
        return copy;
      });
    } catch (e) {
      setSaveInfo(String(e?.message || e));
      setTimeout(() => setSaveInfo(""), 2500);
    } finally {
      setSaving(false);
    }
  }

  async function saveMyProfile() {
    if (!me) return;
    setSaving(true);
    setSaveInfo("Guardando...");
    try {
      const current = normalizeTeamRow(
        (await fsGetTeam(me.id)) || {
          user_id: me.id,
          display_name: "",
          team_name: "",
          team_status: "Contendiendo",
          roster: [],
          picks: [],
        }
      );
      const next = normalizeTeamRow({
        ...current,
        display_name: myDisplayName.trim(),
        team_name:    myTeamName.trim(),
        team_status:  myTeamStatus,
      });
      await fsSetTeam(me.id, next);
      setTeams((prev) => {
        const idx = prev.findIndex((t) => t.user_id === me.id);
        if (idx === -1) return [...prev, next];
        const copy = [...prev];
        copy[idx] = next;
        return copy;
      });
      setSaveInfo("Guardado ✅");
      setTimeout(() => setSaveInfo(""), 1500);
    } catch (e) {
      setSaveInfo(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  async function setInterest(toUserId, assetType, assetId, level) {
    if (!me) return;
    const key = `${me.id}::${toUserId}::${assetType}::${assetId}`;
    try {
      if (level === "NONE") {
        await fsDeleteInterest(key);
        setInterests((prev) => prev.filter((x) => x.key !== key));
      } else {
        const data = {
          key,
          from_user_id: me.id,
          to_user_id:   toUserId,
          asset_type:   assetType,
          asset_id:     assetId,
          level,
          updated_at:   nowIso(),
        };
        await fsSetInterest(key, data);
        setInterests((prev) => [...prev.filter((x) => x.key !== key), data]);
      }
    } catch (e) {
      setSaveInfo(String(e?.message || e));
      setTimeout(() => setSaveInfo(""), 2500);
    }
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
          {me ? <button className="chip" onClick={logout}>Salir</button> : null}
        </div>
      </div>

      <div className="wrap">
        <h1 className="title">Trade Board</h1>

        {!me ? (
          <div className="card">
            <div className="row">
              <div style={{ fontWeight: 1000, fontSize: 18 }}>{authMode === "login" ? "Iniciar sesión" : "Crear cuenta"}</div>
              <div className="sp" />
              <button className="ghost" onClick={() => { setAuthMode(authMode === "login" ? "signup" : "login"); setAuthErr(""); }}>
                {authMode === "login" ? "Crear cuenta" : "Tengo cuenta"}
              </button>
            </div>
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
              <input value={pass}  onChange={(e) => setPass(e.target.value)}  placeholder="contraseña" type="password" />
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
                    Slots: 1QB 2RB 2WR 1TE 3FLEX 21BN · Picks 2026 (1.01–6.10) + 2027/2028 por ronda
                  </div>
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  <div className="row">
                    <input value={myDisplayName} onChange={(e) => setMyDisplayName(e.target.value)} placeholder="Tu nombre" />
                    <input value={myTeamName}    onChange={(e) => setMyTeamName(e.target.value)}    placeholder="Nombre del equipo" />
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

            {tab === "home" || tab === "interests" ? (
              <InterestsView teamsByUser={teamsByUser} myOutgoing={myOutgoing} myIncoming={myIncoming} metaById={metaById} />
            ) : tab === "league" ? (
              <LeagueView me={me} teams={teams} interests={interests} onSetInterest={setInterest} />
            ) : (
              <MyTeamView
                players={players}
                myRoster={myRoster}
                myPicks={myPicks}
                slots={slots}
                saving={saving}
                onAddPlayer={(p) => updateMyTeam((t) => {
                  const exists = (t.roster || []).some((r) => String(r.id) === String(p.player_id));
                  if (exists) return t;
                  return { ...t, roster: [...(t.roster || []), { id: String(p.player_id), name: p.name, pos: normPos(p.position), nfl: p.team || "", status: "AVAILABLE" }] };
                }, "add player")}
                onRemovePlayer={(id) => updateMyTeam((t) => ({
                  ...t, roster: (t.roster || []).filter((r) => String(r.id) !== String(id)),
                }), "remove player")}
                onTogglePlayerStatus={(id) => updateMyTeam((t) => ({
                  ...t,
                  roster: (t.roster || []).map((r) => String(r.id) !== String(id) ? r : { ...r, status: cycleStatus(r.status || "AVAILABLE") }),
                }), "toggle status")}
                onAddPick={(pickId) => updateMyTeam((t) => {
                  const exists = (t.picks || []).some((p) => String(p.id) === String(pickId));
                  if (exists) return t;
                  return { ...t, picks: [...(t.picks || []), { id: String(pickId), label: PICK_LABEL.get(String(pickId)) || String(pickId), status: "AVAILABLE" }] };
                }, "add pick")}
                onRemovePick={(pickId) => updateMyTeam((t) => ({
                  ...t, picks: (t.picks || []).filter((p) => String(p.id) !== String(pickId)),
                }), "remove pick")}
                onTogglePickStatus={(pickId) => updateMyTeam((t) => ({
                  ...t,
                  picks: (t.picks || []).map((p) => String(p.id) !== String(pickId) ? p : { ...p, status: cycleStatus(p.status || "AVAILABLE") }),
                }), "toggle pick status")}
              />
            )}
          </>
        )}
      </div>

      {me ? (
        <div className="dock">
          <div className="dockin">
            <button className={`dockbtn ${tab === "home"      ? "active" : ""}`} onClick={() => setTab("home")}>Inicio</button>
            <button className={`dockbtn ${tab === "league"    ? "active" : ""}`} onClick={() => setTab("league")}>Liga</button>
            <button className={`dockbtn ${tab === "interests" ? "active" : ""}`} onClick={() => setTab("interests")}>Intereses</button>
            <button className={`dockbtn ${tab === "team"      ? "active" : ""}`} onClick={() => setTab("team")}>Mi equipo</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
