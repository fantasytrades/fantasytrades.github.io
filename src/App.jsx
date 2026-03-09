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

function SafeImg({ src, alt = "", fallback = null }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) return fallback;
  return <img src={src} alt={alt} onError={() => setFailed(true)} />;
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


const DP_PICK_VALUES_1QB = {
  "2026-1.01": 41.6, "2026-1.02": 37.7, "2026-1.03": 34.2, "2026-1.04": 31.0, "2026-1.05": 28.3,
  "2026-1.06": 25.9, "2026-1.07": 23.7, "2026-1.08": 21.7, "2026-1.09": 20.0, "2026-1.10": 18.5,
};

const FP_METER_SEGMENTS = [
  { label: "Te Están Robando", shortLabel: "Robando", lines: ["Te Están", "Robando"], color: "#DC2626", textColor: "#FFFFFF", min: -100, max: -20, tone: "robbery" },
  { label: "Le Falta Algo", shortLabel: "Le Falta Algo", lines: ["Le Falta", "Algo"], color: "#F59E0B", textColor: "#FFFFFF", min: -20, max: -5, tone: "weak" },
  { label: "Parejo", shortLabel: "Parejo", lines: ["Parejo"], color: "#A3E635", textColor: "#FFFFFF", min: -5, max: 5, tone: "even" },
  { label: "Te Sirve", shortLabel: "Te Sirve", lines: ["Te Sirve"], color: "#22C55E", textColor: "#FFFFFF", min: 5, max: 20, tone: "good" },
  { label: "Estás Robando", shortLabel: "Estás Robando", lines: ["Estás", "Robando"], color: "#166534", textColor: "#FFFFFF", min: 20, max: 100, tone: "great" },
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeLookupName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFantasyProsValuesPayload(raw) {
  const out = {
    updatedAt: null,
    source: null,
    generatedFor: null,
    complete: false,
    counts: {},
    byId: {},
    byName: {},
    pickValues: {},
    hasLocalData: false,
  };

  if (!raw || typeof raw !== "object") return out;

  out.updatedAt = raw.updatedAt || raw.generatedAt || raw.updated_at || null;
  out.source = raw.source || raw.provider || "DynastyProcess";
  out.generatedFor = raw.generatedFor || raw.generated_for || raw.scoring || null;
  out.complete = Boolean(raw.complete ?? raw.isComplete ?? false);
  out.counts = raw.counts && typeof raw.counts === "object" ? raw.counts : {};

  const putPlayer = (playerId, playerName, value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const id = String(playerId || "").trim();
    const nm = normalizeLookupName(playerName);
    if (id) out.byId[id] = n;
    if (nm) out.byName[nm] = n;
  };

  if (Array.isArray(raw.players)) {
    raw.players.forEach((p) => {
      putPlayer(
        p?.id ?? p?.player_id ?? p?.playerId ?? p?.sleeper_id ?? "",
        p?.name ?? p?.player_name ?? p?.full_name ?? "",
        p?.value ?? p?.trade_value ?? p?.dynasty_value ?? p?.fp_value ?? p?.score
      );
    });
  }

  if (raw.byId && typeof raw.byId === "object") {
    Object.entries(raw.byId).forEach(([key, value]) => {
      const n = Number(value);
      if (Number.isFinite(n)) out.byId[String(key)] = n;
    });
  }

  if (raw.byName && typeof raw.byName === "object") {
    Object.entries(raw.byName).forEach(([key, value]) => {
      const n = Number(value);
      if (Number.isFinite(n)) out.byName[normalizeLookupName(key)] = n;
    });
  }

  if (raw.pickValues && typeof raw.pickValues === "object") {
    Object.entries(raw.pickValues).forEach(([key, value]) => {
      const n = Number(value);
      if (Number.isFinite(n)) out.pickValues[String(key)] = n;
    });
  }

  out.hasLocalData = Boolean(
    Object.keys(out.byId).length ||
    Object.keys(out.byName).length ||
    Object.keys(out.pickValues).length
  );

  return out;
}

function rankLikeValue(raw, fallback = NaN) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function estimateDynastyPlayerValue(meta, fallbackPos = "") {
  const pos = normPos(meta?.position || meta?.pos || fallbackPos || "");
  const rank = Math.min(
    rankLikeValue(meta?.dynasty_rank),
    rankLikeValue(meta?.ecr),
    rankLikeValue(meta?.rank),
    rankLikeValue(meta?.adp),
    rankLikeValue(meta?.adp_ppr),
    rankLikeValue(meta?.ppr_adp),
    rankLikeValue(meta?.adp_rank),
    rankLikeValue(meta?.adp_value),
    999999
  );

  let base;
  if (Number.isFinite(rank) && rank < 999999) {
    base = Math.round(110 / Math.pow(rank + 1, 0.48));
  } else {
    base = pos === "QB" ? 14 : pos === "RB" ? 18 : pos === "WR" ? 17 : pos === "TE" ? 12 : 10;
  }

  if (pos === "QB") base = Math.round(base * 0.82); // 1QB
  if (pos === "TE") base = Math.round(base * 0.94);
  if (pos === "WR") base = Math.round(base * 1.02);

  return clamp(base, 3, 80);
}

function fantasyProsPlayerValue(playerId, metaById, fpDynastyValues, fallbackName = "") {
  const id = String(playerId || "").trim();
  const meta = metaById?.get?.(id) || null;
  const exactMetaValue =
    Number(meta?.dynasty_value ?? meta?.trade_value ?? meta?.fantasypros_value ?? meta?.fp_value);

  if (Number.isFinite(exactMetaValue)) {
    return { value: exactMetaValue, source: "dp-meta" };
  }

  if (fpDynastyValues?.byId?.[id] != null) {
    return { value: Number(fpDynastyValues.byId[id]), source: "dp-local" };
  }

  const name =
    meta?.name ||
    meta?.player_name ||
    meta?.full_name ||
    fallbackName ||
    "";
  const key = normalizeLookupName(name);

  if (key && fpDynastyValues?.byName?.[key] != null) {
    return { value: Number(fpDynastyValues.byName[key]), source: "dp-local" };
  }

  return {
    value: estimateDynastyPlayerValue(meta, meta?.position || meta?.pos || ""),
    source: "fallback",
  };
}

function fantasyProsPickValue(pickId, fpDynastyValues) {
  const base = String(pickId || "").split("#")[0];

  if (fpDynastyValues?.pickValues?.[base] != null) {
    return { value: Number(fpDynastyValues.pickValues[base]), source: "dp-local" };
  }

  if (DP_PICK_VALUES_1QB[base] != null) {
    return { value: DP_PICK_VALUES_1QB[base], source: "dp-default" };
  }

  const detailed = base.match(/^(\d{4})-(\d)\.(\d{2})$/);
  if (detailed) {
    const year = Number(detailed[1]);
    const round = Number(detailed[2]);
    const slot = Number(detailed[3]);

    if (year === 2026 && round >= 2 && round <= 6) {
      const prev = fantasyProsPickValue(`${year}-${round - 1}.${String(slot).padStart(2, "0")}`, fpDynastyValues);
      if (Number.isFinite(prev?.value)) {
        const factor = round === 6 ? 0.8 : 0.82;
        return { value: Math.max(0.8, Math.round(prev.value * factor * 10) / 10), source: "dp-derived" };
      }
    }

    if ((year === 2027 || year === 2028) && round >= 1 && round <= 6) {
      const generic = fantasyProsPickValue(`${year}-${round}`, fpDynastyValues);
      if (Number.isFinite(generic?.value)) {
        return { value: generic.value, source: generic.source || "dp-derived" };
      }
    }
  }

  const generic = base.match(/^(\d{4})-(\d)$/);
  if (generic) {
    const year = Number(generic[1]);
    const round = Number(generic[2]);

    if (year === 2027 && round >= 1 && round <= 6) {
      const prev = round === 1 ? 18.0 : fantasyProsPickValue(`2027-${round - 1}`, fpDynastyValues);
      if (round === 1) return { value: 18.0, source: "dp-derived" };
      if (Number.isFinite(prev?.value)) {
        return { value: Math.max(0.8, Math.round(prev.value * 0.62 * 10) / 10), source: "dp-derived" };
      }
    }

    if (year === 2028 && round >= 1 && round <= 6) {
      const prevYear = fantasyProsPickValue(`2027-${round}`, fpDynastyValues);
      if (Number.isFinite(prevYear?.value)) {
        return { value: Math.max(0.8, Math.round(prevYear.value * 0.8 * 10) / 10), source: "dp-derived" };
      }
    }
  }

  return { value: 1.0, source: "fallback" };
}

function fantasyProsMeterLabel(advantagePct) {
  if (advantagePct < -20) return { label: "Te están robando", tone: "robbery" };
  if (advantagePct < -5) return { label: "Le falta algo", tone: "weak" };
  if (advantagePct <= 5) return { label: "Parejo", tone: "even" };
  if (advantagePct <= 20) return { label: "Te Sirve", tone: "good" };
  return { label: "Estás robando", tone: "great" };
}

function summarizeTradeForFantasyPros(version, viewerId, metaById, fpDynastyValues) {
  const viewerIsSender = String(version?.from_user_id || "") === String(viewerId || "");
  const yourGive = viewerIsSender ? version?.give : version?.get;
  const yourGet = viewerIsSender ? version?.get : version?.give;

  const detailForPlayer = (id) => {
    const meta = metaById?.get?.(String(id)) || null;
    const label = meta?.name || meta?.player_name || meta?.full_name || `Jugador ${id}`;
    return {
      id: String(id),
      label,
      ...fantasyProsPlayerValue(id, metaById, fpDynastyValues, label),
      type: "player",
    };
  };

  const detailForPick = (id) => ({
    id: String(id),
    label: PICK_LABEL.get(String(id).split("#")[0]) || String(id).split("#")[0],
    ...fantasyProsPickValue(id, fpDynastyValues),
    type: "pick",
  });

  const giveDetails = [
    ...((yourGive?.players || []).map(detailForPlayer)),
    ...((yourGive?.picks || []).map(detailForPick)),
  ];
  const getDetails = [
    ...((yourGet?.players || []).map(detailForPlayer)),
    ...((yourGet?.picks || []).map(detailForPick)),
  ];

  const giveTotal = giveDetails.reduce((sum, x) => sum + Number(x.value || 0), 0);
  const getTotal = getDetails.reduce((sum, x) => sum + Number(x.value || 0), 0);
  const delta = getTotal - giveTotal;
  const advantagePct = giveTotal > 0 ? (delta / giveTotal) * 100 : (getTotal > 0 ? 100 : 0);
  const clampedPct = clamp(advantagePct, -35, 35);
  const meterPct = ((clampedPct + 35) / 70) * 100;
  const verdict = fantasyProsMeterLabel(advantagePct);

  const allDetails = [...giveDetails, ...getDetails];
  const resolvedCount = allDetails.filter((x) => Number.isFinite(Number(x.value))).length;
  const fallbackCount = allDetails.filter((x) => x.source === "fallback").length;
  const fantasyProsCount = Math.max(0, resolvedCount - fallbackCount);

  const baseLabel = fpDynastyValues?.generatedFor || "DynastyProcess dynasty 1QB";
  const dataFallbackPlayers = Number(fpDynastyValues?.counts?.fallbackPlayers || 0);

  let sourceNote = "Respaldo local";
  if (fpDynastyValues?.hasLocalData) {
    sourceNote = dataFallbackPlayers > 0 || fallbackCount > 0
      ? `${baseLabel} + respaldo local`
      : baseLabel;
  }

  return {
    meterPct,
    angle: 270 - (meterPct / 100) * 180,
    delta,
    advantagePct,
    giveTotal,
    getTotal,
    verdict,
    resolvedCount,
    fantasyProsCount,
    fallbackCount,
    itemCount: allDetails.length,
    sourceNote,
    updatedAt: fpDynastyValues?.updatedAt || null,
    giveDetails,
    getDetails,
  };
}

function polarToCartesian(cx, cy, radius, angleInDegrees) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

function describeArc(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = Math.abs(endAngle - startAngle) <= 180 ? "0" : "1";
  const sweepFlag = endAngle > startAngle ? "1" : "0";
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;
}

function describeDonutSegment(cx, cy, outerRadius, innerRadius, startAngle, endAngle) {
  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
  const largeArcFlag = Math.abs(endAngle - startAngle) <= 180 ? "0" : "1";
  const sweepFlag = endAngle > startAngle ? "1" : "0";
  const reverseSweepFlag = sweepFlag === "1" ? "0" : "1";
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} ${sweepFlag} ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} ${reverseSweepFlag} ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function meterLabelPosition(cx, cy, startAngle, endAngle, radius) {
  const midAngle = startAngle + (endAngle - startAngle) / 2;
  return { ...polarToCartesian(cx, cy, radius, midAngle), midAngle };
}

