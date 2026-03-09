import fs from "node:fs";
import path from "node:path";

const ADP_SCORING = process.env.ADP_SCORING || "ppr"; // "ppr" | "standard" | "half-ppr"
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
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.json();
}

const TEAM_MAP = { JAC: "JAX", WAS: "WSH" };

function sleeperHeadshotUrl(sleeperId, team = "", active = true) {
  const id = String(sleeperId || "").trim();
  const tm = String(team || "").toUpperCase();
  if (!id) return "";
  if (!active) return "";
  if (!tm || tm === "FA") return "";
  return `https://sleepercdn.com/content/nfl/players/${id}.jpg`;
}

const normName = (s = "") =>
  s
    .toLowerCase()
    .replace(/[’'.]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normTeam = (t = "") => TEAM_MAP[(t || "").toUpperCase()] || (t || "").toUpperCase();

function makeKey(name, team, pos) {
  return `${normName(name)}|${normTeam(team)}|${String(pos || "").toUpperCase()}`;
}

async function fetchSleeperPlayers() {
  const r = await fetch("https://api.sleeper.app/v1/players/nfl", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!r.ok) throw new Error(`Sleeper players fetch failed ${r.status}`);
  return await r.json();
}

function validPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function validRank(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 999999;
}

function buildSleeperPlayerMap(all) {
  const byKey = new Map();
  const rows = [];

  for (const [id, p] of Object.entries(all || {})) {
    if (!p?.full_name || !p?.position) continue;
    if (!ALLOWED_POSITIONS.has(String(p.position).toUpperCase())) continue;

    const key = makeKey(p.full_name, p.team || "", p.position);
    const sleeperId = String(id);
    const row = {
      id: sleeperId,
      key,
      full_name: p.full_name,
      position: String(p.position).toUpperCase(),
      team: p.team || "FA",
      search_rank: validRank(p.search_rank),
      active: Boolean(p.active),
      years_exp: Number.isFinite(Number(p.years_exp)) ? Number(p.years_exp) : null,
      age: Number.isFinite(Number(p.age)) ? Number(p.age) : null,
      fantasy_positions: Array.isArray(p.fantasy_positions) ? p.fantasy_positions : [],
      status: p.status || "",
      headshot: sleeperHeadshotUrl(sleeperId, p.team || '', Boolean(p.active)),
    };

    if (!byKey.has(key)) byKey.set(key, row);
    rows.push(row);
  }

  return { byKey, rows };
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
  const team = readPlayerTeam(p) || sleeperMatch?.team || "FA";
  const sleeperId = String(p?.sleeper_id || sleeperMatch?.id || "");
  const adp = Number(p?.adp);
  const adpFormatted = p?.adp_formatted || "";

  return {
    player_id: String(p?.player_id ?? sleeperId ?? ""),
    sleeper_id: sleeperId || undefined,
    name,
    full_name: name,
    position: pos,
    team,
    adp: Number.isFinite(adp) ? adp : null,
    adp_formatted: adpFormatted,
    times_drafted: Number.isFinite(Number(p?.times_drafted)) ? Number(p.times_drafted) : 0,
    high: Number.isFinite(Number(p?.high)) ? Number(p.high) : null,
    low: Number.isFinite(Number(p?.low)) ? Number(p.low) : null,
    stdev: Number.isFinite(Number(p?.stdev)) ? Number(p.stdev) : null,
    bye: Number.isFinite(Number(p?.bye)) ? Number(p.bye) : 0,
    search_rank: validRank(sleeperMatch?.search_rank),
    headshot: p?.headshot || sleeperHeadshotUrl(sleeperId, team, Boolean(sleeperMatch?.active)),
    source: "ffc",
  };
}

function canonicalFromSleeper(row) {
  return {
    player_id: String(row.id),
    sleeper_id: String(row.id),
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

  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

function mergePlayers(ffcPlayers, sleeperData) {
  const out = new Map();
  let matched = 0;

  for (const p of ffcPlayers || []) {
    const name = readPlayerName(p);
    const pos = String(readPlayerPos(p) || "").toUpperCase();
    if (!name || !ALLOWED_POSITIONS.has(pos)) continue;

    const key = makeKey(name, readPlayerTeam(p), pos);
    const sleeperMatch = sleeperData.byKey.get(key);
    if (sleeperMatch) matched += 1;

    const row = canonicalFromFfc(p, sleeperMatch);
    const storeKey = key || `${row.player_id}|${row.name}|${row.position}`;
    out.set(storeKey, row);
  }

  let addedSleeperOnly = 0;
  for (const row of sleeperData.rows) {
    if (!out.has(row.key)) {
      out.set(row.key, canonicalFromSleeper(row));
      addedSleeperOnly += 1;
    }
  }

  const players = Array.from(out.values()).sort(sortPlayers);
  return { players, matchedFfcToSleeper: matched, addedSleeperOnly };
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
        matched_ffc_to_sleeper: merged.matchedFfcToSleeper,
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
    `✅ Wrote ${outPath} (final=${merged.players.length}, ffc=${ffc.players.length}, sleeperOnly=${merged.addedSleeperOnly})`
  );
}

main().catch((e) => {
  console.warn(`⚠️ ADP script error (skipping update): ${e?.message || e}`);
  process.exit(0);
});
