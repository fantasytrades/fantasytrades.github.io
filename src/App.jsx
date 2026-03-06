import { useEffect, useMemo, useRef, useState } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
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

      /* Top bar */
      .top{ position:sticky; top:0; z-index:50; background:#fff; border-bottom:1px solid var(--border); }
      .topin{ max-width:1180px; margin:0 auto; padding:12px 14px; display:flex; gap:10px; align-items:center; }
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

      /* Cards */
      .card{
        background:var(--card); border:1px solid var(--border); border-radius:18px; padding:16px;
        box-shadow:var(--shadow-sm);
      }
      .row{ display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .title{ margin:6px 0 14px; letter-spacing:-0.02em; }

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
      .dockin{ max-width:1180px; margin:0 auto; padding:10px 12px; display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
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
      .badge{ padding:6px 10px; border-radius:999px; border:1px solid var(--border); background:#F1F5F9; font-weight:1000; font-size:12px; color:#0F172A; }

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
        .rosterItem > .left{ grid-column:2; }
        .rosterItem > .rosterActions{ grid-column:2; grid-row:2; justify-content:flex-start; margin-top:8px; }
        .rosterActions{ justify-content:flex-start; flex-wrap:wrap; }
        .rosterActions .valueBtn, .rosterActions .statusBtn{ min-width:0; }
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

      
/* === Chats === */
.teamRowBtn{
  width:100%;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding:12px 12px;
  border-radius:16px;
  border:1px solid var(--border);
  background:#fff;
  cursor:pointer;
  text-align:left;
}
.teamRowBtn.active{ outline:3px solid rgba(47,125,246,0.18); border-color:#CFE3FF; background:#F6FAFF; }
.tradeCard{
  border:1px solid var(--border);
  background:#fff;
  border-radius:18px;
  padding:14px;
}
.tradeCardTop{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  flex-wrap:wrap;
  margin-bottom:10px;
}
.tradeGrid{
  display:grid;
  grid-template-columns: 1fr 1fr;
  gap:12px;
}
.tradeSideTitle{ font-weight:1100; margin-bottom:6px; }
.tradeChips{ display:flex; gap:8px; flex-wrap:wrap; }
.tradeActions{ display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
.tradeBuilder{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.tradeBuilderTitle{ font-size:16px; font-weight:1100; margin-bottom:8px; }
.tradePickList{ border:1px solid var(--border); border-radius:16px; padding:10px; background:#fff; max-height:320px; overflow:auto; }
.checkRow{ display:flex; align-items:flex-start; gap:10px; padding:8px; border-radius:12px; }
.checkRow:hover{ background:#F8FAFC; }
.checkMain{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-weight:900; }
@media(max-width:900px){
  .tradeGrid{ grid-template-columns:1fr; }
  .tradeBuilder{ grid-template-columns:1fr; }
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
\n    `}</style>
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
        return String(p.name || "").toLowerCase().includes(qq);
      })
      .slice(0, 250);
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
      <div className="grid2">
        {/* Left: Players / Picks list */}
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
                  const id = String(p.player_id);
                  const added = rosterIds.has(id);
                  const pos = normPos(p.position);
                  const img = pickImg(p);
                  return (
                    <div key={id} className="item itemTight">
                      <div className="left">
                        <div className="av">{img ? <img src={img} alt={p.name} /> : initials(p.name)}</div>
                        <div style={{ minWidth: 0 }}>
                          <div className="name">{p.name}</div>
                          <div className="muted sub"><span className={`posMini posMini-${pos}`}>{pos}</span>{p.team || "-"} {p.adp_formatted ? `· ADP ${p.adp_formatted}` : ""}</div>
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
      <div className="card profileCard">
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
                const meta = metaById?.get(String(r.id));
                const img = pickImg(meta) || pickImg(r);
                const stKey = normStatusKey(r.status);
                return (
                  <div key={r.id} className="item">
                    <div className="left">
                      <div className="av">{img ? <img src={img} alt={r.name} /> : initials(r.name)}</div>
                      <div style={{ minWidth: 0 }}>
                        <div className="name">{r.name}</div>
                        <div className="muted sub">
                          {normPos(r.pos)} · {r.nfl || "-"} · <span className={`pill pill-${stKey}`}>{STATUS_LABEL[stKey]}</span>
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

function ChatsView({ me, teams, myRoster, myPicks, metaById }) {
  const myId = String(me?.id || "");
  const teamsByUser = useMemo(() => {
    const m = new Map();
    (teams || []).forEach((t) => m.set(String(t.user_id), t));
    return m;
  }, [teams]);

  const otherTeams = useMemo(() => (teams || []).filter((t) => String(t.user_id) !== myId), [teams, myId]);

  const [threads, setThreads] = useState([]);
  const [activeOtherId, setActiveOtherId] = useState("");
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingProps, setLoadingProps] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [err, setErr] = useState("");

  const threadId = useMemo(() => {
    if (!activeOtherId) return "";
    return [myId, String(activeOtherId)].sort().join("__");
  }, [myId, activeOtherId]);

  const activeOtherTeam = useMemo(() => teamsByUser.get(String(activeOtherId)) || null, [teamsByUser, activeOtherId]);

  const normalizePlayer = (p) => {
    const id = String(p?.id ?? p?.player_id ?? p?.playerId ?? "");
    const meta = metaById?.get?.(id) || null;
    const name = String(meta?.name || p?.name || p?.player_name || p?.full_name || "").trim();
    const pos = String(meta?.pos || p?.pos || p?.position || "").trim();
    const nfl = String(meta?.nfl || p?.nfl || p?.team || "").trim();
    return { id, name, pos, nfl, img: pickImg(meta) || pickImg(p) || "" };
  };

  const myPlayers = useMemo(() => (myRoster || []).map(normalizePlayer).filter((x) => x.id && x.name), [myRoster, metaById]);
  const otherPlayers = useMemo(() => {
    const r = activeOtherTeam?.roster || [];
    return r.map(normalizePlayer).filter((x) => x.id && x.name);
  }, [activeOtherTeam, metaById]);

  const myPicksList = useMemo(
    () => (myPicks || []).map((p) => ({ id: String(p.id || p), label: String(p.label || p.id || p) })),
    [myPicks]
  );
  const otherPicksList = useMemo(() => {
    const ps = activeOtherTeam?.picks || [];
    return ps.map((p) => ({ id: String(p.id || p), label: String(p.label || p.id || p) }));
  }, [activeOtherTeam]);

  async function ensureThread(otherId) {
    const tid = [myId, String(otherId)].sort().join("__");
    const ref = doc(db, "threads", tid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, { thread_id: tid, user_ids: [myId, String(otherId)], updated_at: Date.now() });
    }
    return tid;
  }

  async function loadThreads() {
    if (!myId) return;
    setLoadingThreads(true);
    setErr("");
    try {
      const qy = query(
        collection(db, "threads"),
        where("user_ids", "array-contains", myId),
        orderBy("updated_at", "desc")
      );
      const snap = await getDocs(qy);
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setThreads(rows);
      if (!activeOtherId && rows.length) {
        const t = rows[0];
        const other = (t.user_ids || []).find((x) => String(x) !== myId) || "";
        if (other) setActiveOtherId(String(other));
      }
    } catch (e) {
      setErr("No pude cargar chats.");
    } finally {
      setLoadingThreads(false);
    }
  }

  async function loadProposals(tid) {
    if (!tid) return;
    setLoadingProps(true);
    setErr("");
    try {
      const qy = query(collection(db, "threads", tid, "proposals"), orderBy("created_at", "desc"));
      const snap = await getDocs(qy);
      setProposals(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      setErr("No pude cargar propuestas.");
      setProposals([]);
    } finally {
      setLoadingProps(false);
    }
  }

  useEffect(() => { loadThreads(); }, [myId]);

  useEffect(() => {
    (async () => {
      if (!threadId) { setProposals([]); return; }
      await ensureThread(activeOtherId);
      await loadProposals(threadId);
    })();
  }, [threadId]);

  const [composerOpen, setComposerOpen] = useState(false);
  const [editProposal, setEditProposal] = useState(null);

  const [giveSel, setGiveSel] = useState({ players: new Set(), picks: new Set() });
  const [getSel, setGetSel] = useState({ players: new Set(), picks: new Set() });
  const [searchGive, setSearchGive] = useState("");
  const [searchGet, setSearchGet] = useState("");

  const resetComposer = () => {
    setGiveSel({ players: new Set(), picks: new Set() });
    setGetSel({ players: new Set(), picks: new Set() });
    setSearchGive("");
    setSearchGet("");
    setEditProposal(null);
  };

  const openNew = () => { resetComposer(); setComposerOpen(true); };
  const openEdit = (p) => {
    resetComposer();
    setEditProposal(p);
    setGiveSel({ players: new Set((p?.give?.players || []).map(String)), picks: new Set((p?.give?.picks || []).map(String)) });
    setGetSel({ players: new Set((p?.get?.players || []).map(String)),  picks: new Set((p?.get?.picks || []).map(String)) });
    setComposerOpen(true);
  };

  const toggleSet = (setObj, key, id) => {
    const next = new Set(setObj[key]);
    const sid = String(id);
    if (next.has(sid)) next.delete(sid); else next.add(sid);
    return { ...setObj, [key]: next };
  };

  const canInteract = useMemo(() => !!activeOtherId && !!myId, [activeOtherId, myId]);

  const listFilter = (items, q) => {
    const qq = String(q || "").toLowerCase().trim();
    if (!qq) return items;
    return items.filter((it) => {
      const hay = `${it.name || ""} ${it.pos || ""} ${it.nfl || ""} ${it.label || ""}`.toLowerCase();
      return hay.includes(qq);
    });
  };

  const fmtAssets = (side) => {
    const ps = (side?.players || []).map(String);
    const ks = (side?.picks || []).map(String);
    const pNames = ps.map((id) => metaById?.get?.(String(id))?.name || id);
    const kNames = ks;
    return [...pNames, ...kNames];
  };

  async function sendOrUpdateProposal() {
    if (!canInteract) return;
    const tid = await ensureThread(activeOtherId);

    const give = { players: Array.from(giveSel.players), picks: Array.from(giveSel.picks) };
    const get  = { players: Array.from(getSel.players),  picks: Array.from(getSel.picks)  };

    if (give.players.length + give.picks.length + get.players.length + get.picks.length === 0) {
      setErr("Elegí al menos un asset para enviar la propuesta.");
      return;
    }

    setErr("");
    const now = Date.now();
    try {
      if (editProposal?.id) {
        if (String(editProposal.from_user_id) !== myId || String(editProposal.status) !== "PENDING") return;
        await updateDoc(doc(db, "threads", tid, "proposals", editProposal.id), { give, get, updated_at: now });
      } else {
        await addDoc(collection(db, "threads", tid, "proposals"), {
          thread_id: tid,
          from_user_id: myId,
          to_user_id: String(activeOtherId),
          give,
          get,
          status: "PENDING",
          created_at: now,
          updated_at: now,
        });
      }
      await setDoc(doc(db, "threads", tid), { updated_at: now }, { merge: true });
      setComposerOpen(false);
      resetComposer();
      await loadProposals(tid);
    } catch (e) {
      setErr("No pude guardar la propuesta.");
    }
  }

  async function cancelProposal(p) {
    if (!canInteract) return;
    if (String(p.from_user_id) !== myId) return;
    if (String(p.status) !== "PENDING") return;
    try {
      const now = Date.now();
      await updateDoc(doc(db, "threads", threadId, "proposals", p.id), { status: "CANCELLED", updated_at: now });
      await setDoc(doc(db, "threads", threadId), { updated_at: now }, { merge: true });
      await loadProposals(threadId);
    } catch (e) {
      setErr("No pude cancelar la propuesta.");
    }
  }

  async function respondProposal(p, nextStatus) {
    if (!canInteract) return;
    if (String(p.to_user_id) !== myId) return;
    if (String(p.status) !== "PENDING") return;
    try {
      const now = Date.now();
      await updateDoc(doc(db, "threads", threadId, "proposals", p.id), { status: nextStatus, responded_at: now, updated_at: now });
      await setDoc(doc(db, "threads", threadId), { updated_at: now }, { merge: true });
      await loadProposals(threadId);
    } catch (e) {
      setErr("No pude responder la propuesta.");
    }
  }

  const statusLabel = (s) => {
    if (s === "PENDING") return "Pendiente";
    if (s === "LIKED") return "Me gusta";
    if (s === "NOPE") return "No me gusta";
    if (s === "MAYBE") return "Puede ser";
    if (s === "CANCELLED") return "Cancelada";
    return s || "—";
  };

  return (
    <div className="grid2" style={{ marginTop: 12 }}>
      <div className="card">
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
          <div style={{ fontSize:22, fontWeight:1100 }}>Chats</div>
          <button className="btn" onClick={loadThreads} disabled={loadingThreads}>Actualizar</button>
        </div>

        <div className="muted" style={{ marginTop: 6, fontWeight: 850 }}>
          Elegí un equipo para enviar propuestas de trade (1 a 1).
        </div>

        <div style={{ marginTop: 12, display:"grid", gap:10 }}>
          {(threads || []).map((t) => {
            const other = (t.user_ids || []).find((x) => String(x) !== myId) || "";
            const ot = teamsByUser.get(String(other));
            const active = String(other) === String(activeOtherId);
            return (
              <button
                key={t.id}
                className={`teamRowBtn ${active ? "active" : ""}`}
                onClick={() => setActiveOtherId(String(other))}
              >
                <div>
                  <div style={{ fontWeight: 1100 }}>{ot?.team_name || ot?.display_name || "Equipo"}</div>
                  <div className="muted" style={{ fontWeight: 850, fontSize: 12 }}>{ot?.display_name || other}</div>
                </div>
                <span className="pill pill-AVAILABLE">{active ? "Abierto" : "Abrir"}</span>
              </button>
            );
          })}

          <div style={{ borderTop:"1px solid var(--border)", marginTop:10, paddingTop:10 }}>
            <div className="muted" style={{ fontWeight: 1000, marginBottom: 8 }}>Iniciar chat con:</div>
            <select className="select" value={activeOtherId} onChange={(e) => setActiveOtherId(e.target.value)}>
              <option value="">— Elegir equipo —</option>
              {otherTeams.map((t) => (
                <option key={t.user_id} value={t.user_id}>
                  {t.team_name || t.display_name || t.user_id}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        {!activeOtherId ? (
          <div className="muted" style={{ fontWeight: 1000 }}>Elegí un equipo para ver el chat.</div>
        ) : (
          <>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, flexWrap:"wrap" }}>
              <div>
                <div style={{ fontSize:22, fontWeight:1100 }}>{activeOtherTeam?.team_name || "Chat"}</div>
                <div className="muted" style={{ fontWeight:850 }}>{activeOtherTeam?.display_name || activeOtherId}</div>
              </div>
              <button className="btn primary" onClick={openNew}>Nueva propuesta</button>
            </div>

            {err ? <div className="muted" style={{ marginTop:10, fontWeight:1000, color:"#991B1B" }}>{err}</div> : null}

            <div style={{ marginTop: 12, display:"grid", gap:12 }}>
              {loadingProps ? (
                <div className="muted" style={{ fontWeight: 1000 }}>Cargando…</div>
              ) : proposals.length === 0 ? (
                <div className="muted" style={{ fontWeight: 1000 }}>No hay propuestas todavía.</div>
              ) : (
                proposals.map((p) => {
                  const isMine = String(p.from_user_id) === myId;
                  const isPending = String(p.status) === "PENDING";
                  const canEdit = isMine && isPending;
                  const canCancel = isMine && isPending;
                  const canRespond = (!isMine) && isPending;

                  const give = fmtAssets(p.give);
                  const getA = fmtAssets(p.get);

                  return (
                    <div key={p.id} className="tradeCard">
                      <div className="tradeCardTop">
                        <div className="muted" style={{ fontWeight: 1000 }}>
                          {isMine ? "Enviada" : "Recibida"} • {new Date(p.created_at || Date.now()).toLocaleString()}
                        </div>
                        <span className={`pill ${p.status === "PENDING" ? "pill-LISTENING" : p.status === "LIKED" ? "pill-AVAILABLE" : p.status === "NOPE" ? "pill-NOT_AVAILABLE" : p.status === "MAYBE" ? "pill-LISTENING" : "pill"}`}>
                          {statusLabel(p.status)}
                        </span>
                      </div>

                      <div className="tradeGrid">
                        <div className="tradeSide">
                          <div className="tradeSideTitle">{isMine ? "Doy yo" : "Da él/ella"}</div>
                          <div className="tradeChips">
                            {give.length ? give.map((x, i) => <span key={i} className="valueChip">{x}</span>) : <span className="muted">—</span>}
                          </div>
                        </div>
                        <div className="tradeSide">
                          <div className="tradeSideTitle">{isMine ? "Recibo" : "Recibe él/ella"}</div>
                          <div className="tradeChips">
                            {getA.length ? getA.map((x, i) => <span key={i} className="valueChip">{x}</span>) : <span className="muted">—</span>}
                          </div>
                        </div>
                      </div>

                      {canRespond ? (
                        <div className="tradeActions">
                          <button className="interestBtn active-HIGH" onClick={() => respondProposal(p, "LIKED")}>Me gusta</button>
                          <button className="interestBtn active-MEDIUM" onClick={() => respondProposal(p, "MAYBE")}>Puede ser</button>
                          <button className="interestBtn active-LOW" onClick={() => respondProposal(p, "NOPE")}>No me gusta</button>
                        </div>
                      ) : null}

                      {canEdit || canCancel ? (
                        <div className="tradeActions" style={{ justifyContent:"flex-end" }}>
                          {canEdit ? <button className="btn" onClick={() => openEdit(p)}>Editar</button> : null}
                          {canCancel ? <button className="btn danger" onClick={() => cancelProposal(p)}>Cancelar</button> : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>

      {composerOpen ? (
        <div className="modalOverlay" onMouseDown={() => { setComposerOpen(false); resetComposer(); }}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">{editProposal ? "Editar propuesta" : "Nueva propuesta"}</div>
              <button className="iconBtn" onClick={() => { setComposerOpen(false); resetComposer(); }}>✕</button>
            </div>

            <div className="modalBody">
              <div className="muted" style={{ fontWeight: 900, marginBottom: 10 }}>
                Armá el trade con assets que vos y el otro equipo ya tienen (jugadores y picks).
              </div>

              <div className="tradeBuilder">
                <div className="tradeBuilderCol">
                  <div className="tradeBuilderTitle">Doy yo</div>
                  <input className="input" placeholder="Buscar..." value={searchGive} onChange={(e) => setSearchGive(e.target.value)} />
                  <div className="tradePickList">
                    <div className="muted" style={{ fontWeight: 1000, marginTop: 8 }}>Jugadores</div>
                    {listFilter(myPlayers, searchGive).map((p) => (
                      <label key={p.id} className="checkRow">
                        <input type="checkbox" checked={giveSel.players.has(p.id)} onChange={() => setGiveSel((s) => toggleSet(s, "players", p.id))} />
                        <span className="checkMain">
                          <span className={`posPill pos-${p.pos || "BN"}`}>{p.pos || "—"}</span>
                          <span style={{ fontWeight: 1100 }}>{p.name}</span>
                          <span className="muted">{p.nfl ? ` • ${p.nfl}` : ""}</span>
                        </span>
                      </label>
                    ))}
                    <div className="muted" style={{ fontWeight: 1000, marginTop: 10 }}>Picks</div>
                    {listFilter(myPicksList, searchGive).map((k) => (
                      <label key={k.id} className="checkRow">
                        <input type="checkbox" checked={giveSel.picks.has(k.id)} onChange={() => setGiveSel((s) => toggleSet(s, "picks", k.id))} />
                        <span className="checkMain"><span style={{ fontWeight: 1000 }}>{k.label}</span></span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="tradeBuilderCol">
                  <div className="tradeBuilderTitle">Recibo</div>
                  <input className="input" placeholder="Buscar..." value={searchGet} onChange={(e) => setSearchGet(e.target.value)} />
                  <div className="tradePickList">
                    <div className="muted" style={{ fontWeight: 1000, marginTop: 8 }}>Jugadores</div>
                    {listFilter(otherPlayers, searchGet).map((p) => (
                      <label key={p.id} className="checkRow">
                        <input type="checkbox" checked={getSel.players.has(p.id)} onChange={() => setGetSel((s) => toggleSet(s, "players", p.id))} />
                        <span className="checkMain">
                          <span className={`posPill pos-${p.pos || "BN"}`}>{p.pos || "—"}</span>
                          <span style={{ fontWeight: 1100 }}>{p.name}</span>
                          <span className="muted">{p.nfl ? ` • ${p.nfl}` : ""}</span>
                        </span>
                      </label>
                    ))}
                    <div className="muted" style={{ fontWeight: 1000, marginTop: 10 }}>Picks</div>
                    {listFilter(otherPicksList, searchGet).map((k) => (
                      <label key={k.id} className="checkRow">
                        <input type="checkbox" checked={getSel.picks.has(k.id)} onChange={() => setGetSel((s) => toggleSet(s, "picks", k.id))} />
                        <span className="checkMain"><span style={{ fontWeight: 1000 }}>{k.label}</span></span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                <div className="muted" style={{ fontWeight: 1000 }}>Preview:</div>
                <div style={{ display:"grid", gap:8, marginTop:8 }}>
                  <div><b>Doy yo:</b> {Array.from(giveSel.players).map((id) => metaById?.get?.(id)?.name || id).concat(Array.from(giveSel.picks)).join(" · ") || "—"}</div>
                  <div><b>Recibo:</b> {Array.from(getSel.players).map((id) => metaById?.get?.(id)?.name || id).concat(Array.from(getSel.picks)).join(" · ") || "—"}</div>
                </div>
              </div>
            </div>

            <div className="modalFooter">
              <button className="btn" onClick={() => { setComposerOpen(false); resetComposer(); }}>Cancelar</button>
              <button className="btn primary" onClick={sendOrUpdateProposal}>{editProposal ? "Actualizar" : "Enviar"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

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

  const myOutgoing = useMemo(() => (me ? interests.filter((x) => x.from_user_id === me.id) : []), [me, interests]);
  const myIncoming = useMemo(() => (me ? interests.filter((x) => x.to_user_id   === me.id) : []), [me, interests]);
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
      m.set(String(p.player_id), p);
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
          <div style={{ fontWeight: 1000 }}>Fantasy Trade Board</div>
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
                </div>
              </div>
            </div>

            {tab === "home" || tab === "interests" ? (
              <InterestsView teamsByUser={teamsByUser} myOutgoing={myOutgoing} myIncoming={myIncoming} metaById={metaById} />
            ) : tab === "league" ? (
              <LeagueView me={me} teams={teams} interests={interests} onSetInterest={setInterest} metaById={metaById} />
            ) : tab === "chats" ? (
              <ChatsView me={me} teams={teams} myRoster={myRoster} myPicks={myPicks} metaById={metaById} />
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
            <button className={`dockbtn ${tab === "interests" ? "active" : ""}`} onClick={() => setTab("interests")}>Intereses</button>
            <button className={`dockbtn ${tab === "chats"     ? "active" : ""}`} onClick={() => setTab("chats")}>Chats</button>
            <button className={`dockbtn ${tab === "team"      ? "active" : ""}`} onClick={() => setTab("team")}>Mi equipo</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
