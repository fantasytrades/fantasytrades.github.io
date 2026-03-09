import fs from "node:fs";
import path from "node:path";

const ADP_SCORING = process.env.ADP_SCORING || "ppr";
const ADP_TEAMS = Number(process.env.ADP_TEAMS || 10);
const ALLOWED_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const USER_AGENT = "fantasytrades-adp-updater";

function ffcUrl(year) {
  return `https://fantasyfootballcalculator.com/api/v1/adp/${encodeURIComponent(
    ADP_SCORING
  )}?teams=${encodeURIComponent(String(ADP_TEAMS))}&year=${encodeURIComponent(
    String(year)
  )}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.json();
}

const TEAM_MAP = { JAC: "JAX", WAS: "WSH" };

function normalizeTeam(team = "") {
  const raw = String(team || "").toUpperCase().trim();
  const mapped = TEAM_MAP[raw] || raw;
  return mapped || "FA";
}

function sleeperHeadshotUrl(sleeperId) {
  const id = String(sleeperId || "").trim();
  if (!id) return "";
  return `https://sleepercdn.com/content/nfl/players/${id}.jpg`;
}

const baseNormName = (s = "") =>
  String(s || "")
    .toLowerCase()
    .replace(/[’'.]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const looseNormName = (s = "") =>
  baseNormName(s)
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

function makeStrictKey(name, team, pos) {
  return `${baseNormName(name)}|${normalizeTeam(team)}|${String(pos || "").toUpperCase()}`;
}

function makeStrictNamePosKey(name, pos) {
  return `${baseNormName(name)}|${String(pos || "").toUpperCase()}`;
}

function makeLooseNamePosKey(name, pos) {
  return `${looseNormName(name)}|${String(pos || "").toUpperCase()}`;
}

function validPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function validRank(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 999999;
}

function preferSleeperRow(a, b) {
  if (!a) return b;
  if (!b) return a;

  const aTeam = normalizeTeam(a.team);
  const bTeam = normalizeTeam(b.team);
  const aHasTeam = aTeam !== "FA";
  const bHasTeam = bTeam !== "FA";
  if (aHasTeam !== bHasTeam) return aHasTeam ? a : b;

  if (a.active !== b.active) return a.active ? a : b;
  if (a.search_rank !== b.search_rank) return a.search_rank < b.search_rank ? a : b;

  const aExp = validPositiveNumber(a.years_exp) ?? 0;
  const bExp = validPositiveNumber(b.years_exp) ?? 0;
  if (aExp !== bExp) return aExp > bExp ? a : b;

  return String(a.id) < String(b.id) ? a : b;
}

function upsertPreferredArrayIndex(map, key, row) {
  if (!key) return;
  const arr = map.get(key) || [];
  arr.push(row);
  map.set(key, arr);
}

async function fetchSleeperPlayers() {
  const r = await fetch("https://api.sleeper.app/v1/players/nfl", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!r.ok) throw new Error(`Sleeper players fetch failed ${r.status}`);
  return await r.json();
}

function buildSleeperPlayerMap(all) {
  const byExactKey = new Map();
  const byStrictNamePos = new Map();
  const byLooseNamePos = new Map();
  const byId = new Map();
  const rows = [];

  for (const [id, p] of Object.entries(all || {})) {
    if (!p?.full_name || !p?.position) continue;
    const position = String(p.position).toUpperCase();
    if (!ALLOWED_POSITIONS.has(position)) continue;

    const team = normalizeTeam(p.team || "FA");
    const sleeperId = String(id);
    const row = {
      id: sleeperId,
      exactKey: makeStrictKey(p.full_name, team, position),
      strictNamePosKey: makeStrictNamePosKey(p.full_name, position),
      looseNamePosKey: makeLooseNamePosKey(p.full_name, position),
      full_name: p.full_name,
      position,
      team,
      search_rank: validRank(p.search_rank),
      active: Boolean(p.active),
      years_exp: validPositiveNumber(p.years_exp),
      age: validPositiveNumber(p.age),
      fantasy_positions: Array.isArray(p.fantasy_positions) ? p.fantasy_positions : [],
      status: p.status || "",
      headshot: sleeperHeadshotUrl(sleeperId),
    };

    rows.push(row);
    byId.set(sleeperId, row);
    byExactKey.set(row.exactKey, preferSleeperRow(byExactKey.get(row.exactKey), row));
    upsertPreferredArrayIndex(byStrictNamePos, row.strictNamePosKey, row);
    upsertPreferredArrayIndex(byLooseNamePos, row.looseNamePosKey, row);
  }

  return { byExactKey, byStrictNamePos, byLooseNamePos, byId, rows };
}

function readPlayerName(p) {
  return p?.name || p?.player || p?.full_name || p?.fullname || "";
}
function readPlayerTeam(p) {
  return p?.team || p?.nfl || p?.nflTeam || p?.pro_team || "";
}
function readPlayerPos(p) {
  return p?.pos || p?.position || "";
}

function canonicalFromFfc(p, sleeperMatch) {
  const name = readPlayerName(p);
  const pos = String(readPlayerPos(p) || "").toUpperCase();
  const team = normalizeTeam(readPlayerTeam(p) || sleeperMatch?.team || "FA");
  const rawFfcId = String(p?.player_id ?? p?.id ?? "").trim();
  const sleeperId = String(sleeperMatch?.id || "").trim();
  const adp = validPositiveNumber(p?.adp);
  const adpFormatted = p?.adp_formatted || "";

  const fallbackIdCore = rawFfcId || makeLooseNamePosKey(name, pos) || baseNormName(name) || "unknown";
  const playerId = sleeperId || `ffc:${fallbackIdCore}`;

  return {
    player_id: playerId,
    sleeper_id: sleeperId || undefined,
    legacy_player_id: rawFfcId || undefined,
    name,
    full_name: name,
    position: pos,
    team,
    adp,
    adp_formatted: adpFormatted,
    times_drafted: validPositiveNumber(p?.times_drafted) ?? 0,
    high: validPositiveNumber(p?.high),
    low: validPositiveNumber(p?.low),
    stdev: validPositiveNumber(p?.stdev),
    bye: validPositiveNumber(p?.bye) ?? 0,
    search_rank: sleeperMatch?.search_rank ?? 999999,
    headshot: sleeperMatch?.headshot || "",
    source: "ffc",
  };
}

function canonicalFromSleeper(row) {
  return {
    player_id: String(row.id),
    sleeper_id: String(row.id),
    legacy_player_id: undefined,
    name: row.full_name,
    full_name: row.full_name,
    position: row.position,
    team: row.team || "FA",
    adp: null,
    adp_formatted: "",
    times_drafted: 0,
    high: null,
    low: null,
    stdev: null,
    bye: 0,
    search_rank: row.search_rank,
    headshot: row.headshot,
    source: "sleeper",
  };
}

function sortPlayers(a, b) {
  const adpA = validPositiveNumber(a?.adp) ?? Infinity;
  const adpB = validPositiveNumber(b?.adp) ?? Infinity;
  if (adpA !== adpB) return adpA - adpB;

  const srA = validRank(a?.search_rank);
  const srB = validRank(b?.search_rank);
  if (srA !== srB) return srA - srB;

  return String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { sensitivity: "base" });
}

function chooseBestUnused(candidates, usedSleeperIds) {
  const unused = (candidates || []).filter((row) => row && !usedSleeperIds.has(String(row.id)));
  if (!unused.length) return null;
  return unused.reduce((best, row) => preferSleeperRow(best, row), null);
}

function findSleeperMatch(p, sleeperData, usedSleeperIds) {
  const name = readPlayerName(p);
  const pos = String(readPlayerPos(p) || "").toUpperCase();
  const team = readPlayerTeam(p) || "FA";

  const exactKey = makeStrictKey(name, team, pos);
  const exact = sleeperData.byExactKey.get(exactKey);
  if (exact && !usedSleeperIds.has(String(exact.id))) {
    return { row: exact, matchType: "exact" };
  }

  const strictCandidates = (sleeperData.byStrictNamePos.get(makeStrictNamePosKey(name, pos)) || [])
    .filter((row) => !usedSleeperIds.has(String(row.id)));
  if (strictCandidates.length === 1) {
    return { row: strictCandidates[0], matchType: "strict" };
  }

  const looseCandidates = (sleeperData.byLooseNamePos.get(makeLooseNamePosKey(name, pos)) || [])
    .filter((row) => !usedSleeperIds.has(String(row.id)));
  if (looseCandidates.length === 1) {
    return { row: looseCandidates[0], matchType: "loose" };
  }

  return { row: null, matchType: null, ambiguous: strictCandidates.length > 1 || looseCandidates.length > 1 };
}

function mergePlayers(ffcPlayers, sleeperData) {
  const out = new Map();
  const usedSleeperIds = new Set();
  let matchedExact = 0;
  let matchedStrict = 0;
  let matchedLoose = 0;
  let ambiguousSkipped = 0;

  for (const p of ffcPlayers || []) {
    const name = readPlayerName(p);
    const pos = String(readPlayerPos(p) || "").toUpperCase();
    if (!name || !ALLOWED_POSITIONS.has(pos)) continue;

    const { row: sleeperMatch, matchType, ambiguous } = findSleeperMatch(p, sleeperData, usedSleeperIds);
    if (sleeperMatch) {
      usedSleeperIds.add(String(sleeperMatch.id));
      if (matchType === "exact") matchedExact += 1;
      else if (matchType === "strict") matchedStrict += 1;
      else if (matchType === "loose") matchedLoose += 1;
    } else if (ambiguous) {
      ambiguousSkipped += 1;
    }

    const row = canonicalFromFfc(p, sleeperMatch);
    const storeKey = String(row.player_id);
    out.set(storeKey, row);
  }

  let addedSleeperOnly = 0;
  for (const row of sleeperData.rows) {
    if (usedSleeperIds.has(String(row.id))) continue;
    const sleeperOnly = canonicalFromSleeper(row);
    const storeKey = String(sleeperOnly.player_id);
    if (!out.has(storeKey)) {
      out.set(storeKey, sleeperOnly);
      addedSleeperOnly += 1;
    }
  }

  const players = Array.from(out.values()).sort(sortPlayers);
  return { players, matchedExact, matchedStrict, matchedLoose, ambiguousSkipped, addedSleeperOnly };
}

async function fetchFfcPlayers() {
  const yearNow = new Date().getFullYear();
  const yearsToTry = [yearNow, yearNow + 1, yearNow - 1];
  let lastErr = null;

  for (const y of yearsToTry) {
    try {
      const data = await fetchJson(ffcUrl(y));
      if (!data?.players || !Array.isArray(data.players) || data.players.length === 0) {
        throw new Error(`Invalid payload for year=${y}`);
      }
      return { year: y, players: data.players, error: null };
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ year=${y} failed: ${e?.message || e}`);
    }
  }

  return { year: null, players: [], error: lastErr };
}

async function main() {
  const sleeperAll = await fetchSleeperPlayers();
  const sleeperData = buildSleeperPlayerMap(sleeperAll);
  console.log(`🧩 Sleeper player pool: ${sleeperData.rows.length}`);

  const ffc = await fetchFfcPlayers();
  if (ffc.players.length) {
    console.log(`📈 FFC ADP pool: ${ffc.players.length} (year=${ffc.year})`);
  } else {
    console.warn(`⚠️ FFC unavailable. Building adp.json from Sleeper only. Last error: ${ffc.error?.message || ffc.error}`);
  }

  const merged = mergePlayers(ffc.players, sleeperData);

  const payload = {
    meta: {
      source: ffc.players.length ? "fantasyfootballcalculator.com + sleeper" : "sleeper",
      scoring: ADP_SCORING,
      teams: ADP_TEAMS,
      year: ffc.year,
      updatedAt: new Date().toISOString(),
      counts: {
        ffc_players: ffc.players.length,
        sleeper_players: sleeperData.rows.length,
        matched_ffc_to_sleeper_exact: merged.matchedExact,
        matched_ffc_to_sleeper_strict: merged.matchedStrict,
        matched_ffc_to_sleeper_loose: merged.matchedLoose,
        ambiguous_ffc_matches_skipped: merged.ambiguousSkipped,
        sleeper_only_added: merged.addedSleeperOnly,
        final_players: merged.players.length,
      },
    },
    players: merged.players,
  };

  const outDir = path.resolve("public");
  const outPath = path.join(outDir, "adp.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");

  console.log(
    `✅ Wrote ${outPath} (final=${merged.players.length}, ffc=${ffc.players.length}, sleeperOnly=${merged.addedSleeperOnly}, exact=${merged.matchedExact}, strict=${merged.matchedStrict}, loose=${merged.matchedLoose}, ambiguousSkipped=${merged.ambiguousSkipped})`
  );
}

main().catch((e) => {
  console.warn(`⚠️ ADP script error (skipping update): ${e?.message || e}`);
  process.exit(0);
});
