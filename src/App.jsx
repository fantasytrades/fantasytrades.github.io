import { useEffect, useMemo, useRef, useState } from "react";
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
 *  - trade_proposals/{id} → { participants[], from_user_id, to_user_id, give{players[],picks[]}, get{players[],picks[]}, status, response, created_at, updated_at }
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


const ALLOWED_POSITIONS = new Set(["QB","RB","WR","TE"]);
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
const STATUS_KEY_FROM_LABEL = {
  "Disponible": "AVAILABLE",
  "En escucha": "LISTENING",
  "No disponible": "NOT_AVAILABLE",
};

function normStatusKey(s) {
  if (!s) return "AVAILABLE";
  // already a canonical key
  if (STATUS_LABEL[s]) return s;
  // spanish label
  if (STATUS_KEY_FROM_LABEL[s]) return STATUS_KEY_FROM_LABEL[s];
  const up = String(s).trim().toUpperCase();
  const up2 = up.replace(/\s+/g, "_");
  if (STATUS_LABEL[up2]) return up2;
  if (up2 === "NO_DISPONIBLE") return "NOT_AVAILABLE";
  if (up2 === "EN_ESCUCHA") return "LISTENING";
  if (up2 === "DISPONIBLE") return "AVAILABLE";
  return "AVAILABLE";
}


const TEAM_STATUS_OPTIONS = ["Contendiente", "En Reconstrucción", "Indefinido"];

function normTeamStatus(s) {
  const v = String(s || "").trim();
  if (!v) return "Indefinido";
  const low = v.toLowerCase();
  if (low.includes("contend")) return "Contendiente";
  if (low.includes("recon")) return "En Reconstrucción";
  if (low.includes("tank") || low.includes("tanque")) return "En Reconstrucción";
  if (low.includes("re-tool") || low.includes("retool") || low.includes("re tool")) return "Indefinido";
  if (TEAM_STATUS_OPTIONS.includes(v)) return v;
  return "Indefinido";
}
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

function pickImg(obj) {
  if (!obj) return "";
  const url =
    obj.photo ||
    obj.image ||
    obj.headshot ||
    obj.player_image ||
    obj.playerImage ||
    obj.img ||
    obj.avatar ||
    obj.avatar_url ||
    obj.playerImg ||
    obj.player_img ||
    obj.photo_url ||
    "";
  return typeof url === "string" ? url : "";
}