function FantasyProsTradeMeter({ version, viewerId, metaById, fpDynastyValues }) {
  const summary = summarizeTradeForFantasyPros(version, viewerId, metaById, fpDynastyValues);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const cx = 180;
  const cy = 176;
  const outerRadius = 128;
  const innerRadius = 88;
  const pointerBaseRadius = 24;
  const pointerTipRadius = 120;
  const startAngle = -120;
  const endAngle = 120;
  const totalAngle = endAngle - startAngle;
  const pointerAngle = startAngle + (summary.meterPct / 100) * totalAngle;

  const segmentAngle = totalAngle / FP_METER_SEGMENTS.length;
  const pointerTip = polarToCartesian(cx, cy, pointerTipRadius, pointerAngle);
  const pointerLeft = polarToCartesian(cx, cy, pointerBaseRadius, pointerAngle - 7);
  const pointerRight = polarToCartesian(cx, cy, pointerBaseRadius, pointerAngle + 7);

  const sourceLabel = (source) => {
    if (source === "dp-local" || source === "dp-meta") return "DynastyProcess";
    if (source === "dp-default") return "DynastyProcess";
    if (source === "dp-derived") return "DynastyProcess derivado";
    return "Respaldo";
  };

  const renderBreakdownItem = (item) => (
    <div key={`${item.type}-${item.id}`} className="fpBreakItem">
      <div className="fpBreakMain">
        <div className="fpBreakNameRow">
          {item.type === "player" ? (
            <span className={`posMini posMini-${normPos(metaById?.get(String(item.id))?.position || metaById?.get(String(item.id))?.pos || "")}`}>
              {normPos(metaById?.get(String(item.id))?.position || metaById?.get(String(item.id))?.pos || "")}
            </span>
          ) : (
            <span className="fpBreakPick">P</span>
          )}
          <span className="fpBreakName">{item.label}</span>
        </div>
        <div className="fpBreakSource">{sourceLabel(item.source)}</div>
      </div>
      <div className="fpBreakValue">{Number(item.value || 0)}</div>
    </div>
  );

  return (
    <div className="fpTradeBox">
      <div className="fpMeterHead">
        <div style={{ minWidth: 0 }}>
          <div className="fpMeterTitle">DynastyProcess <span className="muted" style={{ fontWeight: 900 }}>(para vos)</span></div>
          <div className="fpMeterMeta">
            {summary.sourceNote}
            {summary.updatedAt ? ` · ${new Date(summary.updatedAt).toLocaleString()}` : ""}
          </div>
        </div>
        <span className={`fpVerdict fpVerdict-${summary.verdict.tone}`}>{summary.verdict.label}</span>
      </div>

      <div className="fpMeterWrap">
        <svg className="fpMeterSvg" viewBox="0 0 360 250" role="img" aria-label={`DynastyProcess: ${summary.verdict.label}`}>
          <defs>
            <filter id="fpShadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="10" stdDeviation="10" floodColor="rgba(15,23,42,0.18)" />
            </filter>
          </defs>

          {FP_METER_SEGMENTS.map((seg, idx) => {
            const segStart = startAngle + idx * segmentAngle;
            const segEnd = segStart + segmentAngle;
            const labelPos = meterLabelPosition(cx, cy, segStart, segEnd, innerRadius + ((outerRadius - innerRadius) * 0.58));
            return (
              <g key={seg.label}>
                <path
                  d={describeDonutSegment(cx, cy, outerRadius, innerRadius, segStart, segEnd)}
                  fill={seg.color}
                  opacity="0.98"
                />
                <text
                  x={labelPos.x}
                  y={labelPos.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fpSegmentInsideLabel"
                  fill={seg.textColor}
                  transform={`rotate(${labelPos.midAngle} ${labelPos.x} ${labelPos.y})`}
                >
                  {seg.lines.map((line, lineIdx) => (
                    <tspan key={`${seg.label}-${lineIdx}`} x={labelPos.x} dy={lineIdx === 0 ? (seg.lines.length > 1 ? -5 : 0) : 12}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}

          <path
            d={`M ${pointerLeft.x} ${pointerLeft.y} L ${pointerTip.x} ${pointerTip.y} L ${pointerRight.x} ${pointerRight.y} Z`}
            fill="#202631"
            filter="url(#fpShadow)"
          />
          <circle cx={cx} cy={cy} r="56" fill="#111827" filter="url(#fpShadow)" />

          <text x={cx} y={cy - 14} textAnchor="middle" className="fpBalanceLabel">
            Balance
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" className="fpBalanceValue">
            {summary.advantagePct > 0 ? "+" : ""}{Math.round(summary.advantagePct)}%
          </text>
        </svg>
      </div>

      <div className="fpTradeStats fpTradeStatsTwo">
        <div className="fpStat fpStatCentered">
          <span className="muted">Recibís</span>
          <b>{summary.getTotal}</b>
        </div>
        <div className="fpStat fpStatCentered">
          <span className="muted">Entregás</span>
          <b>{summary.giveTotal}</b>
        </div>
      </div>

      <div className="fpBreakToggleRow">
        <button type="button" className="ghost miniBtn fpBreakToggleBtn" onClick={() => setShowBreakdown((v) => !v)}>
          {showBreakdown ? "Ocultar valores por asset" : "Ver valores por asset"}
        </button>
      </div>

      {showBreakdown ? (
        <div className="fpBreakGrid">
          <div className="fpBreakCol">
            <div className="fpBreakColHead">
              <span>Vos entregás</span>
              <b>{summary.giveTotal}</b>
            </div>
            <div className="fpBreakList">
              {summary.giveDetails.length ? summary.giveDetails.map(renderBreakdownItem) : <div className="muted">—</div>}
            </div>
          </div>

          <div className="fpBreakCol">
            <div className="fpBreakColHead">
              <span>Vos recibís</span>
              <b>{summary.getTotal}</b>
            </div>
            <div className="fpBreakList">
              {summary.getDetails.length ? summary.getDetails.map(renderBreakdownItem) : <div className="muted">—</div>}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

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
function normTradeAssetList(arr) {
  return Array.isArray(arr) ? arr.map((x) => String(x)).filter(Boolean) : [];
}

function normalizeTradeVersion(v, fallback = {}) {
  return {
    version_no: Number(v?.version_no || fallback?.version_no || 1),
    kind: String(v?.kind || fallback?.kind || "PROPOSAL").toUpperCase(),
    is_counteroffer: Boolean(v?.is_counteroffer ?? fallback?.is_counteroffer ?? false),
    from_user_id: String(v?.from_user_id || fallback?.from_user_id || ""),
    to_user_id: String(v?.to_user_id || fallback?.to_user_id || ""),
    give: {
      players: normTradeAssetList(v?.give?.players || fallback?.give?.players),
      picks: normTradeAssetList(v?.give?.picks || fallback?.give?.picks),
    },
    get: {
      players: normTradeAssetList(v?.get?.players || fallback?.get?.players),
      picks: normTradeAssetList(v?.get?.picks || fallback?.get?.picks),
    },
    sent_at: v?.sent_at || fallback?.sent_at || nowIso(),
    status: String(v?.status || fallback?.status || "PENDING").toUpperCase(),
    response: v?.response ?? fallback?.response ?? null,
  };
}

function normalizeTradeStatus(rawStatus, rawResponse) {
  const st = String(rawStatus || "PENDING").toUpperCase();
  const resp = String(rawResponse || "").toUpperCase();

  if (st === "RESPONDED") {
    if (resp === "LIKE") return "ACCEPTED";
    if (resp === "NOPE") return "ROBBERY";
    if (resp === "MAYBE") return "RESPONDED";
  }
  return st;
}

function normalizeTradeRow(row) {
  const status = normalizeTradeStatus(row?.status, row?.response);
  const base = {
    id: row?.id ? String(row.id) : undefined,
    participants: Array.isArray(row?.participants) ? row.participants.map((x) => String(x)).filter(Boolean) : [],
    from_user_id: String(row?.from_user_id || ""),
    to_user_id: String(row?.to_user_id || ""),
    give: {
      players: normTradeAssetList(row?.give?.players),
      picks: normTradeAssetList(row?.give?.picks),
    },
    get: {
      players: normTradeAssetList(row?.get?.players),
      picks: normTradeAssetList(row?.get?.picks),
    },
    status,
    response: row?.response ?? null,
    created_at: row?.created_at || nowIso(),
    updated_at: row?.updated_at || row?.created_at || nowIso(),
    current_sent_at: row?.current_sent_at || row?.updated_at || row?.created_at || nowIso(),
    current_version: Math.max(1, Number(row?.current_version || 1)),
    is_counteroffer: Boolean(row?.is_counteroffer),
    history: Array.isArray(row?.history) ? row.history.map((v) => normalizeTradeVersion(v)) : [],
    hidden_for: Array.isArray(row?.hidden_for) ? row.hidden_for.map((x) => String(x)).filter(Boolean) : [],
    accepted_at: row?.accepted_at || null,
    robbery_at: row?.robbery_at || null,
    responded_at: row?.responded_at || null,
    cancelled_at: row?.cancelled_at || null,
  };

  if (!base.participants.length) {
    base.participants = [base.from_user_id, base.to_user_id].filter(Boolean).sort();
  }

  return base;
}

function tradeVersionFromTrade(trade) {
  const t = normalizeTradeRow(trade);
  return normalizeTradeVersion({
    version_no: t.current_version || 1,
    kind: t.is_counteroffer ? "COUNTEROFFER" : "PROPOSAL",
    is_counteroffer: t.is_counteroffer,
    from_user_id: t.from_user_id,
    to_user_id: t.to_user_id,
    give: t.give,
    get: t.get,
    sent_at: t.current_sent_at || t.updated_at || t.created_at || nowIso(),
    status: t.status,
    response: t.response,
  });
}

function tradeDocForSave(payload) {
  const norm = normalizeTradeRow(payload);
  const { id, ...rest } = norm;
  return rest;
}

async function fsGetTradesForUser(userId) {
  const q = query(collection(db, "trade_proposals"), where("participants", "array-contains", userId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => normalizeTradeRow({ id: d.id, ...d.data() }));
}

async function fsUpsertTrade(tradeId, data) {
  const id = tradeId || uid("trade");
  const ref = doc(db, "trade_proposals", id);
  const existingSnap = tradeId ? await getDoc(ref) : null;
  const existing = existingSnap?.exists() ? normalizeTradeRow({ id, ...existingSnap.data() }) : null;
  const now = nowIso();

  const payload = normalizeTradeRow({
    ...(existing || {}),
    ...data,
    created_at: existing?.created_at || data?.created_at || now,
    updated_at: now,
    current_sent_at: data?.current_sent_at || now,
  });

  await setDoc(ref, tradeDocForSave(payload), { merge: true });
  return id;
}

async function fsCancelTrade(tradeId) {
  await setDoc(
    doc(db, "trade_proposals", tradeId),
    {
      status: "CANCELLED",
      response: null,
      cancelled_at: nowIso(),
      updated_at: nowIso(),
      hidden_for: [],
    },
    { merge: true }
  );
}

async function fsRespondTrade(tradeId, response) {
  const resp = String(response || "").toUpperCase();
  const status = resp === "LIKE" ? "ACCEPTED" : resp === "ROBBERY" ? "ROBBERY" : "RESPONDED";
  const stamp = nowIso();
  const patch = {
    status,
    response: resp,
    responded_at: stamp,
    updated_at: stamp,
    hidden_for: [],
  };
  if (status === "ACCEPTED") patch.accepted_at = stamp;
  if (status === "ROBBERY") patch.robbery_at = stamp;

  await setDoc(doc(db, "trade_proposals", tradeId), patch, { merge: true });
}

async function fsHideTradeForUser(trade, userId) {
  const t = normalizeTradeRow(trade);
  const hidden = new Set(t.hidden_for || []);
  hidden.add(String(userId));

  const participants = Array.from(
    new Set(
      [t.from_user_id, t.to_user_id, ...(Array.isArray(t.participants) ? t.participants : [])]
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );

  const bothDeleted = participants.length >= 2 && participants.every((pid) => hidden.has(pid));
  if (bothDeleted) {
    await deleteDoc(doc(db, "trade_proposals", t.id));
    return { deleted: true };
  }

  await setDoc(
    doc(db, "trade_proposals", t.id),
    { hidden_for: Array.from(hidden), updated_at: nowIso() },
    { merge: true }
  );
  return { deleted: false };
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
/* --- Chats: fix for global button { color:#fff } --- */
.chatPickRow{ color:var(--text); }
.chatPickRow .muted{ color:var(--muted); }
.chatPickName{ color:var(--text); }
.chatAssetChip{ color:var(--text); }
.chatCheck{ color:#163B86; }
.chatSearch{ color:var(--text); }
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

      .mobileChatRail{ display:none; }
      .mobileChatRailHead{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
      .mobileChatScroller{ display:flex; gap:10px; overflow-x:auto; padding:2px 2px 8px; scroll-snap-type:x proximity; }
      .mobileChatScroller::-webkit-scrollbar{ height:6px; }
      .mobileChatScroller::-webkit-scrollbar-thumb{ background:#D8E4F6; border-radius:999px; }
      .mobileChatTeamBtn{
        min-width:220px;
        padding:12px;
        border-radius:18px;
        border:1px solid var(--border);
        background:#fff;
        box-shadow:none;
        color:var(--text);
        display:grid;
        gap:10px;
        text-align:left;
        scroll-snap-align:start;
      }
      .mobileChatTeamBtn.active{ background:#EEF6FF; border-color:#A7C7FF; }
      .mobileChatTeamTop{ display:flex; align-items:center; gap:10px; min-width:0; }
      .mobileChatTeamText{ min-width:0; display:grid; gap:2px; }
      .mobileChatTeamName{ font-weight:1100; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .mobileChatTeamMeta{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .mobileChatStatus{ max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .chatComposerCard{ overflow:hidden; }
      .tradeActionRow, .tradeRespondRow{ width:100%; }

      @media (max-width: 980px){
        .mobileChatRail{ display:block; margin-top:14px; }
        .chatList{ display:none; }
        .chatsWrap{ grid-template-columns:1fr; margin-top:12px !important; }
        .tradeSides{ grid-template-columns:1fr; }
        .chatMain{ gap:12px; }
        .tradeTop{ display:grid; gap:10px; }
        .chatTabs{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }
        .chatTabs .sp{ display:none; }
        .chatSearch{ grid-column:1 / -1; max-width:100%; width:100%; min-width:0; }
        .chatPickList{ max-height:240px; }
        .chatAssetChip, .chatMiniChip{ max-width:100%; }
        .chatAssetName, .chatMiniText{ flex:1; min-width:0; max-width:none; }
        .tradeActionRow{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }
        .tradeActionRow button{ width:100%; }
        .tradeRespondRow{ display:grid; grid-template-columns:1fr; gap:8px; }
        .tradeRespondRow button{ width:100%; }
      }


      /* FantasyPros trade meter */
      .fpTradeBox{
        margin-top:12px;
        border:1px solid var(--border);
        background:linear-gradient(180deg,#fff,#FBFDFF);
        border-radius:16px;
        padding:12px;
        display:grid;
        gap:10px;
      }
      .fpMeterHead{ display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
      .fpMeterTitle{ font-weight:1100; }
      .fpMeterMeta{ color:var(--muted); font-size:12px; font-weight:900; margin-top:2px; }
      .fpVerdict{
        display:inline-flex; align-items:center; justify-content:center;
        padding:7px 11px; border-radius:999px; font-weight:1100; border:1px solid transparent;
        white-space:nowrap;
      }
      .fpVerdict-robbery{ background:rgba(220,38,38,0.12); border-color:rgba(220,38,38,0.24); color:#991B1B; }
      .fpVerdict-weak{ background:rgba(245,158,11,0.14); border-color:rgba(245,158,11,0.26); color:#9A3412; }
      .fpVerdict-even{ background:rgba(163,230,53,0.18); border-color:rgba(163,230,53,0.28); color:#3F6212; }
      .fpVerdict-good{ background:rgba(34,197,94,0.14); border-color:rgba(34,197,94,0.24); color:#166534; }
      .fpVerdict-great{ background:rgba(22,101,52,0.14); border-color:rgba(22,101,52,0.26); color:#14532D; }
      .fpMeterWrap{ width:100%; display:flex; justify-content:center; }
      .fpMeterSvg{ width:min(100%, 560px); height:auto; display:block; overflow:visible; }
      .fpSegmentInsideLabel{
        font-size:10px;
        font-weight:1100;
        letter-spacing:-0.01em;
        paint-order:stroke fill;
        stroke:rgba(15,23,42,0.10);
        stroke-width:0.8px;
        stroke-linejoin:round;
      }
      .fpBalanceLabel{
        font-size:14px;
        font-weight:900;
        fill:#FFFFFF;
      }
      .fpBalanceValue{
        font-size:30px;
        font-weight:1100;
        fill:#FFFFFF;
      }
      .fpTradeStats{
        display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:8px;
      }
      .fpTradeStatsTwo{
        grid-template-columns:repeat(2, minmax(0, 1fr));
      }
      .fpStat{
        border:1px solid var(--border);
        border-radius:12px;
        background:#fff;
        padding:10px 12px;
        display:grid;
        gap:3px;
      }
      .fpStatCentered{
        justify-items:center;
        text-align:center;
      }
      .fpStat b{ font-size:18px; line-height:1; }
      .fpBreakToggleRow{ display:flex; justify-content:flex-start; }
      .fpBreakToggleBtn{ border-radius:12px; }
      .fpBreakGrid{
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:10px;
      }
      .fpBreakCol{
        border:1px solid var(--border);
        border-radius:14px;
        background:#fff;
        padding:10px;
        display:grid;
        gap:10px;
      }
      .fpBreakColHead{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        font-weight:1100;
      }
      .fpBreakList{ display:grid; gap:8px; }
      .fpBreakItem{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding:9px 10px;
        border-radius:12px;
        border:1px solid var(--border);
        background:#F8FAFC;
      }
      .fpBreakMain{ min-width:0; display:grid; gap:4px; }
      .fpBreakNameRow{ display:flex; align-items:center; gap:8px; min-width:0; }
      .fpBreakName{
        font-weight:1000;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
      }
      .fpBreakSource{
        color:var(--muted);
        font-size:11px;
        font-weight:900;
      }
      .fpBreakValue{
        font-weight:1100;
        font-size:18px;
        line-height:1;
        color:#0F172A;
        flex:0 0 auto;
      }
      .fpBreakPick{
        width:24px;
        height:24px;
        border-radius:999px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        background:rgba(2,132,199,0.10);
        border:1px solid rgba(2,132,199,0.16);
        color:#0F3A55;
        font-weight:1100;
        flex:0 0 auto;
      }
      @media(max-width:640px){
        .fpTradeBox{ padding:10px; border-radius:14px; }
        .fpMeterHead{ display:grid; gap:8px; }
        .fpVerdict{ justify-self:start; }
        .fpSegmentTopLabels{
          width:min(100%, 420px);
          gap:6px;
          margin-bottom:0;
        }
        .fpSegmentTopLabel{
          min-height:34px;
          font-size:10px;
          line-height:1.08;
          padding:0 2px;
        }
        .fpMeterSvg{ width:min(100%, 420px); }
        .fpBalanceLabel{ font-size:12px; }
        .fpBalanceValue{ font-size:24px; }
        .fpTradeStats{ grid-template-columns:1fr; }
        .fpBreakGrid{ grid-template-columns:1fr; }
      }

      @media (max-width: 640px){
        .card.chatComposerCard, .chatMain > .card{ padding:12px !important; border-radius:16px; }
        .mobileChatRailHead{ margin-bottom:8px; }
        .mobileChatTeamBtn{ min-width:185px; padding:10px; border-radius:16px; }
        .chatTeamAvatar, .mobileChatTeamBtn .chatTeamAvatar{ width:36px; height:36px; border-radius:12px; }
        .chatSideTop{ margin-bottom:8px; }
        .chatSideCount{ min-width:26px; height:26px; padding:0 8px; }
        .chatTab{ height:36px; padding:0 12px; }
        .chatSelected{ padding:8px; }
        .chatChipsWrap{ gap:6px; }
        .chatAssetChip, .chatMiniChip{ width:100%; justify-content:flex-start; }
        .chatPickList{ max-height:210px; padding:6px; }
        .chatPickRow{ padding:9px; gap:10px; }
        .chatAv, .chatPickIcon{ width:36px; height:36px; }
        .tradeCard{ padding:12px; border-radius:16px; }
        .tradeSide, .chatTradeSide{ padding:9px; border-radius:12px; }
        .tradeActionRow{ grid-template-columns:1fr; }
        .tradeActionRow .miniBtn{ min-height:40px; }
        .row.tradeRespondRow{ display:grid; grid-template-columns:1fr; gap:8px; }
        .row.tradeRespondRow button{ width:100%; margin:0; }
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
    const qq = normalizeLookupName(q);
    const qTokens = qq ? qq.split(" ").filter(Boolean) : [];

    const playerName = (p) => String(p?.name || p?.player_name || p?.full_name || p?.player || "").trim();
    const normalizedPlayerName = (p) => normalizeLookupName(playerName(p));
    const playerWords = (p) => normalizedPlayerName(p).split(" ").filter(Boolean);

    const playerAdp = (p) => {
      const raw = p?.adp ?? p?.adp_value ?? p?.adp_ppr ?? p?.ppr_adp ?? p?.adp_rank ?? p?.adp_formatted;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const playerSearchRank = (p) => {
      const n = Number(p?.search_rank);
      return Number.isFinite(n) && n > 0 ? n : Infinity;
    };

    const playerQueryScore = (p) => {
      if (!qq) return null;

      const name = normalizedPlayerName(p);
      if (!name) return null;

      const words = playerWords(p);
      const exactFull = name === qq;
      const exactWordIndex = words.findIndex((part) => part === qq);
      const startsFull = name.startsWith(qq);
      const startsWordIndex = words.findIndex((part) => part.startsWith(qq));
      const includesAt = name.indexOf(qq);
      const allWordStarts = qTokens.length > 1 && qTokens.every((token) => words.some((part) => part.startsWith(token)));
      const allWholeWords = qTokens.length > 1 && qTokens.every((token) => words.includes(token));
      const allIncludes = qTokens.length > 1 && qTokens.every((token) => name.includes(token));

      if (exactFull) return { bucket: 0, wordIndex: 0, startsAt: 0, len: name.length };
      if (exactWordIndex >= 0) return { bucket: 1, wordIndex: exactWordIndex, startsAt: includesAt >= 0 ? includesAt : 999, len: name.length };
      if (startsFull) return { bucket: 2, wordIndex: 0, startsAt: 0, len: name.length };
      if (startsWordIndex >= 0) return { bucket: 3, wordIndex: startsWordIndex, startsAt: includesAt >= 0 ? includesAt : 999, len: name.length };
      if (allWholeWords) return { bucket: 4, wordIndex: 999, startsAt: includesAt >= 0 ? includesAt : 999, len: name.length };
      if (allWordStarts) return { bucket: 5, wordIndex: 999, startsAt: includesAt >= 0 ? includesAt : 999, len: name.length };
      if (includesAt >= 0) return { bucket: 6, wordIndex: 999, startsAt: includesAt, len: name.length };
      if (allIncludes) return { bucket: 7, wordIndex: 999, startsAt: includesAt >= 0 ? includesAt : 999, len: name.length };

      return null;
    };

    const base = (players || []).filter((p) => {
      const posRaw = String(p?.position ?? p?.pos ?? p?.player_position ?? "").toUpperCase();
      if (!ALLOWED_POSITIONS.has(posRaw)) return false;

      const pos = normPos(posRaw);
      if (posFilter !== "ALL") {
        if (posFilter === "FLEX") {
          if (!["RB", "WR", "TE"].includes(pos)) return false;
        } else if (pos !== posFilter) {
          return false;
        }
      }

      if (!qq) return true;
      return playerQueryScore(p) !== null;
    });

    if (qq) {
      return base
        .map((p) => ({ p, score: playerQueryScore(p) || { bucket: 999, wordIndex: 999, startsAt: 999, len: 999 } }))
        .sort((a, b) => {
          if (a.score.bucket !== b.score.bucket) return a.score.bucket - b.score.bucket;
          if (a.score.wordIndex !== b.score.wordIndex) return a.score.wordIndex - b.score.wordIndex;
          if (a.score.startsAt !== b.score.startsAt) return a.score.startsAt - b.score.startsAt;
          if (a.score.len !== b.score.len) return a.score.len - b.score.len;

          const nameCmp = playerName(a.p).localeCompare(playerName(b.p), undefined, { sensitivity: "base" });
          if (nameCmp !== 0) return nameCmp;

          const srA = playerSearchRank(a.p);
          const srB = playerSearchRank(b.p);
          if (srA !== srB) return srA - srB;

          const adpA = playerAdp(a.p);
          const adpB = playerAdp(b.p);
          const hasAdpA = adpA != null;
          const hasAdpB = adpB != null;
          if (hasAdpA !== hasAdpB) return hasAdpA ? -1 : 1;
          if (hasAdpA && hasAdpB && adpA !== adpB) return adpA - adpB;

          return 0;
        })
        .map(({ p }) => p)
        .slice(0, 1200);
    }

    return base
      .sort((a, b) => {
        const adpA = playerAdp(a);
        const adpB = playerAdp(b);
        const hasAdpA = adpA != null;
        const hasAdpB = adpB != null;

        if (hasAdpA !== hasAdpB) return hasAdpA ? -1 : 1;
        if (hasAdpA && hasAdpB && adpA !== adpB) return adpA - adpB;

        const srA = playerSearchRank(a);
        const srB = playerSearchRank(b);
        if (srA !== srB) return srA - srB;

        return playerName(a).localeCompare(playerName(b), undefined, { sensitivity: "base" });
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
                        <div className="av">{<SafeImg src={img} alt={pname} fallback={initials(pname)} />} </div>
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
                                <div className="av">{<SafeImg src={img} alt={r.name} fallback={initials(r.name)} />} </div>
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
                      <div className="av">{<SafeImg src={img} alt={r.name} fallback={initials(r.name)} />} </div>
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
                              {<SafeImg src={mm?.img} alt={m} fallback={m.split(" ").slice(0, 2).map((x) => x[0]).join("")} />} 
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
function ChatsView({ me, teams, teamsByUser, metaById, fpDynastyValues }) {
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(false);

  const [myGivePlayers, setMyGivePlayers] = useState([]);
  const [myGivePicks, setMyGivePicks] = useState([]);
  const [myGetPlayers, setMyGetPlayers] = useState([]);
  const [myGetPicks, setMyGetPicks] = useState([]);

  const [giveTab, setGiveTab] = useState("players");
  const [getTab, setGetTab] = useState("players");
  const [giveQ, setGiveQ] = useState("");
  const [getQ, setGetQ] = useState("");

  const [editingId, setEditingId] = useState(null);
  const [draftMode, setDraftMode] = useState("new");
  const [savingTrade, setSavingTrade] = useState(false);
  const [info, setInfo] = useState("");
  const [historyOpen, setHistoryOpen] = useState({});

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
      const sorted = (rows || [])
        .filter((t) => !(t.hidden_for || []).includes(String(me.id)))
        .slice()
        .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
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

  const pickLabel = (pid) => {
    const id = String(pid || "");
    const base = id.split("#")[0];
    return (
      (myPicks || []).concat(otherPicks || []).find((p) => String(p?.id) === id)?.label ||
      PICK_LABEL.get(base) ||
      base
    );
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
    setDraftMode("new");
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
      return parts.includes(String(me.id)) && parts.includes(String(selectedUserId));
    });
  }, [trades, me?.id, selectedUserId]);

  const pendingForTeam = (uid) => {
    if (!me?.id || !uid) return 0;
    const meId = String(me.id);
    const otherId = String(uid);
    return (trades || []).filter((t) => {
      const parts = Array.isArray(t?.participants) ? t.participants : [];
      const st = normalizeTradeStatus(t?.status, t?.response);
      return (
        parts.includes(meId) &&
        parts.includes(otherId) &&
        st === "PENDING" &&
        String(t?.to_user_id) === meId &&
        !(t.hidden_for || []).includes(meId)
      );
    }).length;
  };

  const draftValid = useMemo(() => {
    const hasGive = myGivePlayers.length + myGivePicks.length > 0;
    const hasGet = myGetPlayers.length + myGetPicks.length > 0;
    return hasGive || hasGet;
  }, [myGivePlayers, myGivePicks, myGetPlayers, myGetPicks]);

  const activeTrade = useMemo(
    () => (editingId ? trades.find((t) => String(t.id) === String(editingId)) || null : null),
    [editingId, trades]
  );

  async function submitTrade() {
    if (!me?.id || !selectedUserId) return;
    if (!draftValid) {
      setInfo("Elegí al menos 1 asset para armar una propuesta.");
      return;
    }

    setSavingTrade(true);
    setInfo("");

    try {
      const meId = String(me.id);
      const otherId = String(selectedUserId);
      const participants = [meId, otherId].sort();
      const now = nowIso();

      if (draftMode === "edit" || draftMode === "counter") {
        const existing = activeTrade;
        if (!existing) throw new Error("No encontré la propuesta que querés modificar.");

        const existingStatus = normalizeTradeStatus(existing.status, existing.response);
        if (existingStatus !== "PENDING") throw new Error("Solo podés modificar propuestas pendientes.");

        if (draftMode === "edit" && String(existing.from_user_id) !== meId) {
          throw new Error("Solo quien envía la propuesta puede editarla.");
        }
        if (draftMode === "counter" && String(existing.to_user_id) !== meId) {
          throw new Error("Solo quien recibe la propuesta puede mandar una contraoferta.");
        }

        const prevVersion = tradeVersionFromTrade(existing);

        await fsUpsertTrade(existing.id, {
          participants,
          from_user_id: meId,
          to_user_id: otherId,
          give: { players: myGivePlayers, picks: myGivePicks },
          get: { players: myGetPlayers, picks: myGetPicks },
          status: "PENDING",
          response: null,
          current_sent_at: now,
          current_version: Number(existing.current_version || 1) + 1,
          is_counteroffer: draftMode === "counter" ? true : Boolean(existing.is_counteroffer),
          history: [...(existing.history || []), prevVersion],
          hidden_for: [],
          accepted_at: null,
          robbery_at: null,
          responded_at: null,
          cancelled_at: null,
        });

        await refreshTrades();
        clearDraft();
        setInfo(draftMode === "counter" ? "Contraoferta enviada." : "Cambios guardados.");
        return;
      }

      await fsUpsertTrade(null, {
        participants,
        from_user_id: meId,
        to_user_id: otherId,
        give: { players: myGivePlayers, picks: myGivePicks },
        get: { players: myGetPlayers, picks: myGetPicks },
        status: "PENDING",
        response: null,
        history: [],
        current_version: 1,
        current_sent_at: now,
        is_counteroffer: false,
        hidden_for: [],
      });

      await refreshTrades();
      clearDraft();
      setInfo("Propuesta enviada.");
    } catch (e) {
      console.error(e);
      setInfo(String(e?.message || "Error al enviar la propuesta."));
    } finally {
      setSavingTrade(false);
    }
  }

  function loadForEdit(trade) {
    if (!trade) return;
    const st = normalizeTradeStatus(trade.status, trade.response);
    if (st !== "PENDING") return;
    if (String(trade.from_user_id) !== String(me.id)) return;

    setSelectedUserId(trade.to_user_id);
    setEditingId(trade.id);
    setDraftMode("edit");
    setMyGivePlayers((trade?.give?.players || []).map(String));
    setMyGivePicks((trade?.give?.picks || []).map(String));
    setMyGetPlayers((trade?.get?.players || []).map(String));
    setMyGetPicks((trade?.get?.picks || []).map(String));
    setInfo("Editando propuesta…");
    setGiveTab("players");
    setGetTab("players");
  }

  function loadForCounter(trade) {
    if (!trade) return;
    const st = normalizeTradeStatus(trade.status, trade.response);
    if (st !== "PENDING") return;
    if (String(trade.to_user_id) !== String(me.id)) return;

    const otherId = String(trade.from_user_id);
    setSelectedUserId(otherId);
    setEditingId(trade.id);
    setDraftMode("counter");
    setMyGivePlayers((trade?.get?.players || []).map(String));
    setMyGivePicks((trade?.get?.picks || []).map(String));
    setMyGetPlayers((trade?.give?.players || []).map(String));
    setMyGetPicks((trade?.give?.picks || []).map(String));
    setInfo("Armando contraoferta…");
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

  function canHideTrade(trade) {
    if (!trade?.id || !me?.id) return false;
    const meId = String(me.id);
    const st = normalizeTradeStatus(trade?.status, trade?.response);
    const isSender = String(trade?.from_user_id) === meId;
    const isReceiver = String(trade?.to_user_id) === meId;

    return (
      st === "CANCELLED" ||
      st === "ACCEPTED" ||
      st === "ROBBERY" ||
      st === "RESPONDED" ||
      (isSender && !!trade?.cancelled_at) ||
      (isReceiver && !!trade?.responded_at)
    );
  }

  async function hideTrade(trade) {
    if (!trade?.id || !me?.id) return;
    try {
      if (!canHideTrade(trade)) return;

      await fsHideTradeForUser(trade, me.id);
      if (editingId === trade.id) clearDraft();
      await refreshTrades();
    } catch (e) {
      console.error(e);
      alert("No se pudo borrar este trade para vos.");
    }
  }

  const statusBadge = (t) => {
    const st = normalizeTradeStatus(t?.status, t?.response);
    const resp = String(t?.response || "").toUpperCase();

    if (st === "CANCELLED") return <span className="chip danger">Cancelado</span>;
    if (st === "ACCEPTED" || resp === "LIKE") return <span className="chip ok">Me gusta</span>;
    if (st === "ROBBERY" || resp === "ROBBERY" || resp === "NOPE") return <span className="chip danger">Me estás robando</span>;
    if (st === "RESPONDED" && resp === "MAYBE") return <span className="chip warn">Puede ser</span>;
    return <span className="chip">Pendiente</span>;
  };

  const versionKindLabel = (entry) => {
    const kind = String(entry?.kind || "").toUpperCase();
    if (kind === "COUNTEROFFER" || entry?.is_counteroffer) return "Contraoferta";
    if (kind === "EDIT") return "Edición";
    return "Propuesta";
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
          {<SafeImg src={m.img} alt="" fallback={<span className="chatAvFallback">{initials(m.name)}</span>} />} 
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
            {<SafeImg src={m.img} alt="" fallback={<span className="chatAvFallback">{initials(m.name)}</span>} />} 
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

  const toggleHistory = (tradeId) => {
    setHistoryOpen((prev) => ({ ...prev, [tradeId]: !prev[tradeId] }));
  };

  const renderVersionSide = (version, isSenderView) => {
    const givePlayers = (version?.give?.players || []).map(String);
    const givePicks = (version?.give?.picks || []).map(String);
    const getPlayers = (version?.get?.players || []).map(String);
    const getPicks = (version?.get?.picks || []).map(String);

    return (
      <div className="tradeSides" style={{ marginTop: 10 }}>
        <div className="chatTradeSide">
          <div className="muted" style={{ fontWeight: 1000, marginBottom: 8 }}>{isSenderView ? "Vos das" : "Te dan"}</div>
          <div className="chatChipsWrap">
            {givePlayers.map((id) => (
              <span key={`gp-${version.version_no}-${id}`} className="chatMiniChip">
                <span className="chatAvSm">
                  {<SafeImg src={playerMeta(id).img} alt="" fallback={<span className="chatAvFallback">{initials(playerMeta(id).name)}</span>} />} 
                </span>
                <span className="chatMiniText">{playerMeta(id).name}</span>
                {playerMeta(id).pos ? <span className={`posMini posMini-${playerMeta(id).pos}`}>{playerMeta(id).pos}</span> : null}
              </span>
            ))}
            {givePicks.map((id) => (
              <span key={`gk-${version.version_no}-${id}`} className="chatMiniChip">
                <span className="chatPickIcon">P</span>
                <span className="chatMiniText">{pickLabel(id)}</span>
              </span>
            ))}
            {(!givePlayers.length && !givePicks.length) ? <span className="muted">—</span> : null}
          </div>
        </div>

        <div className="chatTradeSide">
          <div className="muted" style={{ fontWeight: 1000, marginBottom: 8 }}>{isSenderView ? "Vos recibís" : "Te piden"}</div>
          <div className="chatChipsWrap">
            {getPlayers.map((id) => (
              <span key={`rp-${version.version_no}-${id}`} className="chatMiniChip">
                <span className="chatAvSm">
                  {<SafeImg src={playerMeta(id).img} alt="" fallback={<span className="chatAvFallback">{initials(playerMeta(id).name)}</span>} />} 
                </span>
                <span className="chatMiniText">{playerMeta(id).name}</span>
                {playerMeta(id).pos ? <span className={`posMini posMini-${playerMeta(id).pos}`}>{playerMeta(id).pos}</span> : null}
              </span>
            ))}
            {getPicks.map((id) => (
              <span key={`rk-${version.version_no}-${id}`} className="chatMiniChip">
                <span className="chatPickIcon">P</span>
                <span className="chatMiniText">{pickLabel(id)}</span>
              </span>
            ))}
            {(!getPlayers.length && !getPicks.length) ? <span className="muted">—</span> : null}
          </div>
        </div>
      </div>
    );
  };

  const composerBadge =
    draftMode === "counter" ? <span className="chip warn">Contraoferta</span> :
    draftMode === "edit" ? <span className="chip warn">Editando</span> :
    <span className="chip">Nueva</span>;

  const composerButtonText =
    savingTrade ? "Guardando..." :
    draftMode === "counter" ? "Enviar contraoferta" :
    draftMode === "edit" ? "Guardar cambios" :
    "Enviar propuesta";

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="row" style={{ alignItems: "center" }}>
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontWeight: 1100, fontSize: 20 }}>Chats</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Propuestas 1 a 1 en formato <b>trade card</b>. El receptor puede responder con: <b>Me gusta</b>, <b>Me estás robando</b> o <b>Contraoferta</b>.
          </div>
        </div>
        <div className="sp" />
        <button className="ghost" onClick={refreshTrades} disabled={loading}>
          {loading ? "Actualizando..." : "Actualizar"}
        </button>
      </div>

      <div className="mobileChatRail">
        <div className="mobileChatRailHead">
          <div className="muted" style={{ fontWeight: 1000 }}>Conversaciones</div>
          <span className="muted" style={{ fontSize: 12 }}>{otherTeams.length}</span>
        </div>

        <div className="mobileChatScroller">
          {otherTeams.map((t) => {
            const pending = pendingForTeam(t.user_id);
            return (
              <button
                key={`mobile-${t.user_id}`}
                type="button"
                className={`mobileChatTeamBtn ${selectedUserId === t.user_id ? "active" : ""}`}
                onClick={() => { setSelectedUserId(t.user_id); clearDraft(); }}
              >
                <div className="mobileChatTeamTop">
                  <div className="chatTeamAvatar">{initials(teamLabel(t))}</div>
                  <div className="mobileChatTeamText">
                    <div className="mobileChatTeamName">{teamLabel(t)}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{t.display_name || t.user_id}</div>
                  </div>
                </div>

                <div className="mobileChatTeamMeta">
                  <div className="chip mobileChatStatus" style={{ cursor: "default" }}>{normTeamStatus(t.team_status)}</div>
                  {pending ? <div className="chatDot" title="Pendientes">{pending}</div> : <span className="muted" style={{ fontSize: 12 }}>Abrir</span>}
                </div>
              </button>
            );
          })}
        </div>
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
          <div className="card chatComposer chatComposerCard" style={{ padding: 14, borderRadius: 18 }}>
            <div className="row" style={{ alignItems: "center" }}>
              <div style={{ display: "grid", gap: 2 }}>
                <div style={{ fontWeight: 1100 }}>Nueva propuesta</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Para: <b>{teamLabel(otherRow)}</b>
                </div>
              </div>
              <div className="sp" />
              {composerBadge}
            </div>

            <div className="tradeSides" style={{ marginTop: 12 }}>
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
              <button className="ghost" onClick={clearDraft}>
                {editingId ? "Cancelar edición" : "Limpiar"}
              </button>
              <button disabled={savingTrade} onClick={submitTrade}>
                {composerButtonText}
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
                const st = normalizeTradeStatus(t.status, t.response);
                const currentVersion = tradeVersionFromTrade(t);
                const showHistory = Boolean(historyOpen[t.id]);
                const showCounterBadge = Boolean(t.is_counteroffer);

                const senderRow = teamsByUser.get(String(t.from_user_id));
                const receiverRow = teamsByUser.get(String(t.to_user_id));
                const headerText = isSender
                  ? (showCounterBadge ? "Vos contraofertaste" : "Vos propusiste")
                  : (showCounterBadge ? "Te mandaron una contraoferta" : "Te propusieron");

                return (
                  <div key={t.id} className="tradeCard tradeCardNice">
                    <div className="tradeTop">
                      <div style={{ display: "grid", gap: 6 }}>
                        <div style={{ fontWeight: 1100 }}>
                          {headerText} · <span className="muted">{new Date(t.current_sent_at || t.updated_at || t.created_at || Date.now()).toLocaleString()}</span>
                        </div>
                        <div className="row" style={{ gap: 8 }}>
                          <span className="chip" style={{ cursor: "default" }}>Versión {t.current_version || 1}</span>
                          {showCounterBadge ? <span className="chip warn">Contraoferta</span> : null}
                          {statusBadge(t)}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          De: <b>{teamLabel(senderRow)}</b> · Para: <b>{teamLabel(receiverRow)}</b>
                        </div>
                      </div>

                      <div className="row tradeActionRow" style={{ gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
                        {t.history?.length ? (
                          <button className="ghost miniBtn" onClick={() => toggleHistory(t.id)}>
                            {showHistory ? "Ocultar historial" : `Ver historial (${t.history.length})`}
                          </button>
                        ) : null}
                        {canHideTrade(t) ? (
                          <button className="danger miniBtn" onClick={() => hideTrade(t)}>Borrar</button>
                        ) : null}
                        {isSender && st === "PENDING" ? (
                          <>
                            <button className="ghost miniBtn" onClick={() => loadForEdit(t)}>Editar</button>
                            <button className="danger miniBtn" onClick={() => cancelTrade(t.id)}>Cancelar</button>
                          </>
                        ) : null}
                      </div>
                    </div>

                    {renderVersionSide(currentVersion, isSender)}

                    <FantasyProsTradeMeter
                      version={currentVersion}
                      viewerId={me?.id}
                      metaById={metaById}
                      fpDynastyValues={fpDynastyValues}
                    />

                    {showHistory ? (
                      <div
                        style={{
                          marginTop: 10,
                          borderTop: "1px solid var(--border)",
                          paddingTop: 10,
                          display: "grid",
                          gap: 10,
                        }}
                      >
                        {(t.history || []).slice().sort((a, b) => Number(b.version_no || 0) - Number(a.version_no || 0)).map((entry) => {
                          const entrySenderView = String(entry.from_user_id) === String(me.id);
                          const entrySenderRow = teamsByUser.get(String(entry.from_user_id));
                          const entryReceiverRow = teamsByUser.get(String(entry.to_user_id));

                          return (
                            <div
                              key={`${t.id}-history-${entry.version_no}-${entry.sent_at}`}
                              style={{
                                border: "1px solid var(--border)",
                                borderRadius: 14,
                                padding: 10,
                                background: "#F8FAFC",
                              }}
                            >
                              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                                <span className="chip" style={{ cursor: "default" }}>Versión {entry.version_no}</span>
                                <span className={`chip ${entry.is_counteroffer ? "warn" : ""}`} style={{ cursor: "default" }}>
                                  {versionKindLabel(entry)}
                                </span>
                                <span className="muted" style={{ fontSize: 12 }}>
                                  {new Date(entry.sent_at || Date.now()).toLocaleString()}
                                </span>
                              </div>
                              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                De: <b>{teamLabel(entrySenderRow)}</b> · Para: <b>{teamLabel(entryReceiverRow)}</b>
                              </div>
                              {renderVersionSide(entry, entrySenderView)}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {isReceiver && st === "PENDING" ? (
                      <div className="row tradeRespondRow" style={{ justifyContent: "flex-end", gap: 10 }}>
                        <button className="ok" onClick={() => respondTrade(t.id, "LIKE")}>Me gusta</button>
                        <button className="warn" onClick={() => loadForCounter(t)}>Contraoferta</button>
                        <button className="danger" onClick={() => respondTrade(t.id, "ROBBERY")}>Me estás robando</button>
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: 12 }}>
                        Estado:{" "}
                        <b>
                          {st === "PENDING"
                            ? "Pendiente"
                            : st === "ACCEPTED"
                              ? "Aceptado"
                              : st === "ROBBERY"
                                ? "Me estás robando"
                                : st === "CANCELLED"
                                  ? "Cancelado"
                                  : "Respondido"}
                        </b>
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
  const [fpDynastyValues, setFpDynastyValues] = useState(() => normalizeFantasyProsValuesPayload(null));

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = import.meta.env.BASE_URL || "/";
        const res = await fetch(`${base}fantasypros-dynasty-values.json?ts=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setFpDynastyValues(normalizeFantasyProsValuesPayload(json));
      } catch {
        if (!cancelled) setFpDynastyValues(normalizeFantasyProsValuesPayload(null));
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
              <ChatsView me={me} teams={teams} teamsByUser={teamsByUser} metaById={metaById} fpDynastyValues={fpDynastyValues} />
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