function cycleStatus(curr) {
  const key = normStatusKey(curr);
  const i = STATUS_CYCLE.indexOf(key);
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

// ---- Trades (one-to-one proposals) ----
async function fsGetTradesForUser(userId) {
  const q = query(collection(db, "trade_proposals"), where("participants", "array-contains", userId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function fsUpsertTrade(tradeId, data) {
  const id = tradeId || uid("trade");
  const payload = { ...data, updated_at: nowIso() };
  if (!data?.created_at) payload.created_at = nowIso();
  await setDoc(doc(db, "trade_proposals", id), payload, { merge: true });
  return id;
}
async function fsCancelTrade(tradeId) {
  await setDoc(
    doc(db, "trade_proposals", tradeId),
    { status: "CANCELLED", cancelled_at: nowIso(), updated_at: nowIso() },
    { merge: true }
  );
}
async function fsRespondTrade(tradeId, response) {
  await setDoc(
    doc(db, "trade_proposals", tradeId),
    { status: "RESPONDED", response, responded_at: nowIso(), updated_at: nowIso() },
    { merge: true }
  );
}


// ---- Normalize team ----
function normalizeTeamRow(row) {
  const out = { ...row };
  const roster = Array.isArray(row?.roster) ? row.roster : [];
  out.roster = roster.map((x) => {
    if (!x) return null;
    if (typeof x === "string" || typeof x === "number") {
      const id = String(x);
      return { id, name: `Jugador ${id}`, pos: "?", nfl: "", status: "AVAILABLE", value: "", value_tier: null, value_picks: [], value_custom: "", value_note: "" };
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
        value: typeof x.value === "string" ? x.value : (typeof x.value_text === "string" ? x.value_text : ""),
        value_tier: x.value_tier ?? null,
        value_picks: Array.isArray(x.value_picks) ? x.value_picks : [],
        value_custom: typeof x.value_custom === "string" ? x.value_custom : "",
        value_note: typeof x.value_note === "string" ? x.value_note : "",
      };
    }
    return null;
  }).filter(Boolean);

  const picks = Array.isArray(row?.picks) ? row.picks : [];
  out.picks = picks
    .map((x) => {
      if (!x) return null;

      // Soporta picks duplicados por ronda (2027/2028) guardados como "2027-3#2"
      const toBase = (id) => String(id || "").split("#")[0];

      if (typeof x === "string" || typeof x === "number") {
        const id = String(x);
        const base = toBase(id);
        return { id, base, label: PICK_LABEL.get(base) || base, status: "AVAILABLE" };
      }

      if (typeof x === "object") {
        const id = String(x.id || "");
        if (!id) return null;
        const base = String(x.base || toBase(id));
        return {
          id,
          base,
          label: x.label || PICK_LABEL.get(base) || base,
          status: x.status || "AVAILABLE",
        };
      }
      return null;
    })
    .filter(Boolean);

  return out;
}

// ---- Slots ----
function assignSlots(roster, adpById) {
  const slots = Object.fromEntries(SLOT_LIMITS.map((s) => [s.key, []]));

  const getAdp = (r) => {
    const id = String(r.id);
    const meta = adpById?.get?.(id) || null;
    const raw =
      meta?.adp ??
      meta?.adp_value ??
      meta?.adp_rank ??
      r?.adp ??
      r?.adp_value ??
      r?.adp_rank ??
      null;

    const n = Number(raw);
    // ADP "mejor" = número más chico. Si no hay ADP, lo mandamos al fondo.
    return Number.isFinite(n) && n > 0 ? n : 9e9;
  };

  const clone = (r) => ({ ...r });
  const norm = (r) => normPos(r.pos);

  const pool = (roster || []).map(clone);

  // Separar por posición
  const qb = pool.filter((r) => norm(r) === "QB").sort((a, b) => getAdp(a) - getAdp(b));
  const rb = pool.filter((r) => norm(r) === "RB").sort((a, b) => getAdp(a) - getAdp(b));
  const wr = pool.filter((r) => norm(r) === "WR").sort((a, b) => getAdp(a) - getAdp(b));
  const te = pool.filter((r) => norm(r) === "TE").sort((a, b) => getAdp(a) - getAdp(b));

  const used = new Set();
  const takeFrom = (arr, n) => {
    const out = [];
    for (const r of arr) {
      if (out.length >= n) break;
      const id = String(r.id);
      if (used.has(id)) continue;
      used.add(id);
      out.push(r);
    }
    return out;
  };

  // Límites (por si cambiás en el futuro)
  const lim = (k) => SLOT_LIMITS.find((x) => x.key === k)?.limit ?? 0;

  slots.QB = takeFrom(qb, lim("QB"));
  slots.RB = takeFrom(rb, lim("RB"));
  slots.WR = takeFrom(wr, lim("WR"));
  slots.TE = takeFrom(te, lim("TE"));

  // FLEX: mejores ADP de lo que queda entre WR/RB/TE
  const flexPool = [...rb, ...wr, ...te]
    .filter((r) => !used.has(String(r.id)))
    .sort((a, b) => getAdp(a) - getAdp(b));
  slots.FLEX = takeFrom(flexPool, lim("FLEX"));

  // BENCH: lo que queda (ordenado por ADP)
  const benchPool = pool
    .filter((r) => !used.has(String(r.id)))
    .sort((a, b) => getAdp(a) - getAdp(b));
  slots.BENCH = benchPool.slice(0, lim("BENCH"));

  return slots;
}

 // ---- Styles ----
function Styles() {
  return (
    <style>{`\n      :root{
        color-scheme: light;
        --bg:#F3F6FB; --card:#FFFFFF; --soft:#FFFFFF; --sky:#EAF3FF;
        --text:#0F172A; --muted:#64748B; --border:#E5E7EB; --blue:#2F7DF6;
        --danger:#EF4444; --ok:#16A34A; --warn:#F59E0B;
        --pos-qb:#FF2D83; --pos-rb:#11D6C7; --pos-wr:#63A7FF; --pos-te:#FFB04A; --pos-bn:#94A3B8;
        --shadow:0 14px 34px rgba(15,23,42,0.08);
        --shadow-sm:0 8px 22px rgba(15,23,42,0.06);
      }
      body{ margin:0; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; }
      *{ box-sizing:border-box; }
      .wrap{ max-width:1180px; margin:0 auto; padding:18px 14px 92px; }

      /* Wide screens: use more width + more breathing room */
      @media(min-width:1200px){
        .wrap{ max-width:1400px; padding:22px 20px 96px; }
        .grid2{ gap:18px; }
        .list{ gap:14px; }
        .item{ padding:14px 16px; }
      }
      @media(min-width:1500px){
        .wrap{ max-width:1600px; padding:26px 24px 102px; }
        .grid2{ gap:22px; }
        .list{ gap:16px; }
        .item{ padding:15px 18px; }
      }
      @media(min-width:1800px){
        .wrap{ max-width:1760px; }
      }


      /* Top bar */
      .top{ position:sticky; top:0; z-index:50; background:#fff; border-bottom:1px solid var(--border); }
      .topin{ max-width:1180px; margin:0 auto; padding:12px 14px; display:flex; gap:10px; align-items:center; }
      @media(min-width:1200px){ .topin{ max-width:1400px; padding:12px 20px; } }
      @media(min-width:1500px){ .topin{ max-width:1600px; padding:12px 24px; } }
      @media(min-width:1800px){ .topin{ max-width:1760px; } }

      
      .brand{ font-weight:1000; letter-spacing:-0.2px; }
      @media(max-width:520px){
        .topin{ padding:10px 12px; }
        .brand{ font-size:16px; max-width:155px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .chip{ font-size:11px; padding:6px 8px; }
      }

      .mobileFinderToggle{
        border:1px solid #cfe3ff !important;
        background: var(--sky) !important;
        color: var(--blue) !important;
        box-shadow:none !important;
        padding:10px 12px !important;
        border-radius:14px !important;
        font-weight:1000 !important;
      }
      .mobileFinderToggle:focus{ outline:none; }

.sp{ flex:1; }
      .chip{
        padding:7px 10px; border-radius:999px;
        border:1px solid var(--border); background:#fff; color:var(--text);
        font-weight:900; font-size:12px; cursor:pointer;
        box-shadow:0 1px 0 rgba(15,23,42,0.03);
      }

      /* Layout */
      .grid2{ display:grid; grid-template-columns:1fr; gap:14px; align-items:start; }
      @media(min-width:980px){ .grid2{ grid-template-columns:1fr 1fr; } }

      .grid2.single{ grid-template-columns:1fr !important; }
      .mobileOnly{ display:none; }
      @media(max-width:980px){ .mobileOnly{ display:flex; } }

      /* Cards */
      .card{
        background:var(--card); border:1px solid var(--border); border-radius:18px; padding:16px;
        box-shadow:var(--shadow-sm);
      }
      @media(min-width:1200px){ .card{ border-radius:20px; padding:18px; } }
      @media(min-width:1500px){ .card{ border-radius:22px; padding:20px; } }

      .row{ display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .title{ margin:6px 0 14px; letter-spacing:-0.02em; }
      @media(min-width:1200px){ .title{ margin:8px 0 18px; } }


      /* Inputs */
      input,select{
        padding:12px 12px; border-radius:14px; border:1px solid var(--border);
        background:#fff; color:var(--text); outline:none; font-weight:800; width:100%;
        box-shadow:0 1px 0 rgba(15,23,42,0.02);
      }
      input::placeholder{ color:#94A3B8; font-weight:800; }

      

/* Custom select (rounded dropdown) */
.selectWrap{ position:relative; width:100%; }
button.selectBtn{
  width:100%; display:flex; align-items:center; justify-content:space-between; gap:10px;
  padding:12px 12px; border-radius:14px; border:1px solid var(--border);
  background:#fff; color:var(--text); font-weight:900; cursor:pointer;
  box-shadow:none;
}
button.selectBtn:focus{ outline:none; border-color:#CFE3FF; box-shadow:none; }
button.selectBtn:focus-visible{ outline:none; border-color:#CFE3FF; box-shadow:none; }
.selectCaret{
  width:0; height:0;
  border-left:6px solid transparent; border-right:6px solid transparent;
  border-top:7px solid #94A3B8;
}
.selectMenu{
  position:absolute; left:0; right:0; top:calc(100% + 8px);
  background:#fff; border:1px solid var(--border); border-radius:14px;
  box-shadow:none; padding:6px; z-index:80; overflow:hidden;
}
button.selectOpt{
  width:100%; text-align:left;
  padding:10px 10px; border-radius:12px;
  border:0; background:transparent; color:var(--text);
  font-weight:900; cursor:pointer;
  box-shadow:none !important;
}
button.selectOpt:hover{ background:rgba(47,125,246,0.07);  box-shadow:none !important; }
button.selectOpt.active{ background:rgba(47,125,246,0.10);  box-shadow:none !important; }
/* Buttons */
      button{
        padding:12px 14px; border-radius:14px; border:1px solid transparent;
        background:var(--blue); color:#fff; font-weight:950; cursor:pointer;
        box-shadow:0 8px 18px rgba(47,125,246,0.18);
      }
      button.ghost{
        background:#fff; border:1px solid var(--border); color:var(--text);
        box-shadow:0 1px 0 rgba(15,23,42,0.02);
      }
      button.danger{ background:var(--danger); box-shadow:0 8px 18px rgba(239,68,68,0.18); }
      button:disabled{ opacity:0.6; cursor:not-allowed; }

      .muted{ color:var(--muted); }

      /* Bottom dock */
      .dock{ position:fixed; left:0; right:0; bottom:0; background:#fff; border-top:1px solid var(--border); z-index:60; }
      .dockin{ max-width:1180px; margin:0 auto; padding:10px 12px; display:grid; grid-template-columns:repeat(5,1fr); gap:6px; }
      .dockbtn{ background:transparent; border:1px solid transparent; color:var(--muted); box-shadow:none; }
      .dockbtn.active{ background:var(--sky); border:1px solid #CFE3FF; color:var(--text); box-shadow:none; }

      /* Lists */
      .list{ display:grid; gap:12px; }
      .item{
        display:flex; justify-content:space-between; gap:12px; align-items:center;
        padding:12px 14px; border-radius:18px; border:1px solid var(--border); background:#fff;
        box-shadow:0 1px 0 rgba(15,23,42,0.02);
      }
      .left{ display:flex; gap:10px; align-items:center; min-width:0; }
      .av{
        width:34px; height:34px; border-radius:999px;
        background:#F1F5F9; border:1px solid #E2E8F0;
        display:flex; align-items:center; justify-content:center; font-weight:1000; color:#0F172A;
      }

      .av{ overflow:hidden; }
      .av img{ width:100%; height:100%; object-fit:cover; display:block; }

      .posMini{
        display:inline-flex; align-items:center; justify-content:center;
        font-size:11px; font-weight:1000;
        padding:2px 8px; border-radius:999px;
        margin-right:8px;
        color:#fff;
      }
      .posMini-QB{ background:var(--pos-qb); }
      .posMini-RB{ background:var(--pos-rb); color:#063b36; }
      .posMini-WR{ background:var(--pos-wr); }
      .posMini-TE{ background:var(--pos-te); color:#5b2b00; }

      .valueTag{
        margin-top:6px;
        display:inline-block;
        padding:5px 10px;
        border-radius:999px;
        border:1px solid #CFE3FF;
        background:var(--sky);
        color:var(--blue);
        font-weight:1000;
        font-size:12px;
        line-height:1.1;
        max-width:min(320px, 100%);
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }

      /* Picks debajo del roster */
      .picksWrap{ display:flex; flex-wrap:wrap; gap:10px; }
      .pickChip{
        display:flex; align-items:center;
        border:1px solid var(--border);
        border-radius:999px;
        background:#fff;
        overflow:hidden;
      }
      .pickMain{
        border:0; background:transparent;
        padding:8px 12px;
        font-weight:1000;
        color:var(--text);
        cursor:pointer;
        text-align:left;
      }
      .pickX{
        border:0; background:transparent;
        padding:8px 10px;
        color:var(--danger);
        font-weight:1000;
        cursor:pointer;
      }
      .pickChip.pick-AVAILABLE{ background:rgba(22,163,74,0.10); border-color:rgba(22,163,74,0.25); }
      .pickChip.pick-LISTENING{ background:rgba(245,158,11,0.12); border-color:rgba(245,158,11,0.28); }
      .pickChip.pick-NOT_AVAILABLE{ background:rgba(239,68,68,0.10); border-color:rgba(239,68,68,0.24); }
      .pickChip.pick-AVAILABLE .pickMain{ color:#0B3A1A; }
      .pickChip.pick-LISTENING .pickMain{ color:#4A2B00; }
      .pickChip.pick-NOT_AVAILABLE .pickMain{ color:#4A0B0B; }

      .valueBtn{
        padding:10px 14px;
        border-radius:12px;
        color:var(--blue);
        border-color:#CFE3FF;
        background:#fff;
        box-shadow:none;
        font-weight:1000;
      }

      .profileRow{ flex-wrap:nowrap; }
      .profileRow > input, .profileRow > select{ min-width:0; }
      .profileActions{ align-items:center; }
      .profileActions > button{ margin-left:auto; }
      @media(max-width:860px){ .profileRow{ flex-wrap:wrap; } }

      .dockbtn{ padding:10px 12px; border-radius:14px; }
      .name{ font-weight:1000; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .sub{ font-size:12px; font-weight:900; }

      /* Slots */
      .slots{ display:grid; gap:14px; }
      .slot{ border:1px solid var(--border); background:#fff; border-radius:18px; padding:14px; box-shadow:0 1px 0 rgba(15,23,42,0.02); }
      .slothead{ display:flex; justify-content:space-between; align-items:baseline; }

      /* Segmented controls */
      .seg{ display:flex; flex-wrap:wrap; gap:8px; }
      .seg.segTabs{
        background:var(--sky); border:1px solid #CFE3FF;
        padding:6px; border-radius:16px;
      }
      .seg.segTabs button{
        background:transparent; border:1px solid transparent; color:#1E293B;
        padding:10px 16px; border-radius:12px;
        box-shadow:none;
      }
      .seg.segTabs button.active{
        background:var(--blue); color:#fff;
        box-shadow:0 10px 22px rgba(47,125,246,0.22);
      }

      .seg.segFilters button{
        padding:8px 12px; border-radius:999px;
        background:#fff; border:1px solid var(--border); color:#334155;
        box-shadow:none; font-weight:950;
      }
      .seg.segFilters button.active{
        background:var(--blue); border-color:rgba(47,125,246,0.35); color:#fff;
        box-shadow:0 10px 22px rgba(47,125,246,0.18);
      }

      /* Pills / badges */
      .pill{
        display:inline-flex; align-items:center; gap:8px;
        padding:6px 10px; border-radius:999px; border:1px solid var(--border);
        background:#F1F5F9; font-weight:1000; font-size:12px; color:#0F172A;
      }
      .badge{ padding:6px 10px; border-radius:999px; border:1px solid var(--border); background:#F1F5F9; font-weight:1000; font-size:12px; color:#0F172A; display:inline-flex; align-items:center; justify-content:center; min-width:84px; }

      .badge-NONE{ background:#F1F5F9; border-color:var(--border); color:#0F172A; }
      .badge-LOW{ background:rgba(239,68,68,0.16); border-color:rgba(239,68,68,0.35); color:#991B1B; }
      .badge-MEDIUM{ background:rgba(245,158,11,0.18); border-color:rgba(245,158,11,0.40); color:#92400E; }
      .badge-HIGH{ background:rgba(34,197,94,0.18); border-color:rgba(34,197,94,0.35); color:#166534; }

      /* === Roster slot tags (QB/RB/WR/TE/WRT/BN) === */
      .rosterItem{ gap:12px; display:grid; grid-template-columns:54px minmax(260px, 1fr) auto; align-items:center; }
      .rosterActions{ display:flex; gap:12px; align-items:center; flex-wrap:nowrap; justify-content:flex-end; }
      .rosterActions .valueBtn, .rosterActions .statusBtn{ height:40px; padding:0 14px; border-radius:999px; white-space:nowrap; }
      .rosterActions .valueBtn{ min-width:120px; }
      .rosterActions .statusBtn{ min-width:140px; }
      .rosterActions .iconBtn{ width:40px; height:40px; }

      .posTag{
        width:54px; height:44px; border-radius:14px;
        display:flex; align-items:center; justify-content:center;
        font-weight:1100; letter-spacing:0.02em;
        color:#fff;
        box-shadow:none;
      }
      .pos-QB{ background:var(--pos-qb); }
      .pos-RB{ background:var(--pos-rb); }
      .pos-WR{ background:var(--pos-wr); }
      .pos-TE{ background:var(--pos-te); }
      .pos-BENCH{ background:var(--pos-bn); }
      .pos-FLEX{ background:linear-gradient(90deg, var(--pos-wr) 0 34%, var(--pos-rb) 34% 67%, var(--pos-te) 67% 100%); }
      .posTag{ text-shadow:0 1px 0 rgba(0,0,0,0.12); }

      @media(max-width:520px){
        .posTag{ width:48px; height:40px; border-radius:13px; }
        .card{ padding:14px; }
      }

      @media(max-width:720px){
        .rosterItem{ grid-template-columns:54px 1fr; align-items:start; }
        .rosterItem > .posTag{ grid-row:1 / span 2; }
        .rosterItem > .left{ grid-column:2; min-width:0; }
        .rosterItem > .rosterActions{ grid-column:2; grid-row:2; justify-content:flex-start; margin-top:10px; width:100%; }
        .rosterActions{ width:100%; display:grid; grid-template-columns: 1fr 1fr 44px; gap:10px; align-items:center; justify-content:stretch; }
        .rosterActions .valueBtn, .rosterActions .statusBtn{ width:100%; min-width:0; }
        .rosterActions .iconBtn{ width:44px; height:44px; }
        .valueTag{ max-width:100%; }
      }

      @media(max-width:420px){
        .rosterItem{ grid-template-columns:48px 1fr; }
        .rosterItem > .posTag{ width:48px; height:48px; font-size:14px; }
        .rosterActions{ grid-template-columns: 1fr 44px; grid-auto-rows:44px; }
        .rosterActions .valueBtn{ grid-column:1; }
        .rosterActions .statusBtn{ grid-column:1; }
        .rosterActions .iconBtn{ grid-column:2; grid-row:1 / span 2; height:100%; }
        .valueTag{ white-space:normal; }
      }

            /* === Status colors (flat, like the white mock) === */
      .statusBtn{ border:1px solid var(--border); box-shadow:none; }
      button.statusBtn.status-AVAILABLE{ background:var(--ok); border-color:var(--ok); color:#fff; }
      button.statusBtn.status-LISTENING{ background:var(--warn); border-color:var(--warn); color:#fff; }
      button.statusBtn.status-NOT_AVAILABLE{ background:var(--danger); border-color:var(--danger); color:#fff; }

      .pill-AVAILABLE{ background:rgba(22,163,74,0.14); border-color:rgba(22,163,74,0.28); color:#166534; }
      .pill-LISTENING{ background:rgba(245,158,11,0.16); border-color:rgba(245,158,11,0.30); color:#92400E; }
      .pill-NOT_AVAILABLE{ background:rgba(239,68,68,0.14); border-color:rgba(239,68,68,0.28); color:#991B1B; }
      /* === Mock-match refinements === */
      .profileCard{ background:var(--sky); }
      .row > input, .row > select{ width:auto; flex:1; min-width:180px; }
      @media(max-width:720px){ .row > input, .row > select{ min-width:0; width:100%; } }

      .segTabsFull{ width:100%; }
      .segTabsFull button{ flex:1; }

      .btnAdd{
        background:var(--sky);
        border:1px solid #CFE3FF;
        color:var(--blue);
        box-shadow:none;
        padding:10px 14px;
        border-radius:12px;
        font-weight:950;
      }
      .btnAdd.added{
        background:#F8FAFC;
        border-color:#E2E8F0;
        color:#94A3B8;
      }

      .countPill{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        font-weight:950;
        font-size:12px;
        padding:6px 10px;
        border-radius:999px;
        background:#EEF2FF;
        border:1px solid #DCE4FF;
        color:#1E40AF;
        white-space:nowrap;
      }


      .itemTight{ padding:12px 12px; border-radius:16px; }
      .scrollList{ max-height:560px; overflow:auto; padding-right:4px; }
      @media(max-width:980px){ .scrollList{ max-height:none; } }

      .slotsFlat{ gap:18px; }
      .slotSection{ padding-top:4px; }
      .slotheadFlat{ padding:0 2px; }

      .iconBtn{
        width:38px; height:38px; padding:0;
        border-radius:12px;
        display:inline-flex; align-items:center; justify-content:center;
        background:#fff;
        border:1px solid var(--border);
        box-shadow:none;
        color:#334155;
        font-weight:1000;
      }
      .iconBtn.iconDanger{ color:#DC2626; border-color:#F3B4B4; background:#fff; }
      .iconBtn:hover{ background:#F8FAFC; }

      .statusBtn{
        border-radius:999px;
        padding:10px 14px;
        box-shadow:none;
        font-weight:1000;
      }

      .dockbtn{
        padding:10px 0;
        border-radius:14px;
        font-weight:900;
        background:transparent;
        border:1px solid transparent;
        box-shadow:none;
      }
      .dockbtn.active{ background:var(--sky); border-color:#CFE3FF; }


      /* === League (match mock) === */
      .teamList{ display:grid; gap:10px; }
      .teamRow{
        padding:12px 14px;
        border-radius:16px;
        border:1px solid var(--border);
        background:#fff;
        cursor:pointer;
      }
      .teamRow.active{ border-color:rgba(47,125,246,0.65); }
      .teamRowTop{ display:flex; gap:10px; align-items:flex-start; }
      .teamName{ font-weight:1100; }
      .teamOwner{ font-weight:900; color:var(--muted); margin-top:2px; }
      .teamMeta{ margin-top:6px; font-weight:900; color:var(--muted); font-size:12px; }
      .teamBadge{
        margin-left:auto;
        padding:6px 10px;
        border-radius:999px;
        border:1px solid #CFE3FF;
        background:var(--sky);
        color:var(--blue);
        font-weight:1100;
        font-size:12px;
        white-space:nowrap;
      }
      .teamStatusPill{
        padding:6px 10px;
        border-radius:999px;
        border:1px solid #CFE3FF;
        background:var(--sky);
        color:var(--blue);
        font-weight:1100;
        font-size:12px;
        white-space:nowrap;
      }
      .leagueAssetRow{ display:grid; grid-template-columns: 1fr auto; align-items:center; gap:12px; }
      .leagueAssetRight{ display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:nowrap; min-width:0; }
      .interestPills{ display:flex; gap:8px; flex-wrap:nowrap; }
      .interestBtn{
        padding:8px 12px;
        border-radius:999px;
        border:1px solid var(--border);
        background:var(--sky);
        color:#1E293B;
        box-shadow:none;
        font-weight:1100;

        /* make Bajo/Medio/Alto equal width */
        min-width:84px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        text-align:center;
      }
      .interestBtn.active{ /* fallback */ 
        background:var(--blue);
        border-color:rgba(47,125,246,0.35);
        color:#fff;
      }
      .interestBtn.active-LOW{
        background: rgba(239,68,68,0.18);
        border-color: rgba(239,68,68,0.35);
        color: #7F1D1D;
      }
      .interestBtn.active-MEDIUM{
        background: rgba(245,158,11,0.18);
        border-color: rgba(245,158,11,0.40);
        color: #7C2D12;
      }
      .interestBtn.active-HIGH{
        background: rgba(34,197,94,0.18);
        border-color: rgba(34,197,94,0.35);
        color: #14532D;
      }
      .valueChip{ padding:7px 10px; border-radius:999px; border:1px solid #CFE3FF; background:var(--sky); color:var(--blue); font-weight:1100; font-size:12px; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis; }
      @media (max-width: 820px){
        .leagueAssetRow{ grid-template-columns: 1fr; }
        .leagueAssetRight{ justify-content:flex-start; flex-wrap:wrap; }
        .valueChip{ max-width: 100%; }
        .interestPills{ flex-wrap:wrap; }
      }

            /* === Home / News === */
      .newsCard{ padding:18px; }
      .newsHeader{ display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
      .newsTitleRow{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .newsTitle{ font-size:22px; font-weight:1100; letter-spacing:-0.02em; }
      .newsUpdated{ color:var(--muted); font-weight:900; font-size:13px; }
      .newsHint{ margin-top:6px; color:var(--muted); font-weight:850; font-size:13px; }
      .newsDot{ width:9px; height:9px; border-radius:999px; background:#CBD5E1; display:inline-block; }
      .newsDot.pulse{ background:var(--blue); animation:pulse 1.2s ease-in-out infinite; }
      @keyframes pulse{ 0%{ transform:scale(1); opacity:.55; } 50%{ transform:scale(1.35); opacity:1; } 100%{ transform:scale(1); opacity:.55; } }

      .newsControls{ display:flex; align-items:center; gap:12px; flex-wrap:wrap; justify-content:flex-end; }
      .newsToggles{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .newsToggle{
        padding:9px 12px;
        border-radius:999px;
        border:1px solid #CFE3FF;
        background:var(--sky);
        color:#1E293B;
        font-weight:1000;
        box-shadow:none;
      }
      .newsToggle.active{
        background:var(--blue);
        border-color:rgba(47,125,246,0.40);
        color:#fff;
      }

      .newsSearch{
        display:flex; align-items:center; gap:8px;
        border:1px solid var(--border);
        background:#fff;
        border-radius:14px;
        padding:10px 12px;
        min-width:260px;
      }
      .newsSearchIcon{ color:#94A3B8; font-weight:1100; }
      .newsSearchInput{
        border:0; outline:none; padding:0; margin:0; width:100%;
        font-weight:900; color:var(--text); background:transparent;
      }
      .newsSearchInput::placeholder{ color:#94A3B8; font-weight:900; }

      .newsStats{ margin-top:12px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .newsStatPill{
        display:inline-flex; align-items:center; justify-content:center;
        padding:6px 10px; border-radius:999px;
        background:#EEF2FF; border:1px solid #DCE4FF;
        color:#1E40AF; font-weight:1100; font-size:12px;
      }

      .newsList{ margin-top:14px; display:grid; gap:12px; }
      .newsItem{
        border:1px solid var(--border);
        background:#fff;
        border-radius:18px;
        padding:14px 14px 12px;
        box-shadow:0 1px 0 rgba(15,23,42,0.02);
      }
      .newsItem:hover{ border-color:#D9E3F2; }
      .newsItemTop{ display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .newsItemMeta{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; color:var(--muted); font-weight:900; }
      .newsSourcePill{
        padding:6px 10px;
        border-radius:999px;
        border:1px solid var(--border);
        background:#F1F5F9;
        color:#0F172A;
        font-weight:1100;
        font-size:12px;
      }
      .src-ESPN{ border-color:rgba(239,68,68,0.28); background:rgba(239,68,68,0.10); color:#991B1B; }
      .src-FantasyPros{ border-color:rgba(34,197,94,0.28); background:rgba(34,197,94,0.10); color:#166534; }
      .newsTime{ font-size:12px; }
      .newsRel{ font-size:12px; padding:3px 8px; border-radius:999px; border:1px solid var(--border); background:#fff; }

      .newsOpenBtn{
        display:inline-flex;
        align-items:center;
        gap:8px;
        padding:9px 12px;
        border-radius:12px;
        border:1px solid #CFE3FF;
        background:var(--sky);
        color:var(--blue);
        font-weight:1100;
        text-decoration:none;
        white-space:nowrap;
      }
      .newsOpenBtn:hover{ background:#DDEBFF; }

      .newsHeadline{
        display:block;
        margin-top:10px;
        font-size:18px;
        font-weight:1100;
        letter-spacing:-0.01em;
        color:var(--text);
        text-decoration:none;
      }
      .newsHeadline:hover{ text-decoration:underline; text-decoration-thickness:2px; }

      .newsDesc{ margin-top:6px; color:var(--muted); font-weight:850; line-height:1.35; }

      .newsMentions{ margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .mentionChip{
        display:inline-flex; align-items:center; gap:8px;
        padding:6px 10px 6px 6px;
        border-radius:999px;
        border:1px solid var(--border);
        background:#F8FAFC;
        font-weight:1000;
        max-width:260px;
      }
      .mentionAv{
        width:24px; height:24px; border-radius:999px;
        background:#E2E8F0; border:1px solid #D1D9E6;
        display:inline-flex; align-items:center; justify-content:center;
        font-size:11px; font-weight:1100; color:#0F172A;
        overflow:hidden;
      }
      .mentionAv img{ width:100%; height:100%; object-fit:cover; display:block; }
      .mentionTxt{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:210px; }
      .mentionMore{ color:var(--muted); font-weight:1000; }

      .newsFoot{ margin-top:14px; color:var(--muted); font-weight:850; font-size:12px; }

      /* skeleton */
      .skeleton{ position:relative; overflow:hidden; }
      .skLine{ height:12px; border-radius:8px; background:#EEF2F7; border:1px solid #E7EEF8; }
      .skLine.w40{ width:40%; }
      .skLine.w70{ width:70%; }
      .skLine.w85{ width:85%; margin-top:10px; }
      .skChips{ display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
      .skChip{ width:92px; height:28px; border-radius:999px; background:#EEF2F7; border:1px solid #E7EEF8; }
      .skeleton:after{
        content:"";
        position:absolute; inset:0;
        background:linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent);
        transform:translateX(-100%);
        animation:shimmer 1.2s ease-in-out infinite;
      }
      @keyframes shimmer{ 0%{ transform:translateX(-100%);} 100%{ transform:translateX(100%);} }

      @media(max-width:520px){
        .newsSearch{ min-width:0; width:100%; }
        .newsControls{ width:100%; justify-content:flex-start; }
        .newsItem{ padding:12px; }
        .mentionTxt{ max-width:160px; }
      }

/* === Modal (Asset value editor) === */
      .modalOverlay{
        position:fixed; inset:0;
        background:rgba(15,23,42,0.35);
        display:flex; align-items:center; justify-content:center;
        padding:18px;
        z-index:120;
      }
      .modal{
        width:min(760px, 100%);
        background:#fff;
        border:1px solid var(--border);
        border-radius:22px;
        box-shadow:var(--shadow);
        overflow:hidden;
      }
      .modalHead{
        display:flex; align-items:center; justify-content:space-between;
        padding:16px 18px;
        border-bottom:1px solid var(--border);
      }
      .modalTitle{ font-weight:1100; font-size:18px; letter-spacing:-0.01em; }
      .modalBody{
        padding:16px 18px;
        display:grid; gap:14px;
        max-height:70vh;
        overflow:auto;
      }
      .modalFoot{
        padding:14px 18px;
        border-top:1px solid var(--border);
        display:flex; justify-content:flex-end; gap:10px;
        background:#fff;
      }
      .modalBlock{ display:grid; gap:8px; }
      .modalLabel{ font-weight:1100; color:#0F172A; }
      .hint{ font-size:12px; color:var(--muted); font-weight:800; }
      .tierRow{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .tierDot{
        width:42px; height:42px;
        border-radius:999px;
        background:#fff;
        border:1px solid var(--border);
        color:#0F172A;
        font-weight:1100;
        box-shadow:none;
        padding:0;
      }
      .tierDot.active{
        background:var(--blue);
        border-color:rgba(47,125,246,0.35);
        color:#fff;
        box-shadow:0 10px 22px rgba(47,125,246,0.18);
      }
      .miniBtn{
        padding:10px 12px;
        border-radius:999px;
        font-weight:1000;
        box-shadow:none;
      }
      .chipGrid{
        display:flex; flex-wrap:wrap; gap:10px;
      }
      .pickChip{
        padding:10px 14px;
        border-radius:999px;
        background:var(--sky);
        border:1px solid #CFE3FF;
        color:var(--blue);
        box-shadow:none;
        font-weight:1100;
      }
      .pickChip.active{
        background:var(--blue);
        color:#fff;
        border-color:rgba(47,125,246,0.35);
        box-shadow:0 10px 22px rgba(47,125,246,0.16);
      }
      .textarea{
        width:100%;
        min-height:90px;
        resize:vertical;
        padding:12px 12px;
        border-radius:14px;
        border:1px solid var(--border);
        background:#fff;
        color:var(--text);
        outline:none;
        font-weight:800;
        box-shadow:0 1px 0 rgba(15,23,42,0.02);
      }
      .previewBox{
        padding:12px 12px;
        border-radius:14px;
        border:1px dashed #CFE3FF;
        background:var(--sky);
        color:#0F172A;
        font-weight:1000;
      }
      .dangerText{
        color:#DC2626;
        border-color:#F3B4B4;
      }
\n    
      /* Chips variants (used in Chats) */
      .chip.ok{ background:#DCFCE7; border:1px solid #86EFAC; color:#166534; }
      .chip.warn{ background:#FFEDD5; border:1px solid #FDBA74; color:#9A3412; }
      .chip.danger{ background:#FEE2E2; border:1px solid #FCA5A5; color:#991B1B; }

      button.ok{ background:#16a34a; box-shadow:0 8px 18px rgba(22,163,74,0.18); }
      button.warn{ background:#f59e0b; box-shadow:0 8px 18px rgba(245,158,11,0.18); }
      button.ok:hover{ filter:brightness(0.98); }
      button.warn:hover{ filter:brightness(0.98); }

      /* Chats layout */
      .chatsWrap{ display:grid; grid-template-columns:340px 1fr; gap:16px; align-items:start; }
      .chatList{ border:1px solid var(--border); background:linear-gradient(180deg,#fff,#FBFDFF); border-radius:18px; padding:12px; }
      .chatItem{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-radius:16px; cursor:pointer; border:1px solid transparent; }
      .chatItem:hover{ background:#F6FAFF; }
      .chatItem.active{ background:#EEF6FF; border-color:#A7C7FF; }
      .chatItemLeft{ display:flex; align-items:center; gap:10px; min-width:0; }
      .chatItemRight{ display:flex; align-items:center; gap:8px; }
      .chatTeamAvatar{
        width:40px; height:40px; border-radius:14px;
        display:flex; align-items:center; justify-content:center;
        background:linear-gradient(180deg, rgba(47,125,246,0.16), rgba(47,125,246,0.06));
        border:1px solid rgba(47,125,246,0.18);
        color:#163B86; font-weight:1100;
        flex:0 0 auto;
      }
      .chatDot{
        min-width:22px; height:22px; padding:0 6px;
        border-radius:999px; background:#2F7DF6; color:#fff;
        display:flex; align-items:center; justify-content:center;
        font-weight:1100; font-size:12px;
      }

      .chatMain{ display:grid; gap:14px; }

      .tradeCard{ border:1px solid var(--border); background:#fff; border-radius:18px; padding:12px; display:grid; gap:10px; }
      .tradeCardNice{ background:linear-gradient(180deg,#fff,#FBFDFF); }
      .tradeTop{ display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
      .tradeSides{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
      .tradeSide{ border:1px solid var(--border); background:#fff; border-radius:14px; padding:10px; }
      .chatTradeSide{ border:1px solid var(--border); background:#fff; border-radius:14px; padding:10px; }

      .chatSideTop{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
      .chatSideTitle{ font-weight:1100; }
      .chatSideCount{
        min-width:28px; height:28px; padding:0 10px;
        border-radius:999px;
        background:rgba(47,125,246,0.10);
        border:1px solid rgba(47,125,246,0.16);
        color:#163B86; font-weight:1100; display:flex; align-items:center; justify-content:center;
      }

      .chatTabs{ display:flex; align-items:center; gap:8px; margin-bottom:10px; }
      .chatTab{
        height:38px; padding:0 14px;
        border-radius:999px;
        border:1px solid var(--border);
        background:#fff;
        font-weight:1100;
        color:var(--text);
        cursor:pointer;
      }
      .chatTab:hover{ background:#F7FAFF; }
      .chatTab.active{ background:#2F7DF6; border-color:#2F7DF6; color:#fff; }
      .chatSearch{
        height:38px; padding:0 12px;
        border-radius:999px;
        border:1px solid var(--border);
        background:#fff;
        min-width:160px;
        max-width:240px;
        outline:none;
        font-weight:900;
      }

      .chatSelected{
        border:1px dashed rgba(47,125,246,0.25);
        background:rgba(47,125,246,0.04);
        border-radius:14px;
        padding:10px;
        margin-bottom:10px;
      }
      .chatChipsWrap{ display:flex; flex-wrap:wrap; gap:8px; }
      .chatAssetChip{
        display:inline-flex; align-items:center; gap:8px;
        padding:6px 10px;
        border-radius:999px;
        border:1px solid rgba(15,23,42,0.12);
        background:#fff;
        cursor:pointer;
        font-weight:1000;
      }
      .chatAssetChip:hover{ background:#F7FAFF; border-color:rgba(47,125,246,0.35); }
      .chatAssetName{ max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .chatX{ opacity:0.6; margin-left:2px; font-size:16px; line-height:1; }

      .chatPickList{
        border:1px solid var(--border);
        background:#fff;
        border-radius:14px;
        padding:8px;
        max-height:260px;
        overflow:auto;
        display:grid;
        gap:8px;
      }
      .chatPickRow{
        width:100%;
        border:1px solid var(--border);
        background:#fff;
        border-radius:14px;
        padding:10px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        cursor:pointer;
        text-align:left;
      }
      .chatPickRow:hover{ background:#F6FAFF; border-color:#CFE0FF; }
      .chatPickRow.active{ background:#EEF6FF; border-color:#8FB7FF; }
      .chatPickLeft{ display:flex; align-items:center; gap:10px; min-width:0; }
      .chatPickText{ display:grid; gap:2px; min-width:0; }
      .chatPickName{ font-weight:1100; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .chatPickSub{ display:flex; align-items:center; gap:8px; }
      .chatCheck{
        width:26px; height:26px; border-radius:999px;
        display:flex; align-items:center; justify-content:center;
        border:1px solid rgba(47,125,246,0.18);
        background:rgba(47,125,246,0.10);
        color:#163B86;
        font-weight:1200;
        flex:0 0 auto;
      }
      .chatPickRow.active .chatCheck{ background:#2F7DF6; border-color:#2F7DF6; color:#fff; }

      .chatAv{
        width:40px; height:40px;
        border-radius:999px;
        border:1px solid rgba(15,23,42,0.10);
        background:#F1F5F9;
        overflow:hidden;
        display:flex; align-items:center; justify-content:center;
        flex:0 0 auto;
      }
      .chatAv img{ width:100%; height:100%; object-fit:cover; display:block; }
      .chatAvSm{
        width:22px; height:22px;
        border-radius:999px;
        border:1px solid rgba(15,23,42,0.10);
        background:#F1F5F9;
        overflow:hidden;
        display:flex; align-items:center; justify-content:center;
        flex:0 0 auto;
      }
      .chatAvSm img{ width:100%; height:100%; object-fit:cover; display:block; }
      .chatAvFallback{ font-weight:1100; color:#0F172A; font-size:11px; }
      .chatPickIcon{
        width:40px; height:40px;
        border-radius:14px;
        display:flex; align-items:center; justify-content:center;
        background:rgba(2,132,199,0.08);
        border:1px solid rgba(2,132,199,0.16);
        color:#0F3A55;
        font-weight:1100;
        flex:0 0 auto;
      }

      .chatMiniChip{
        display:inline-flex; align-items:center; gap:8px;
        padding:6px 10px;
        border-radius:999px;
        border:1px solid rgba(15,23,42,0.10);
        background:#fff;
        font-weight:1000;
      }
      .chatMiniText{ max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

      @media (max-width: 980px){
        .chatsWrap{ grid-template-columns:1fr; }
        .tradeSides{ grid-template-columns:1fr; }
        .chatTabs{ flex-wrap:wrap; }
        .chatSearch{ max-width:100%; width:100%; min-width:0; }
        .chatPickList{ max-height:220px; }
      }
`}</style>
  );
}
// ---- MyTeamView ----
function MyTeamView({
  players, myRoster, myPicks, slots,
  onAddPlayer, onRemovePlayer, onTogglePlayerStatus,
  onAddPick, onRemovePick, onTogglePickStatus,
  onSetPlayerValue,
  saving,
}) {
  const [mode, setMode] = useState("players");
  const [q, setQ] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");
  const [pickQ, setPickQ] = useState("");

  const [showFinder, setShowFinder] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 980;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 980px)");
    const onChange = () => {
      if (mq.matches) setShowFinder(true);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return (players || [])
      .filter((p) => {
        const posRaw = String(p?.position ?? p?.pos ?? p?.player_position ?? "").toUpperCase();
        if (!ALLOWED_POSITIONS.has(posRaw)) return false;
        const pos = normPos(posRaw);
        if (posFilter !== "ALL") {
          if (posFilter === "FLEX") {
            if (!["RB", "WR", "TE"].includes(pos)) return false;
          } else {
            if (pos !== posFilter) return false;
          }
        }
        if (!qq) return true;
        return String(p.name || p.player_name || p.full_name || p.player || "").toLowerCase().includes(qq);
      })
      .slice(0, 1200);
  }, [players, q, posFilter]);

  const rosterIds = useMemo(() => new Set((myRoster || []).map((r) => String(r.id))), [myRoster]);
  const pickIds   = useMemo(() => new Set((myPicks  || []).map((p) => String(p.id))), [myPicks]);

  // Conteo por "base" (ej: 2027-3) para permitir duplicados 2027/2028
  const pickCounts = useMemo(() => {
    const m = new Map();
    (myPicks || []).forEach((p) => {
      const base = String(p?.base || String(p?.id || "").split("#")[0]);
      if (!base) return;
      m.set(base, (m.get(base) || 0) + 1);
    });
    return m;
  }, [myPicks]);

  // Catálogo filtrado para el selector (tab Picks)
  const filteredPickCatalog = useMemo(() => {
    const qq = String(pickQ || "").trim().toLowerCase();
    if (!qq) return PICKS;
    return PICKS.filter((p) => {
      const id = String(p.id).toLowerCase();
      const lab = String(p.label || "").toLowerCase();
      return id.includes(qq) || lab.includes(qq);
    });
  }, [pickQ]);

  // Picks agrupados para mostrar debajo del roster (ej: "2x 3era 2027")
  const groupedPicks = useMemo(() => {
    const groups = new Map();
    (myPicks || []).forEach((p) => {
      const id = String(p?.id || "");
      if (!id) return;
      const base = String(p?.base || id.split("#")[0]);
      const label = p?.label || PICK_LABEL.get(base) || base;
      const status = normStatusKey(p?.status);
      if (!groups.has(base)) groups.set(base, { base, label, ids: [], statuses: [] });
      const g = groups.get(base);
      g.ids.push(id);
      g.statuses.push(status);
    });

    const out = [];
    for (const g of groups.values()) {
      const uniq = Array.from(new Set(g.statuses));
      const status = uniq.length === 1 ? uniq[0] : "MIXED";
      out.push({ ...g, count: g.ids.length, status });
    }
    out.sort((a, b) => String(a.base).localeCompare(String(b.base)));
    return out;
  }, [myPicks]);

  const metaById = useMemo(() => {
    const m = new Map();
    (players || []).forEach((p) => m.set(String(p.player_id), p));
    return m;
  }, [players]);


  return (
    <div style={{ marginTop: 12 }}>
      <div className="row mobileOnly" style={{ marginBottom: 10 }}>
        <button className="ghost mobileFinderToggle" onClick={() => setShowFinder((v) => !v)}>
          {showFinder ? "Ocultar buscador" : "Buscar jugadores / picks"}
        </button>
      </div>
      <div className={`grid2 ${showFinder ? "" : "single"}`}>
        {/* Left: Players / Picks list */}
        {showFinder ? (
        <div className="card">
          <div className="seg segTabs segTabsFull">
            <button className={mode === "players" ? "active" : ""} onClick={() => setMode("players")}>Jugadores</button>
            <button className={mode === "picks"   ? "active" : ""} onClick={() => setMode("picks")}>Picks</button>
          </div>

          {mode === "players" ? (
            <>
              <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar jugador por nombre..." />
                <div className="seg segFilters">
                  {["ALL", "QB", "RB", "WR", "TE", "FLEX"].map((p) => (
                    <button key={p} className={posFilter === p ? "active" : ""} onClick={() => setPosFilter(p)}>
                      {p === "ALL" ? "Todos" : p}
                    </button>
                  ))}
                </div>
              </div>

              <div className="list scrollList" style={{ marginTop: 12 }}>
                {filtered.map((p) => {
                  const id = String(p?.player_id ?? p?.id ?? "");
                  const pname = p?.name || p?.player_name || p?.full_name || p?.player || "";
                  const added = rosterIds.has(id);
                  const posRaw = p?.position ?? p?.pos ?? p?.player_position ?? "";
                  const pos = normPos(posRaw);
                  const img = pickImg(p);
                  return (
                    <div key={id} className="item itemTight">
                      <div className="left">
                        <div className="av">{img ? <img src={img} alt={pname} /> : initials(pname)}</div>
                        <div style={{ minWidth: 0 }}>
                          <div className="name">{pname}</div>
                          <div className="muted sub"><span className={`posMini posMini-${pos}`}>{pos}</span>{p.team || p.nfl || "-"}</div>
                        </div>
                      </div>
                      <button
                        className={added ? "btnAdd added" : "btnAdd"}
                        disabled={added || saving}
                        onClick={() => onAddPlayer(p)}
                      >
                        {added ? "Agregado" : "+ Agregar"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                <input
                  value={pickQ}
                  onChange={(e) => setPickQ(e.target.value)}
                  placeholder="Buscar pick (ej: 1.01 2026 / 2da 2027)…"
                />
              </div>

              <div className="list scrollList" style={{ marginTop: 12 }}>
                {filteredPickCatalog.length === 0 ? <div className="muted">No hay resultados.</div> : null}
                {filteredPickCatalog.map((p) => {
                  const base = String(p.id);
                  const year = base.slice(0, 4);
                  const count = pickCounts.get(base) || 0;
                  const locked = year === "2026" && count > 0;

                  return (
                    <div key={base} className="item itemTight">
                      <div style={{ minWidth: 0 }}>
                        <div className="name">{p.label}</div>
                        <div className="muted sub">Pick de draft</div>
                      </div>

                      <div className="row" style={{ justifyContent: "flex-end", gap: 10 }}>
                        {year !== "2026" && count > 0 ? <span className="countPill">x{count}</span> : null}
                        <button
                          className={locked ? "btnAdd added" : "btnAdd"}
                          disabled={locked || saving}
                          onClick={() => onAddPick(base)}
                        >
                          {locked ? "Agregado" : "+ Agregar"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        ) : null}

        {/* Right: Slots / Picks details */}
        <div className="card">
                      <>
              <div className="row" style={{ alignItems: "baseline", marginBottom: 6 }}>
                <h3 style={{ margin: 0 }}>Mi Equipo</h3>
                <div className="sp" />
                <div className="muted sub">Auto: QB/RB/WR/TE → FLEX → BN</div>
              </div>
              <div className="muted sub" style={{ marginBottom: 12 }}>
                Tocá el botón de estado: <b>Disponible</b> → <b>En escucha</b> → <b>No disponible</b>
              </div>

              <div className="slots slotsFlat">
                {SLOT_LIMITS.map((s) => {
                  const list = slots[s.key] || [];
                  return (
                    <div key={s.key} className="slotSection">
                      <div className="slothead slotheadFlat">
                        <div style={{ fontWeight: 1000 }}>{s.key === "BENCH" ? "BN" : s.label}</div>
                        <div className="muted sub">{list.length}/{s.limit}</div>
                      </div>

                      <div className="list" style={{ marginTop: 10 }}>
                        {list.length === 0 ? null : null}
                        {list.map((r) => {
                          const stKey = normStatusKey(r.status);
                          const meta = metaById.get(String(r.id));
                          const img = pickImg(meta);
                          const pos = normPos(r.pos);
                          return (
                            <div key={r.id} className="item rosterItem itemTight">
                              <div className={`posTag pos-${s.key}`}>{s.key === "FLEX" ? "WRT" : (s.key === "BENCH" ? "BN" : s.label)}</div>

                              <div className="left" style={{ minWidth: 0 }}>
                                <div className="av">{img ? <img src={img} alt={r.name} /> : initials(r.name)}</div>
                                <div style={{ minWidth: 0 }}>
                                  <div className="name">{r.name}</div>
                                  <div className="muted sub"><span className={`posMini posMini-${pos}`}>{pos}</span>{r.nfl || "-"}</div>
                                  {r.value ? <div className="valueTag">{r.value}</div> : null}
                                </div>
                              </div>

                              <div className="rosterActions">
                                <button className="ghost valueBtn" disabled={saving} onClick={() => onSetPlayerValue?.(r.id)}>
                                  {r.value ? "Editar valor" : "Valor"}
                                </button>
                                <button className={`statusBtn status-${stKey}`} disabled={saving} onClick={() => onTogglePlayerStatus(r.id)}>
                                  {STATUS_LABEL[stKey]}
                                </button>
                                <button className="iconBtn iconDanger" disabled={saving} onClick={() => onRemovePlayer(r.id)} aria-label="Eliminar">✕</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

              <div className="picksBelow">
                <div className="row" style={{ alignItems: "baseline", marginTop: 14 }}>
                  <h4 style={{ margin: 0 }}>Picks</h4>
                  <div className="sp" />
                  <div className="muted sub">{myPicks.length}</div>
                </div>

                {groupedPicks.length === 0 ? (
                  <div className="muted" style={{ marginTop: 8 }}>No agregaste picks todavía.</div>
                ) : (
                  <div className="list" style={{ marginTop: 10 }}>
                    {groupedPicks.map((g) => {
                      const stKey = g.status === "MIXED" ? "AVAILABLE" : g.status;
                      return (
                        <div key={g.base} className="item itemTight pickRow">
                          <div style={{ minWidth: 0 }}>
                            <div className="name">{g.count > 1 ? `${g.count}x ${g.label}` : g.label}</div>
                            <div className="muted sub">{g.base}</div>
                          </div>
                          <div className="row" style={{ justifyContent: "flex-end" }}>
                            <button className={`statusBtn status-${stKey}`} disabled={saving} onClick={() => onTogglePickStatus(g.ids)}>
                              {g.status === "MIXED" ? "Mixto" : STATUS_LABEL[stKey]}
                            </button>
                            <button
                              className="iconBtn iconDanger"
                              disabled={saving}
                              onClick={(e) => onRemovePick(e.shiftKey ? g.ids : g.ids[0])}
                              aria-label="Eliminar pick"
                              title={g.count > 1 ? "Click: elimina 1 · Shift+Click: elimina todos" : "Eliminar"}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              </div>
            </>
        </div>
      </div>
    </div>
  );
}

// ---- Value modal (Asset value editor) ----
function buildValuePreview({ tier, picks, customText, pos }) {
  const ct = String(customText || "").trim();
  if (ct) return ct;

  const parts = [];
  if (tier) parts.push(`Tier ${tier}`);
  if (Array.isArray(picks) && picks.length) parts.push(picks.join(" + "));
  // Si no hay nada, queda vacío
  return parts.join(" / ");
}

const PICK_PRESETS = [
  "2x 2da",
  "1x 2da",
  "1x 1era",
  "Late 1era",
  "Mid 1era",
  "Early 1era",
  "1era + 2da",
  "2da + 3era",
  "3x 2da",
];

function ValueModal({
  open,
  playerName,
  playerPos,
  initial,
  saving,
  onClose,
  onSave,
  onDelete,
}) {
  const [tier, setTier] = useState(null);
  const [picks, setPicks] = useState([]);
  const [customText, setCustomText] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    setTier(initial?.value_tier ?? null);
    setPicks(Array.isArray(initial?.value_picks) ? initial.value_picks : []);
    setCustomText(String(initial?.value_custom || ""));
    setNote(String(initial?.value_note || ""));
  }, [open, initial?.value_tier, initial?.value_custom, initial?.value_note, JSON.stringify(initial?.value_picks || [])]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const preview = buildValuePreview({ tier, picks, customText, pos: playerPos });

  const togglePick = (label) => {
    setPicks((prev) => {
      const s = new Set(prev);
      if (s.has(label)) s.delete(label);
      else s.add(label);
      return Array.from(s);
    });
  };

  const handleSave = () => {
    onSave?.({
      value: preview.trim(),
      value_tier: tier ?? null,
      value_picks: picks,
      value_custom: customText,
      value_note: note,
    });
  };

  const handleDelete = () => {
    onDelete?.();
  };

  return (
    <div className="modalOverlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalHead">
          <div className="modalTitle">
            Valor del asset · <span style={{ fontWeight: 1100 }}>{playerName || "Jugador"}</span>
          </div>
          <button className="iconBtn" onClick={onClose} disabled={saving} aria-label="Cerrar">✕</button>
        </div>

        <div className="modalBody">
          <div className="modalBlock">
            <div className="modalLabel">Tier</div>
            <div className="tierRow">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={`tierDot ${tier === n ? "active" : ""}`}
                  onClick={() => setTier(n)}
                  disabled={saving}
                >
                  {n}
                </button>
              ))}
              <button className="ghost miniBtn" onClick={() => setTier(null)} disabled={saving}>
                Limpiar
              </button>
            </div>
          </div>

          <div className="modalBlock">
            <div className="modalLabel">Picks (presets)</div>
            <div className="chipGrid">
              {PICK_PRESETS.map((lab) => (
                <button
                  key={lab}
                  className={`pickChip ${picks.includes(lab) ? "active" : ""}`}
                  onClick={() => togglePick(lab)}
                  disabled={saving}
                >
                  {lab}
                </button>
              ))}
              <button className="ghost miniBtn" onClick={() => setPicks([])} disabled={saving}>
                Limpiar picks
              </button>
            </div>
          </div>

          <div className="modalBlock">
            <div className="modalLabel">Texto custom (opcional)</div>
            <input
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder='Ej: Late 1era + 2da / RB Tier 2 / 2x2da + 3era...'
              disabled={saving}
            />
            <div className="hint">Si ponés texto custom, pisa el armado automático (Tier/Picks).</div>
          </div>

          <div className="modalBlock">
            <div className="modalLabel">Nota (opcional)</div>
            <textarea
              className="textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ej: Solo por upgrade, no vendo por picks. / Busco RB joven."
              disabled={saving}
            />
          </div>

          <div className="modalBlock">
            <div className="modalLabel">Preview</div>
            <div className="previewBox">{preview || "—"}</div>
          </div>
        </div>

        <div className="modalFoot">
          <button className="ghost dangerText" onClick={handleDelete} disabled={saving}>
            Borrar
          </button>
          <button onClick={handleSave} disabled={saving}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}



// ---- LeagueView ----
function LeagueView({ me, teams, interests, onSetInterest, metaById }) {
  const LEAGUE_NAME = "The Royal Dynasty";

  const [selectedId, setSelectedId] = useState("");

  const teamsSorted = useMemo(() => {
    const mine = teams.filter((t) => t.user_id === me.id);
    const others = teams.filter((t) => t.user_id !== me.id);
    // stable-ish sort: by team_name then display_name
    others.sort((a, b) => {
      const an = String(a.team_name || "").toLowerCase();
      const bn = String(b.team_name || "").toLowerCase();
      if (an !== bn) return an.localeCompare(bn);
      return String(a.display_name || "").toLowerCase().localeCompare(String(b.display_name || "").toLowerCase());
    });
    return [...mine, ...others];
  }, [teams, me.id]);

  useEffect(() => {
    if (selectedId) return;
    const firstOther = teamsSorted.find((t) => t.user_id !== me.id);
    setSelectedId(firstOther ? firstOther.user_id : me.id);
  }, [teamsSorted, selectedId, me.id]);

  const selected = useMemo(
    () => teamsSorted.find((t) => t.user_id === selectedId) || teamsSorted.find((t) => t.user_id === me.id) || null,
    [teamsSorted, selectedId, me.id]
  );

  const selectedRoster = selected?.roster || [];
  const selectedPicks = selected?.picks || [];

  const countByPos = (roster) => {
    const c = { QB: 0, RB: 0, WR: 0, TE: 0 };
    (roster || []).forEach((r) => {
      const p = normPos(r?.pos || r?.position || "");
      if (c[p] != null) c[p] += 1;
    });
    return c;
  };

  const getAdp = (id) => {
    const m = metaById?.get(String(id));
    const n = Number(m?.adp ?? m?.adp_value ?? m?.adp_rank ?? m?.adp_formatted);
    return Number.isFinite(n) && n > 0 ? n : 9e9;
  };

  const rosterView = useMemo(() => {
    const order = { QB: 0, RB: 1, WR: 2, TE: 3 };
    return (selectedRoster || [])
      .filter((r) => ALLOWED_POSITIONS.has(String(r?.pos || r?.position || "").toUpperCase()))
      .slice()
      .sort((a, b) => {
        const pa = normPos(a.pos);
        const pb = normPos(b.pos);
        const oa = order[pa] ?? 9;
        const ob = order[pb] ?? 9;
        if (oa !== ob) return oa - ob;
        return getAdp(a.id) - getAdp(b.id);
      });
  }, [selectedRoster, metaById]);

  const picksView = useMemo(() => {
    // keep as-is but stable sort by base/id
    return (selectedPicks || []).slice().sort((a, b) => String(a.base || a.id).localeCompare(String(b.base || b.id)));
  }, [selectedPicks]);

  const InterestButtons = ({ toUserId, assetType, assetId }) => {
    const key = `${me.id}::${toUserId}::${assetType}::${assetId}`;
    const cur = interests.find((x) => x.key === key)?.level || "NONE";
    if (String(toUserId) === String(me.id)) return null;
    return (
      <div className="interestPills">
        {["LOW", "MEDIUM", "HIGH"].map((lvl) => (
          <button
            key={lvl}
            className={"interestBtn" + (cur === lvl ? (" active active-" + lvl) : "")}
            onClick={() => onSetInterest(toUserId, assetType, assetId, cur === lvl ? "NONE" : lvl)}
            title={INTEREST_LABEL[lvl]}
          >
            {INTEREST_LABEL[lvl]}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div className="card profileCard" style={{ padding: 14 }}>
        <div style={{ fontWeight: 1100, fontSize: 18 }}>{LEAGUE_NAME}</div>
      </div>

      <div className="grid2" style={{ marginTop: 12 }}>
        {/* Left: teams list */}
        <div className="card profileCard">
          <div style={{ fontWeight: 1100, marginBottom: 10 }}>Equipos</div>
          <div className="teamList">
            {teamsSorted.map((t) => {
              const counts = countByPos(t.roster || []);
              const active = t.user_id === selectedId;
              const badge = t.user_id === me.id ? "Vos" : "Manager";
              return (
                <div
                  key={t.user_id}
                  className={"teamRow" + (active ? " active" : "")}
                  onClick={() => setSelectedId(t.user_id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setSelectedId(t.user_id);
                  }}
                >
                  <div className="teamRowTop">
                    <div style={{ minWidth: 0 }}>
                      <div className="teamName">{t.team_name || "Sin nombre"}</div>
                      <div className="teamOwner">{t.display_name || t.user_id}</div>
                    </div>
                    {badge ? <span className="teamBadge">{badge}</span> : null}
                  </div>
                  <div className="teamMeta">
                    {normTeamStatus(t.team_status)} · QB: {counts.QB} RB: {counts.RB} WR: {counts.WR} TE: {counts.TE}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: selected team details */}
        {!selected ? (
          <div className="card">
            <div className="muted">No hay equipo seleccionado.</div>
          </div>
        ) : (
          <div className="card">
            <div className="row" style={{ alignItems: "baseline" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 1100, fontSize: 18 }} className="name">
                  {selected.team_name || "Sin nombre"}
                </div>
                <div className="muted" style={{ fontWeight: 900 }}>
                  {selected.display_name || selected.user_id}
                </div>
              </div>
              <div className="sp" />
              <span className="teamStatusPill">{normTeamStatus(selected.team_status)}</span>
            </div>

            <div style={{ marginTop: 14, fontWeight: 1100 }}>Roster</div>

            <div className="list" style={{ marginTop: 12 }}>
              {rosterView.length === 0 ? <div className="muted">Sin roster cargado.</div> : null}

              {rosterView.map((r) => {
                const stKey = normStatusKey(r.status);
                const meta = metaById?.get(String(r.id));
                const img = pickImg(meta) || pickImg(r);
                const pos = normPos(r.pos);
                const valueText = String(r.value || "").trim();

                return (
                  <div key={r.id} className="item itemTight leagueAssetRow">
                    <div className="left">
                      <div className="av">{img ? <img src={img} alt={r.name} /> : initials(r.name)}</div>
                      <div style={{ minWidth: 0 }}>
                        <div className="name">{r.name}</div>
                        <div className="muted sub">
                          <span className={`posMini posMini-${pos}`}>{pos}</span>
                          {r.nfl || meta?.team || "-"}
                        </div>
                      </div>
                    </div>

                    <div className="leagueAssetRight">
                      {valueText ? <span className="valueChip">{valueText}</span> : null}
                      <span className={`pill pill-${stKey}`}>{STATUS_LABEL[stKey]}</span>
                      <InterestButtons toUserId={selected.user_id} assetType="PLAYER" assetId={r.id} />
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 18, fontWeight: 1100 }}>Picks</div>

            <div className="list" style={{ marginTop: 12 }}>
              {picksView.length === 0 ? <div className="muted">Sin picks cargados.</div> : null}
              {picksView.map((p) => {
                const stKey = normStatusKey(p.status);
                return (
                  <div key={p.id} className="item itemTight leagueAssetRow">
                    <div style={{ minWidth: 0 }}>
                      <div className="name">{p.label || p.id}</div>
                      <div className="muted sub">{p.id}</div>
                    </div>

                    <div className="leagueAssetRight">
                      <span className={`pill pill-${stKey}`}>{STATUS_LABEL[stKey]}</span>
                      <InterestButtons toUserId={selected.user_id} assetType="PICK" assetId={p.id} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- InterestsView ----
function InterestsView({ teamsByUser, myOutgoing, myIncoming, metaById }) {
  const fmtAsset = (x) => {
    if (x.asset_type === "PLAYER") {
      const m = metaById.get(String(x.asset_id));
      if (!m) return `Jugador ${x.asset_id}`;
      const pos = normPos(m.pos || m.position || "?");
      const nfl = m.nfl || m.team || "-";
      return `${m.name} (${pos} ${nfl})`;
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
                  <div className={`badge badge-${x.level || "NONE"}`}>{INTEREST_LABEL[x.level] || x.level}</div>
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
                  <div className={`badge badge-${x.level || "NONE"}`}>{INTEREST_LABEL[x.level] || x.level}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function HomeNewsView({ myRoster, metaById }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [data, setData] = useState({ generatedAt: null, items: [] });
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);

  // Normalizamos fuentes porque FantasyPros suele venir con variantes ("FantasyPros.com", "FantasyPro", etc.)
  const SOURCE_KEYS = ["ESPN", "FantasyPros"];
  const normSourceKey = (raw) => {
    const s = String(raw || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/\./g, "")
      .replace(/-/g, "");

    if (s.includes("espn")) return "ESPN";
    if (s.includes("fantasypros") || s.includes("fantasypro")) return "FantasyPros";
    return raw ? String(raw) : "ESPN";
  };

  const [sources, setSources] = useState({ ESPN: true, FantasyPros: true });

  const rosterPlayers = useMemo(() => {
    const out = [];
    (myRoster || []).forEach((r) => {
      const id = String(r?.id ?? "");
      const meta = metaById?.get?.(id) || null;
      const name = String(meta?.name || r?.name || "").trim();
      if (!name) return;
      out.push({
        id,
        name,
        img: pickImg(meta) || pickImg(r) || "",
      });
    });
    // De-dup por nombre (mantiene el primero con imagen si existe)
    const m = new Map();
    for (const p of out) {
      const k = String(p.name).toLowerCase();
      if (!m.has(k) || (!m.get(k).img && p.img)) m.set(k, p);
    }
    return Array.from(m.values());
  }, [myRoster, metaById]);

  const rosterNames = useMemo(() => rosterPlayers.map((p) => p.name), [rosterPlayers]);

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const aliasesForName = (playerName) => {
    const raw = String(playerName || "").trim();
    const toks = norm(raw)
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !SUFFIXES.has(t));

    if (toks.length < 2) return [];

    const first = toks[0];
    const last = toks[toks.length - 1];

    const out = [];
    out.push(toks);           // full
    out.push([first, last]);  // first last

    // "St. Brown" => "st brown"
    if (toks.length >= 3 && toks[toks.length - 2] === "st") out.push(["st", last]);

    // iniciales: A J Brown => aj brown / a j brown
    if (toks.length >= 3 && toks[0].length === 1 && toks[1].length === 1) {
      out.push([`${toks[0]}${toks[1]}`, last]);
      out.push([toks[0], toks[1], last]);
    }

    const uniq = new Map();
    for (const a of out) uniq.set(a.join("|"), a);
    return [...uniq.values()];
  };

  const hasAllWords = (hayNorm, words) =>
    words.every((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`, "i").test(hayNorm));

  const matchesPlayer = (playerName, hayNorm) => {
    const aliases = aliasesForName(playerName);
    if (!aliases.length) return false;
    return aliases.some((words) => words.length >= 2 && hasAllWords(hayNorm, words));
  };

  // Si el item trae players explícitos (depende del parser), los usamos para filtrar/mostrar
  const extractExplicitPlayers = (it) => {
    const cand =
      it?.players ||
      it?.playerNames ||
      it?.matchedPlayers ||
      it?.mentions ||
      it?.tags ||
      null;

    if (!Array.isArray(cand)) return [];
    return cand
      .map((x) => (typeof x === "string" ? x : (x?.name || x?.player || "")))
      .map((x) => String(x || "").trim())
      .filter(Boolean);
  };

  const toggleSource = (srcKey) => {
    setSources((s) => ({ ...s, [srcKey]: !s[srcKey] }));
  };

  const mentionMeta = (name) => {
    const key = String(name || "").toLowerCase();
    const p = rosterPlayers.find((x) => String(x.name).toLowerCase() === key);
    return p || null;
  };

  const fmtDate = (ts) => {
    if (!ts) return "—";
    try { return new Date(ts).toLocaleString(); } catch { return "—"; }
  };

  const relTime = (ts) => {
    const t = Number(ts || 0);
    if (!t) return "";
    const diff = Date.now() - t;
    const min = Math.round(diff / 60000);
    if (min < 1) return "recién";
    if (min < 60) return `hace ${min} min`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `hace ${hr} h`;
    const d = Math.round(hr / 24);
    return `hace ${d} d`;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        // En GH Pages, usar BASE_URL evita problemas de path
        const base = import.meta.env.BASE_URL || "/";
        const res = await fetch(`${base}news.json?ts=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        const items = Array.isArray(json?.items) ? json.items : [];
        setData({ generatedAt: json?.generatedAt || null, items });
      } catch (e) {
        if (!cancelled) {
          setErr("No pude cargar noticias. Generá public/news.json (ej: `node scripts/update-news.mjs` o corriendo el workflow) y recargá.");
          setData({ generatedAt: null, items: [] });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    let items = Array.isArray(data.items) ? [...data.items] : [];

    // Normalizar fuente, y filtrar por toggle
    items = items
      .map((it) => {
        const srcKey = normSourceKey(it?.source || it?.provider || it?.site);
        const title = String(it?.title || it?.headline || it?.name || "").trim();
        const description = String(it?.description || it?.summary || it?.desc || "").trim();
        const url = String(it?.url || it?.link || it?.href || "").trim();
        const publishedAt = it?.publishedAt || it?.pubDate || it?.date || it?.published || null;
        const publishedTs =
          Number(it?.publishedTs || it?.published_ts) ||
          (publishedAt ? Date.parse(publishedAt) : 0) ||
          0;

        return {
          ...it,
          sourceKey: srcKey,
          title,
          description,
          url,
          publishedAt,
          publishedTs,
        };
      })
      .filter((it) => {
        const srcKey = it.sourceKey;
        // si no es una de las dos conocidas, no lo mostramos (para evitar ruido)
        if (!SOURCE_KEYS.includes(srcKey)) return false;
        return sources[srcKey] !== false;
      });

    // Filtrado por roster
    if (!showAll && rosterNames.length) {
      items = items.filter((it) => {
        const explicit = extractExplicitPlayers(it).map(norm);
        if (explicit.length) {
          return rosterNames.some((rn) => explicit.includes(norm(rn)));
        }
        const hay = norm(`${it.title || ""} ${it.description || ""}`);
        return rosterNames.some((n) => matchesPlayer(n, hay));
      });
    }

    // Search
    if (q.trim()) {
      const qn = norm(q);
      items = items.filter((it) =>
        norm(`${it.title || ""} ${it.description || ""} ${it.sourceKey || ""}`).includes(qn)
      );
    }

    items.sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0));
    return items.slice(0, 80);
  }, [data.items, rosterNames, showAll, q, sources]);

  const activeCount = filtered.length;

  return (
    <div style={{ marginTop: 12 }}>
      <div className="card newsCard">
        <div className="newsHeader">
          <div>
            <div className="newsTitleRow">
              <div className="newsTitle">Noticias</div>
              <span className={`newsDot ${loading ? "pulse" : ""}`} aria-hidden="true" />
              <div className="newsUpdated">
                {data.generatedAt ? `Actualizado: ${fmtDate(data.generatedAt)}` : "Actualizado: —"}
              </div>
            </div>
            <div className="newsHint">
              {!showAll && rosterNames.length
                ? `Filtrando por tus jugadores (${rosterNames.length}). Activá “Mostrar todo” si querés ver el feed completo.`
                : "Podés activar “Mostrar todo” para ver el feed completo."}
            </div>
          </div>

          <div className="newsControls">
            <div className="newsToggles">
              <button
                type="button"
                className={`newsToggle ${sources.ESPN ? "active" : ""}`}
                onClick={() => toggleSource("ESPN")}
                aria-pressed={sources.ESPN}
              >
                ESPN
              </button>
              <button
                type="button"
                className={`newsToggle ${sources.FantasyPros ? "active" : ""}`}
                onClick={() => toggleSource("FantasyPros")}
                aria-pressed={sources.FantasyPros}
              >
                FantasyPros
              </button>
              <button
                type="button"
                className={`newsToggle ${showAll ? "active" : ""}`}
                onClick={() => setShowAll((v) => !v)}
                aria-pressed={showAll}
              >
                Mostrar todo
              </button>
            </div>

            <div className="newsSearch">
              <span className="newsSearchIcon" aria-hidden="true">⌕</span>
              <input
                className="newsSearchInput"
                placeholder="Buscar noticia..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="newsStats">
          <span className="newsStatPill">{loading ? "Cargando…" : `${activeCount} noticias`}</span>
          <span className="muted" style={{ fontWeight: 800 }}>
            {showAll ? "Mostrando feed completo" : "Mostrando solo tus jugadores"}
          </span>
        </div>

        <div className="newsList">
          {loading ? (
            <>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="newsItem skeleton">
                  <div className="skLine w40" />
                  <div className="skLine w85" />
                  <div className="skLine w70" />
                  <div className="skChips">
                    <span className="skChip" />
                    <span className="skChip" />
                    <span className="skChip" />
                  </div>
                </div>
              ))}
            </>
          ) : err ? (
            <div className="muted" style={{ fontWeight: 900 }}>{err}</div>
          ) : filtered.length === 0 ? (
            <div className="muted" style={{ fontWeight: 900 }}>
              No hay noticias para mostrar con estos filtros.
            </div>
          ) : (
            filtered.map((it) => {
              const hay = norm(`${it.title || ""} ${it.description || ""}`);

              // menciones: primero por lista explícita si existe, sino por matching sobre texto
              const explicit = extractExplicitPlayers(it);
              const hits = explicit.length
                ? rosterNames.filter((rn) => explicit.map(norm).includes(norm(rn)))
                : rosterNames.filter((n) => matchesPlayer(n, hay));

              const mentions = hits.slice(0, 5);
              const srcKey = it.sourceKey || normSourceKey(it.source);

              return (
                <article key={String(it.id || it.guid || it.url || `${srcKey}-${it.publishedTs}-${it.title}`)} className="newsItem">
                  <div className="newsItemTop">
                    <div className="newsItemMeta">
                      <span className={`newsSourcePill src-${srcKey}`}>{srcKey}</span>
                      <span className="newsTime">{it.publishedAt ? fmtDate(it.publishedAt) : "—"}</span>
                      {it.publishedTs ? <span className="newsRel">{relTime(it.publishedTs)}</span> : null}
                    </div>

                    {it.url ? (
                      <a className="newsOpenBtn" href={it.url} target="_blank" rel="noreferrer">
                        Abrir ↗
                      </a>
                    ) : null}
                  </div>

                  {it.url ? (
                    <a className="newsHeadline" href={it.url} target="_blank" rel="noreferrer">
                      {it.title || "Noticia"}
                    </a>
                  ) : (
                    <div className="newsHeadline" style={{ cursor: "default" }}>{it.title || "Noticia"}</div>
                  )}

                  {it.description ? (
                    <div className="newsDesc">
                      {String(it.description).replace(/<[^>]+>/g, "").slice(0, 260)}
                      {String(it.description).length > 260 ? "…" : ""}
                    </div>
                  ) : null}

                  {mentions.length ? (
                    <div className="newsMentions">
                      {mentions.map((m) => {
                        const mm = mentionMeta(m);
                        return (
                          <span key={m} className="mentionChip" title={m}>
                            <span className="mentionAv">
                              {mm?.img ? <img src={mm.img} alt={m} /> : m.split(" ").slice(0, 2).map((x) => x[0]).join("")}
                            </span>
                            <span className="mentionTxt">{m}</span>
                          </span>
                        );
                      })}
                      {hits.length > mentions.length ? (
                        <span className="mentionMore">+{hits.length - mentions.length}</span>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </div>

        <div className="newsFoot">
          Contenido provisto por sus respectivas fuentes. Se muestra título/resumen del feed y se enlaza al artículo original.
        </div>
      </div>
    </div>
  );
}

// ---- A

function FancySelect({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  const current = options.includes(value) ? value : options[0];

  function choose(opt) {
    onChange?.(opt);
    setOpen(false);
  }

  return (
    <div className="selectWrap" ref={ref}>
      <button
        type="button"
        className="selectBtn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current}</span>
        <span className="selectCaret" aria-hidden="true" />
      </button>

      {open && (
        <div className="selectMenu" role="listbox">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              className={"selectOpt" + (opt === current ? " active" : "")}
              onClick={() => choose(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ======================
// Chats (propuestas 1 a 1)
// ======================
function ChatsView({ me, teams, teamsByUser, metaById }) {
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(false);

  const [myGivePlayers, setMyGivePlayers] = useState([]);
  const [myGivePicks, setMyGivePicks] = useState([]);
  const [myGetPlayers, setMyGetPlayers] = useState([]);
  const [myGetPicks, setMyGetPicks] = useState([]);

  const [giveTab, setGiveTab] = useState("players"); // players | picks
  const [getTab, setGetTab] = useState("players");
  const [giveQ, setGiveQ] = useState("");
  const [getQ, setGetQ] = useState("");

  const [editingId, setEditingId] = useState(null);
  const [savingTrade, setSavingTrade] = useState(false);
  const [info, setInfo] = useState("");

  const otherTeams = useMemo(() => {
    const arr = (teams || []).filter((t) => t && t.user_id && t.user_id !== me?.id);
    return arr.sort((a, b) => {
      const an = String(a.team_name || a.display_name || a.user_id).toLowerCase();
      const bn = String(b.team_name || b.display_name || b.user_id).toLowerCase();
      return an.localeCompare(bn);
    });
  }, [teams, me?.id]);

  useEffect(() => {
    if (!selectedUserId && otherTeams.length) setSelectedUserId(otherTeams[0].user_id);
  }, [selectedUserId, otherTeams]);

  async function refreshTrades() {
    if (!me?.id) return;
    setLoading(true);
    try {
      const rows = await fsGetTradesForUser(me.id);
      const sorted = (rows || []).slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
      setTrades(sorted);
    } catch (e) {
      console.error(e);
      setTrades([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!me?.id) return;
    refreshTrades().catch(console.error);
  }, [me?.id]);

  const myRow = useMemo(() => (me ? teamsByUser.get(me.id) : null), [me, teamsByUser]);
  const otherRow = useMemo(() => (selectedUserId ? teamsByUser.get(selectedUserId) : null), [selectedUserId, teamsByUser]);

  const myRoster = useMemo(() => (Array.isArray(myRow?.roster) ? myRow.roster : []), [myRow]);
  const myPicks = useMemo(() => (Array.isArray(myRow?.picks) ? myRow.picks : []), [myRow]);
  const otherRoster = useMemo(() => (Array.isArray(otherRow?.roster) ? otherRow.roster : []), [otherRow]);
  const otherPicks = useMemo(() => (Array.isArray(otherRow?.picks) ? otherRow.picks : []), [otherRow]);

  const adpNum = (pid) => {
    const meta = metaById?.get(String(pid));
    const n = Number(meta?.adp ?? meta?.adp_ppr ?? meta?.ppr_adp ?? meta?.rank ?? meta?.adp_rank ?? NaN);
    return Number.isFinite(n) ? n : 999999;
  };

  const sortRosterByAdp = (arr) => (arr || []).slice().sort((a, b) => adpNum(a?.id) - adpNum(b?.id));
  const sortedMyRoster = useMemo(() => sortRosterByAdp(myRoster), [myRoster, metaById]);
  const sortedOtherRoster = useMemo(() => sortRosterByAdp(otherRoster), [otherRoster, metaById]);

  const pickSortKey = (id) => {
    const base = String(id || "").split("#")[0];
    const m1 = base.match(/^(\d{4})-(\d)\.(\d{2})$/);
    if (m1) return `${m1[1]}-${m1[2].padStart(2, "0")}-${m1[3]}`;
    const m2 = base.match(/^(\d{4})-(\d)$/);
    if (m2) return `${m2[1]}-${m2[2].padStart(2, "0")}-99`;
    return base;
  };

  const sortedMyPicks = useMemo(() => (myPicks || []).slice().sort((a, b) => pickSortKey(a?.id).localeCompare(pickSortKey(b?.id))), [myPicks]);
  const sortedOtherPicks = useMemo(() => (otherPicks || []).slice().sort((a, b) => pickSortKey(a?.id).localeCompare(pickSortKey(b?.id))), [otherPicks]);

  const playerMeta = (pid) => {
    const id = String(pid);
    const meta = metaById?.get(id);
    const fallback = (myRoster || []).concat(otherRoster || []).find((x) => String(x?.id) === id);
    const name = meta?.name || meta?.player_name || meta?.full_name || fallback?.name || `Jugador ${id}`;
    const pos = normPos(meta?.position || fallback?.pos || fallback?.position || "");
    const nfl = String(meta?.team || meta?.nfl || fallback?.nfl || "").toUpperCase();
    const img = pickImg(meta || fallback);
    return { id, name, pos, nfl, img };
  };

  const playerLabel = (pid) => {
    const m = playerMeta(pid);
    return `${m.name}${m.pos ? ` (${m.pos}${m.nfl ? " " + m.nfl : ""})` : ""}`;
  };

  const pickLabel = (pid) => {
    const id = String(pid || "");
    const base = id.split("#")[0];
    const label =
      (myPicks || []).concat(otherPicks || []).find((p) => String(p?.id) === id)?.label ||
      PICK_LABEL.get(base) ||
      base;
    return label;
  };

  const toggle = (arr, id) => {
    const s = String(id);
    return arr.includes(s) ? arr.filter((x) => x !== s) : [...arr, s];
  };

  const clearDraft = () => {
    setMyGivePlayers([]);
    setMyGivePicks([]);
    setMyGetPlayers([]);
    setMyGetPicks([]);
    setEditingId(null);
    setInfo("");
    setGiveTab("players");
    setGetTab("players");
    setGiveQ("");
    setGetQ("");
  };

  const threadTrades = useMemo(() => {
    if (!me?.id || !selectedUserId) return [];
    return (trades || []).filter((t) => {
      const parts = Array.isArray(t?.participants) ? t.participants : [];
      return parts.includes(me.id) && parts.includes(selectedUserId);
    });
  }, [trades, me?.id, selectedUserId]);

  const pendingForTeam = (uid) => {
    if (!me?.id || !uid) return 0;
    const meId = String(me.id);
    const otherId = String(uid);
    return (trades || []).filter((t) => {
      const parts = Array.isArray(t?.participants) ? t.participants : [];
      const st = String(t?.status || "PENDING").toUpperCase();
      return parts.includes(meId) && parts.includes(otherId) && st === "PENDING" && String(t?.to_user_id) === meId;
    }).length;
  };

  const draftValid = useMemo(() => {
    const hasGive = myGivePlayers.length + myGivePicks.length > 0;
    const hasGet = myGetPlayers.length + myGetPicks.length > 0;
    return hasGive || hasGet;
  }, [myGivePlayers, myGivePicks, myGetPlayers, myGetPicks]);

  async function submitTrade() {
    if (!me?.id || !selectedUserId) return;
    if (!draftValid) {
      setInfo("Elegí al menos 1 asset para armar una propuesta.");
      return;
    }
    setSavingTrade(true);
    setInfo("");
    try {
      const a = String(me.id);
      const b = String(selectedUserId);
      const participants = [a, b].sort();

      const payload = {
        participants,
        from_user_id: a,
        to_user_id: b,
        give: { players: myGivePlayers, picks: myGivePicks },
        get: { players: myGetPlayers, picks: myGetPicks },
        status: "PENDING",
        response: null,
      };

      if (editingId) {
        payload.response = null;
        payload.responded_at = null;
        payload.cancelled_at = null;
      }

      await fsUpsertTrade(editingId, payload);
      await refreshTrades();
      clearDraft();
      setInfo("Propuesta enviada.");
    } catch (e) {
      console.error(e);
      setInfo("Error al enviar la propuesta.");
    } finally {
      setSavingTrade(false);
    }
  }

  function loadForEdit(trade) {
    if (!trade) return;
    setEditingId(trade.id);
    setMyGivePlayers((trade?.give?.players || []).map(String));
    setMyGivePicks((trade?.give?.picks || []).map(String));
    setMyGetPlayers((trade?.get?.players || []).map(String));
    setMyGetPicks((trade?.get?.picks || []).map(String));
    setInfo("Editando propuesta… (al guardar, vuelve a Pendiente)");
    setGiveTab("players");
    setGetTab("players");
  }

  async function cancelTrade(tradeId) {
    if (!tradeId) return;
    if (!confirm("¿Cancelar esta propuesta?")) return;
    try {
      await fsCancelTrade(tradeId);
      await refreshTrades();
      if (editingId === tradeId) clearDraft();
    } catch (e) {
      console.error(e);
      alert("No se pudo cancelar.");
    }
  }

  async function respondTrade(tradeId, response) {
    if (!tradeId) return;
    try {
      await fsRespondTrade(tradeId, response);
      await refreshTrades();
    } catch (e) {
      console.error(e);
      alert("No se pudo guardar la respuesta.");
    }
  }

  const statusBadge = (t) => {
    const st = String(t?.status || "PENDING").toUpperCase();
    if (st === "CANCELLED") return <span className="chip danger">Cancelado</span>;
    if (st === "RESPONDED") {
      const r = String(t?.response || "");
      const txt = r === "LIKE" ? "Me gusta" : r === "NOPE" ? "No me gusta" : r === "MAYBE" ? "Puede ser" : "Respondido";
      const cls = r === "LIKE" ? "ok" : r === "NOPE" ? "danger" : r === "MAYBE" ? "warn" : "";
      return <span className={`chip ${cls}`}>{txt}</span>;
    }
    return <span className="chip">Pendiente</span>;
  };

  const teamLabel = (row) => String(row?.team_name || row?.display_name || row?.user_id || "Equipo");

  const renderAssetChip = (kind, id, onRemove) => {
    if (kind === "pick") {
      return (
        <button key={`pick-${id}`} type="button" className="chatAssetChip" onClick={onRemove} title="Quitar">
          <span className="chatPickIcon">P</span>
          <span className="chatAssetName">{pickLabel(id)}</span>
          <span className="chatX">×</span>
        </button>
      );
    }
    const m = playerMeta(id);
    return (
      <button key={`p-${id}`} type="button" className="chatAssetChip" onClick={onRemove} title="Quitar">
        <span className="chatAvSm">
          {m.img ? <img src={m.img} alt="" /> : <span className="chatAvFallback">{initials(m.name)}</span>}
        </span>
        <span className="chatAssetName">{m.name}</span>
        {m.pos ? <span className={`posMini posMini-${m.pos}`}>{m.pos}</span> : null}
        <span className="chatX">×</span>
      </button>
    );
  };

  const renderPlayerRow = (p, checked, onToggle) => {
    const m = playerMeta(p?.id);
    return (
      <button
        key={String(p.id)}
        type="button"
        className={`chatPickRow ${checked ? "active" : ""}`}
        onClick={onToggle}
      >
        <div className="chatPickLeft">
          <span className="chatAv">
            {m.img ? <img src={m.img} alt="" /> : <span className="chatAvFallback">{initials(m.name)}</span>}
          </span>
          <div className="chatPickText">
            <div className="chatPickName">{m.name}</div>
            <div className="chatPickSub">
              {m.pos ? <span className={`posMini posMini-${m.pos}`}>{m.pos}</span> : null}
              <span className="muted">{m.nfl || "—"}</span>
            </div>
          </div>
        </div>
        <span className="chatCheck">{checked ? "✓" : ""}</span>
      </button>
    );
  };

  const renderPickRow = (p, checked, onToggle) => {
    const label = pickLabel(p?.id);
    const sub = String(p?.id || "").split("#")[0];
    return (
      <button
        key={String(p.id)}
        type="button"
        className={`chatPickRow ${checked ? "active" : ""}`}
        onClick={onToggle}
      >
        <div className="chatPickLeft">
          <span className="chatPickIcon">{String(sub).slice(0, 4)}</span>
          <div className="chatPickText">
            <div className="chatPickName">{label}</div>
            <div className="chatPickSub">
              <span className="muted">{sub}</span>
            </div>
          </div>
        </div>
        <span className="chatCheck">{checked ? "✓" : ""}</span>
      </button>
    );
  };

  const filterList = (arr, q, kind) => {
    const qq = String(q || "").trim().toLowerCase();
    if (!qq) return arr;
    if (kind === "players") {
      return (arr || []).filter((p) => {
        const m = playerMeta(p?.id);
        return `${m.name} ${m.pos} ${m.nfl}`.toLowerCase().includes(qq);
      });
    }
    return (arr || []).filter((p) => pickLabel(p?.id).toLowerCase().includes(qq) || String(p?.id || "").toLowerCase().includes(qq));
  };

  const givePlayersList = useMemo(() => filterList(sortedMyRoster, giveQ, "players"), [sortedMyRoster, giveQ, metaById]);
  const givePicksList = useMemo(() => filterList(sortedMyPicks, giveQ, "picks"), [sortedMyPicks, giveQ, myPicks]);
  const getPlayersList = useMemo(() => filterList(sortedOtherRoster, getQ, "players"), [sortedOtherRoster, getQ, metaById]);
  const getPicksList = useMemo(() => filterList(sortedOtherPicks, getQ, "picks"), [sortedOtherPicks, getQ, otherPicks]);

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="row" style={{ alignItems: "center" }}>
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontWeight: 1100, fontSize: 20 }}>Chats</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Propuestas 1 a 1 en formato <b>trade card</b>. El otro usuario responde con: <b>Me gusta</b> / <b>No me gusta</b> / <b>Puede ser</b>.
          </div>
        </div>
        <div className="sp" />
        <button className="ghost" onClick={refreshTrades} disabled={loading}>
          {loading ? "Actualizando..." : "Actualizar"}
        </button>
      </div>

      <div className="chatsWrap" style={{ marginTop: 14 }}>
        <div className="chatList">
          <div className="row" style={{ alignItems: "baseline", marginBottom: 10 }}>
            <div className="muted" style={{ fontWeight: 1000 }}>Conversaciones</div>
            <div className="sp" />
            <span className="muted" style={{ fontSize: 12 }}>{otherTeams.length}</span>
          </div>

          {otherTeams.map((t) => {
            const pending = pendingForTeam(t.user_id);
            return (
              <div
                key={t.user_id}
                className={`chatItem ${selectedUserId === t.user_id ? "active" : ""}`}
                onClick={() => { setSelectedUserId(t.user_id); clearDraft(); }}
              >
                <div className="chatItemLeft">
                  <div className="chatTeamAvatar">{initials(teamLabel(t))}</div>
                  <div style={{ display: "grid", gap: 2 }}>
                    <div style={{ fontWeight: 1100 }}>{teamLabel(t)}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{t.display_name || t.user_id}</div>
                  </div>
                </div>

                <div className="chatItemRight">
                  <div className="chip" style={{ cursor: "default" }}>{normTeamStatus(t.team_status)}</div>
                  {pending ? <div className="chatDot" title="Pendientes">{pending}</div> : null}
                </div>
              </div>
            );
          })}
          {!otherTeams.length ? (
            <div className="muted" style={{ marginTop: 8 }}>No hay otros equipos todavía.</div>
          ) : null}
        </div>

        <div className="chatMain">
          <div className="card chatComposer" style={{ padding: 14, borderRadius: 18 }}>
            <div className="row" style={{ alignItems: "center" }}>
              <div style={{ display: "grid", gap: 2 }}>
                <div style={{ fontWeight: 1100 }}>Nueva propuesta</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Para: <b>{teamLabel(otherRow)}</b>
                </div>
              </div>
              <div className="sp" />
              {editingId ? <span className="chip warn">Editando</span> : <span className="chip">Nueva</span>}
            </div>

            <div className="tradeSides" style={{ marginTop: 12 }}>
              {/* GIVE */}
              <div className="tradeSide chatSide">
                <div className="chatSideTop">
                  <div className="chatSideTitle">Vos das</div>
                  <div className="chatSideCount">{myGivePlayers.length + myGivePicks.length}</div>
                </div>

                <div className="chatTabs">
                  <button type="button" className={`chatTab ${giveTab === "players" ? "active" : ""}`} onClick={() => setGiveTab("players")}>Jugadores</button>
                  <button type="button" className={`chatTab ${giveTab === "picks" ? "active" : ""}`} onClick={() => setGiveTab("picks")}>Picks</button>
                  <div className="sp" />
                  <input className="chatSearch" value={giveQ} onChange={(e) => setGiveQ(e.target.value)} placeholder={`Buscar ${giveTab === "players" ? "jugador" : "pick"}...`} />
                </div>

                <div className="chatSelected">
                  {(myGivePlayers.length || myGivePicks.length) ? (
                    <div className="chatChipsWrap">
                      {myGivePlayers.map((id) => renderAssetChip("player", id, () => setMyGivePlayers((a) => toggle(a, id))))}
                      {myGivePicks.map((id) => renderAssetChip("pick", id, () => setMyGivePicks((a) => toggle(a, id))))}
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: 12 }}>Seleccioná assets desde la lista de abajo.</div>
                  )}
                </div>

                <div className="chatPickList">
                  {giveTab === "players" ? (
                    givePlayersList.map((p) => renderPlayerRow(p, myGivePlayers.includes(String(p.id)), () => setMyGivePlayers((a) => toggle(a, p.id))))
                  ) : (
                    givePicksList.map((p) => renderPickRow(p, myGivePicks.includes(String(p.id)), () => setMyGivePicks((a) => toggle(a, p.id))))
                  )}
                  {giveTab === "players" && !givePlayersList.length ? <div className="muted">Sin jugadores</div> : null}
                  {giveTab === "picks" && !givePicksList.length ? <div className="muted">Sin picks</div> : null}
                </div>
              </div>

              {/* GET */}
              <div className="tradeSide chatSide">
                <div className="chatSideTop">
                  <div className="chatSideTitle">Vos recibís</div>
                  <div className="chatSideCount">{myGetPlayers.length + myGetPicks.length}</div>
                </div>

                <div className="chatTabs">
                  <button type="button" className={`chatTab ${getTab === "players" ? "active" : ""}`} onClick={() => setGetTab("players")}>Jugadores</button>
                  <button type="button" className={`chatTab ${getTab === "picks" ? "active" : ""}`} onClick={() => setGetTab("picks")}>Picks</button>
                  <div className="sp" />
                  <input className="chatSearch" value={getQ} onChange={(e) => setGetQ(e.target.value)} placeholder={`Buscar ${getTab === "players" ? "jugador" : "pick"}...`} />
                </div>

                <div className="chatSelected">
                  {(myGetPlayers.length || myGetPicks.length) ? (
                    <div className="chatChipsWrap">
                      {myGetPlayers.map((id) => renderAssetChip("player", id, () => setMyGetPlayers((a) => toggle(a, id))))}
                      {myGetPicks.map((id) => renderAssetChip("pick", id, () => setMyGetPicks((a) => toggle(a, id))))}
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: 12 }}>Seleccioná assets desde la lista de abajo.</div>
                  )}
                </div>

                <div className="chatPickList">
                  {getTab === "players" ? (
                    getPlayersList.map((p) => renderPlayerRow(p, myGetPlayers.includes(String(p.id)), () => setMyGetPlayers((a) => toggle(a, p.id))))
                  ) : (
                    getPicksList.map((p) => renderPickRow(p, myGetPicks.includes(String(p.id)), () => setMyGetPicks((a) => toggle(a, p.id))))
                  )}
                  {getTab === "players" && !getPlayersList.length ? <div className="muted">Sin jugadores</div> : null}
                  {getTab === "picks" && !getPicksList.length ? <div className="muted">Sin picks</div> : null}
                </div>
              </div>
            </div>

            <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
              {info ? <div className="muted" style={{ fontWeight: 1000 }}>{info}</div> : <div className="muted" style={{ fontSize: 12 }}>Tip: tocá un asset seleccionado para quitarlo.</div>}
              <div className="sp" />
              {editingId ? (
                <button className="ghost" onClick={clearDraft}>Cancelar edición</button>
              ) : (
                <button className="ghost" onClick={clearDraft}>Limpiar</button>
              )}
              <button disabled={savingTrade} onClick={submitTrade}>
                {savingTrade ? "Guardando..." : editingId ? "Guardar cambios" : "Enviar propuesta"}
              </button>
            </div>
          </div>

          <div className="card" style={{ padding: 14, borderRadius: 18 }}>
            <div className="row" style={{ alignItems: "baseline" }}>
              <div style={{ fontWeight: 1100 }}>Propuestas</div>
              <div className="sp" />
              <span className="muted" style={{ fontSize: 13 }}>{threadTrades.length} total</span>
            </div>

            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              {threadTrades.map((t) => {
                const isSender = String(t.from_user_id) === String(me.id);
                const isReceiver = String(t.to_user_id) === String(me.id);
                const st = String(t.status || "PENDING").toUpperCase();

                const givePlayers = (t?.give?.players || []).map(String);
                const givePicks = (t?.give?.picks || []).map(String);
                const getPlayers = (t?.get?.players || []).map(String);
                const getPicks = (t?.get?.picks || []).map(String);

                return (
                  <div key={t.id} className="tradeCard tradeCardNice">
                    <div className="tradeTop">
                      <div style={{ display: "grid", gap: 3 }}>
                        <div style={{ fontWeight: 1100 }}>
                          {isSender ? "Vos propusiste" : "Te propusieron"} · <span className="muted">{new Date(t.created_at || t.updated_at || Date.now()).toLocaleString()}</span>
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {isSender ? `Para: ${teamLabel(otherRow)}` : `De: ${teamLabel(otherRow)}`}
                        </div>
                      </div>

                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        {statusBadge(t)}
                        {isSender && st !== "CANCELLED" ? (
                          <>
                            <button className="ghost miniBtn" onClick={() => loadForEdit(t)}>Editar</button>
                            <button className="danger miniBtn" onClick={() => cancelTrade(t.id)}>Cancelar</button>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="tradeSides">
                      <div className="chatTradeSide">
                        <div className="muted" style={{ fontWeight: 1000, marginBottom: 8 }}>{isSender ? "Vos das" : "Te dan"}</div>
                        <div className="chatChipsWrap">
                          {givePlayers.map((id) => (
                            <span key={`gp-${t.id}-${id}`} className="chatMiniChip">
                              <span className="chatAvSm">
                                {playerMeta(id).img ? <img src={playerMeta(id).img} alt="" /> : <span className="chatAvFallback">{initials(playerMeta(id).name)}</span>}
                              </span>
                              <span className="chatMiniText">{playerMeta(id).name}</span>
                              {playerMeta(id).pos ? <span className={`posMini posMini-${playerMeta(id).pos}`}>{playerMeta(id).pos}</span> : null}
                            </span>
                          ))}
                          {givePicks.map((id) => (
                            <span key={`gk-${t.id}-${id}`} className="chatMiniChip">
                              <span className="chatPickIcon">P</span>
                              <span className="chatMiniText">{pickLabel(id)}</span>
                            </span>
                          ))}
                          {(!givePlayers.length && !givePicks.length) ? <span className="muted">—</span> : null}
                        </div>
                      </div>

                      <div className="chatTradeSide">
                        <div className="muted" style={{ fontWeight: 1000, marginBottom: 8 }}>{isSender ? "Vos recibís" : "Te piden"}</div>
                        <div className="chatChipsWrap">
                          {getPlayers.map((id) => (
                            <span key={`rp-${t.id}-${id}`} className="chatMiniChip">
                              <span className="chatAvSm">
                                {playerMeta(id).img ? <img src={playerMeta(id).img} alt="" /> : <span className="chatAvFallback">{initials(playerMeta(id).name)}</span>}
                              </span>
                              <span className="chatMiniText">{playerMeta(id).name}</span>
                              {playerMeta(id).pos ? <span className={`posMini posMini-${playerMeta(id).pos}`}>{playerMeta(id).pos}</span> : null}
                            </span>
                          ))}
                          {getPicks.map((id) => (
                            <span key={`rk-${t.id}-${id}`} className="chatMiniChip">
                              <span className="chatPickIcon">P</span>
                              <span className="chatMiniText">{pickLabel(id)}</span>
                            </span>
                          ))}
                          {(!getPlayers.length && !getPicks.length) ? <span className="muted">—</span> : null}
                        </div>
                      </div>
                    </div>

                    {isReceiver && st === "PENDING" ? (
                      <div className="row" style={{ justifyContent: "flex-end", gap: 10 }}>
                        <button className="ok" onClick={() => respondTrade(t.id, "LIKE")}>Me gusta</button>
                        <button className="warn" onClick={() => respondTrade(t.id, "MAYBE")}>Puede ser</button>
                        <button className="danger" onClick={() => respondTrade(t.id, "NOPE")}>No me gusta</button>
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: 12 }}>
                        Estado: <b>{st === "PENDING" ? "Pendiente" : st === "RESPONDED" ? "Respondido" : "Cancelado"}</b>
                      </div>
                    )}
                  </div>
                );
              })}

              {!threadTrades.length ? <div className="muted">Todavía no hay propuestas con este equipo.</div> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}



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
  const [myTeamStatus,  setMyTeamStatus]  = useState("Indefinido");

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
      setMyTeamStatus(normTeamStatus(row.team_status));
    } else {
      setMyDisplayName(me.email?.split("@")?.[0] || "");
      setMyTeamName("");
      setMyTeamStatus("Indefinido");
    }
  }, [me, teamsByUser]);

  const myOutgoing = useMemo(() => (me ? interests.filter((x) => x.from_user_id === me.id && x.from_user_id !== x.to_user_id) : []), [me, interests]);
  const myIncoming = useMemo(() => (me ? interests.filter((x) => x.to_user_id   === me.id && x.from_user_id !== x.to_user_id) : []), [me, interests]);
  const myRoster   = useMemo(() => (Array.isArray(myRow?.roster) ? myRow.roster : []), [myRow]);
  const myPicks    = useMemo(() => (Array.isArray(myRow?.picks)  ? myRow.picks  : []), [myRow]);

  // ADP map para ordenar el roster (por player_id)
  const adpById = useMemo(() => {
    const m = new Map();
    (players || []).forEach((p) => m.set(String(p.player_id), p));
    return m;
  }, [players]);

  // Slots auto-ordenados por ADP: primero posiciones (QB/RB/WR/TE), luego FLEX, luego BN
  const slots      = useMemo(() => assignSlots(myRoster, adpById), [myRoster, adpById]);

  const metaById = useMemo(() => {
    const m = new Map();
    // Guardamos el objeto completo (incluye headshot/img si existe)
    for (const p of players) {
      m.set(String(p?.player_id ?? p?.id ?? ""), p);
    }
    for (const t of teams) {
      for (const r of t.roster || []) {
        const id = String(r.id);
        if (!m.has(id)) m.set(id, r);
      }
    }
    return m;
  }, [players, teams]);

  // ---- Value editor modal state ----
  const [valueEditor, setValueEditor] = useState({ open: false, id: null });

  const openValueEditor = (id) => {
    const pid = String(id);
    setValueEditor({ open: true, id: pid });
  };
  const closeValueEditor = () => setValueEditor({ open: false, id: null });

  const valueRow = useMemo(() => {
    if (!valueEditor.open || !valueEditor.id) return null;
    return (myRoster || []).find((r) => String(r.id) === String(valueEditor.id)) || null;
  }, [valueEditor.open, valueEditor.id, myRoster]);

  const valueMeta = useMemo(() => {
    if (!valueEditor.open || !valueEditor.id) return null;
    return metaById.get(String(valueEditor.id)) || null;
  }, [valueEditor.open, valueEditor.id, metaById]);

  const valuePlayerName = valueRow?.name || valueMeta?.name || "Jugador";
  const valuePlayerPos = normPos(valueRow?.pos || valueMeta?.position || valueMeta?.pos || "?");

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
        team_status: "Indefinido",
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
          team_status: "Indefinido",
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
          team_status: "Indefinido",
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
    if (String(toUserId) === String(me.id)) return;
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
          <div className="brand">Fantasy Trade Board</div>
          <div className="sp" />
          {playersLoading ? <div className="chip" style={{ cursor: "default" }}>ADP…</div> : null}
          {me ? <div className="chip" style={{ cursor: "default" }}>{me.email}</div> : null}
          {me ? <button className="chip" onClick={logout}>Salir</button> : null}
        </div>
      </div>

      <div className="wrap">
        
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
            {tab === "team" ? (
            <div className="card profileCard">
              <div className="grid2">
                <div>
                  <div style={{ fontWeight: 1000, fontSize: 18 }}>{myDisplayName || me.email}</div>
                  <div className="muted" style={{ fontWeight: 900 }}>{myTeamName || "Sin nombre de equipo"}</div>
                  <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                    Slots: 1QB 2RB 2WR 1TE 3FLEX 21BN
                  </div>
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {tab === "team" ? (
                    <>
                      <div className="row profileRow">
                        <input value={myDisplayName} onChange={(e) => setMyDisplayName(e.target.value)} placeholder="Tu nombre" />
                        <input value={myTeamName}    onChange={(e) => setMyTeamName(e.target.value)}    placeholder="Nombre del equipo" />
                        <FancySelect value={myTeamStatus} onChange={setMyTeamStatus} options={TEAM_STATUS_OPTIONS} />
                      </div>
                      <div className="row profileActions">
                        {saveInfo ? <div className="muted" style={{ fontWeight: 900 }}>{saveInfo}</div> : null}
                        <div className="sp" />
                        <button disabled={saving} onClick={saveMyProfile}>Guardar perfil</button>
                      </div>
                    </>
                  ) : (
                    <div className="row profileActions">
                      <div className="chip" style={{ cursor: "default" }}>{myTeamStatus || "Indefinido"}</div>
                      <div className="sp" />
                      <button className="ghost" onClick={() => setTab("team")}>Editar en Mi equipo</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            ) : null}

            {tab === "chats" ? (
              <ChatsView me={me} teams={teams} teamsByUser={teamsByUser} metaById={metaById} />
            ) : tab === "home" ? (
              <HomeNewsView myRoster={myRoster} metaById={metaById} />
            ) : tab === "interests" ? (
              <InterestsView teamsByUser={teamsByUser} myOutgoing={myOutgoing} myIncoming={myIncoming} metaById={metaById} />
            ) : tab === "league" ? (
              <LeagueView me={me} teams={teams} interests={interests} onSetInterest={setInterest} metaById={metaById} />
            ) : (
              <MyTeamView
                players={players}
                myRoster={myRoster}
                myPicks={myPicks}
                slots={slots}
                saving={saving}
                onAddPlayer={(p) => updateMyTeam((t) => {
                  const pid = String(p?.player_id ?? p?.id ?? "");
                  if (!pid) return t;
                  const pname = p?.name || p?.player_name || p?.full_name || p?.player || "";
                  const posRaw = p?.position ?? p?.pos ?? p?.player_position ?? "";
                  const exists = (t.roster || []).some((r) => String(r.id) === pid);
                  if (exists) return t;
                  return { ...t, roster: [...(t.roster || []), { id: pid, name: pname || `Jugador ${pid}`, pos: normPos(posRaw), nfl: p?.team || p?.nfl || "", status: "AVAILABLE" }] };
                }, "add player")}
                onRemovePlayer={(id) => updateMyTeam((t) => ({
                  ...t, roster: (t.roster || []).filter((r) => String(r.id) !== String(id)),
                }), "remove player")}
                onTogglePlayerStatus={(id) => updateMyTeam((t) => ({
                  ...t,
                  roster: (t.roster || []).map((r) => String(r.id) !== String(id) ? r : { ...r, status: cycleStatus(r.status || "AVAILABLE") }),
                }), "toggle status")}
                onAddPick={(baseId) => updateMyTeam((t) => {
                  const base = String(baseId || "");
                  if (!base) return t;

                  const year = base.slice(0, 4);
                  const is2026 = year === "2026";
                  const cur = Array.isArray(t.picks) ? t.picks : [];
                  const toBase = (id) => String(id || "").split("#")[0];

                  const sameBase = cur.filter((p) => String(p?.base || toBase(p?.id)) === base).length;

                  // 2026: único por pick. 2027/2028: permite duplicados por ronda.
                  if (is2026 && sameBase > 0) return t;

                  const newId = is2026 ? base : `${base}#${sameBase + 1}`;
                  const label = PICK_LABEL.get(base) || base;

                  return { ...t, picks: [...cur, { id: newId, base, label, status: "AVAILABLE" }] };
                }, "add pick")}
                onRemovePick={(pickIdOrIds) => updateMyTeam((t) => {
                  const cur = Array.isArray(t.picks) ? t.picks : [];
                  const ids = Array.isArray(pickIdOrIds) ? pickIdOrIds : [pickIdOrIds];
                  const idSet = new Set(ids.map((x) => String(x)));
                  return { ...t, picks: cur.filter((p) => !idSet.has(String(p.id))) };
                }, "remove pick")}
                onTogglePickStatus={(pickIdOrIds) => updateMyTeam((t) => {
                  const cur = Array.isArray(t.picks) ? t.picks : [];
                  const ids = Array.isArray(pickIdOrIds) ? pickIdOrIds : [pickIdOrIds];
                  const idSet = new Set(ids.map((x) => String(x)));

                  // Elegimos status base del primero que exista
                  const first = cur.find((p) => idSet.has(String(p.id)));
                  const next = cycleStatus(first?.status || "AVAILABLE");

                  return {
                    ...t,
                    picks: cur.map((p) => (idSet.has(String(p.id)) ? { ...p, status: next } : p)),
                  };
                }, "toggle pick status")}
                onSetPlayerValue={openValueEditor}
              />
            )}
          </>
        )}
      </div>

      <ValueModal
        open={valueEditor.open}
        playerName={valuePlayerName}
        playerPos={valuePlayerPos}
        initial={valueRow}
        saving={saving}
        onClose={closeValueEditor}
        onSave={(payload) => {
          const id = valueEditor.id;
          if (!id) return;
          updateMyTeam((t) => ({
            ...t,
            roster: (t.roster || []).map((r) => (String(r.id) === String(id) ? { ...r, ...payload } : r)),
          }), "set value modal");
          closeValueEditor();
        }}
        onDelete={() => {
          const id = valueEditor.id;
          if (!id) return;
          updateMyTeam((t) => ({
            ...t,
            roster: (t.roster || []).map((r) => (String(r.id) === String(id) ? { ...r, value: "", value_tier: null, value_picks: [], value_custom: "", value_note: "" } : r)),
          }), "delete value");
          closeValueEditor();
        }}
      />


      {me ? (
        <div className="dock">
          <div className="dockin">
            <button className={`dockbtn ${tab === "home"      ? "active" : ""}`} onClick={() => setTab("home")}>Inicio</button>
            <button className={`dockbtn ${tab === "league"    ? "active" : ""}`} onClick={() => setTab("league")}>Liga</button>
            <button className={`dockbtn ${tab === "chats"    ? "active" : ""}`} onClick={() => setTab("chats")}>Chats</button>
            <button className={`dockbtn ${tab === "interests" ? "active" : ""}`} onClick={() => setTab("interests")}>Intereses</button>
            <button className={`dockbtn ${tab === "team"      ? "active" : ""}`} onClick={() => setTab("team")}>Mi equipo</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
