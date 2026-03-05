// scripts/update-adp.mjs
import fs from "node:fs";
import path from "node:path";

const ADP_SCORING = process.env.ADP_SCORING || "ppr"; // "ppr" | "standard" | "half-ppr"
const ADP_TEAMS = Number(process.env.ADP_TEAMS || 10);

// Formato va en el PATH: /api/v1/adp/{scoring}?teams=...&year=...
function ffcUrl(year) {
  return `https://fantasyfootballcalculator.com/api/v1/adp/${encodeURIComponent(
    ADP_SCORING
  )}?teams=${encodeURIComponent(String(ADP_TEAMS))}&year=${encodeURIComponent(
    String(year)
  )}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "fantasytrades-adp-updater" },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.json();
}

/** =======================
 * Sleeper headshots enrich
 * ======================= */

// Normalizaciones simples para matchear FFC vs Sleeper
const TEAM_MAP = { JAC: "JAX", WAS: "WSH" };

const normName = (s = "") =>
  s
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normTeam = (t = "") => TEAM_MAP[(t || "").toUpperCase()] || (t || "").toUpperCase();

function makeKey(name, team, pos) {
  return `${normName(name)}|${normTeam(team)}|${(pos || "").toUpperCase()}`;
}

async function buildSleeperIndex() {
  // OJO: endpoint grande (pero sirve para todos los jugadores)
  const r = await fetch("https://api.sleeper.app/v1/players/nfl", {
    headers: { "User-Agent": "fantasytrades-adp-updater" },
  });
  if (!r.ok) throw new Error(`Sleeper players fetch failed ${r.status}`);
  const all = await r.json(); // { "id": {...}, ... }

  const idx = new Map();
  for (const [id, p] of Object.entries(all)) {
    if (!p?.full_name || !p?.position) continue;

    // Si querés ignorar K/DEF, descomentá:
    // if (p.position === "K" || p.position === "DEF") continue;

    const key = makeKey(p.full_name, p.team || "", p.position);
    if (!idx.has(key)) idx.set(key, id);
  }
  return idx;
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

async function enrichWithHeadshots(players) {
  try {
    const sleeperIdx = await buildSleeperIndex();

    let added = 0;
    for (const p of players) {
      const name = readPlayerName(p);
      const team = readPlayerTeam(p);
      const pos = readPlayerPos(p);

      if (!name || !pos) continue;

      const key = makeKey(name, team, pos);
      const sleeperId = sleeperIdx.get(key);

      if (sleeperId) {
        p.sleeper_id = sleeperId;
        p.headshot = `https://sleepercdn.com/content/nfl/players/${sleeperId}.jpg`;
        added++;
      }
    }

    console.log(`🖼️ Headshots: matched ${added}/${players.length}`);
    return { ok: true, matched: added };
  } catch (e) {
    console.warn(`⚠️ Headshots skipped: ${e?.message || e}`);
    return { ok: false, matched: 0, error: e?.message || String(e) };
  }
}

async function main() {
  const yearNow = new Date().getFullYear();

  // Probá varios por las dudas (a veces el “año de season” cambia)
  const yearsToTry = [yearNow, yearNow + 1, yearNow - 1];

  let lastErr = null;

  for (const y of yearsToTry) {
    try {
      const data = await fetchJson(ffcUrl(y));
      if (!data?.players || !Array.isArray(data.players) || data.players.length === 0) {
        throw new Error(`Invalid payload for year=${y}`);
      }

      // Enriquecer con headshots (si falla, no rompe nada)
      const headshotInfo = await enrichWithHeadshots(data.players);

      const payload = {
        meta: {
          source: "fantasyfootballcalculator.com",
          scoring: ADP_SCORING,
          teams: ADP_TEAMS,
          year: y,
          updatedAt: new Date().toISOString(),
          headshots: {
            source: "sleeper",
            ok: headshotInfo.ok,
            matched: headshotInfo.matched,
          },
        },
        players: data.players,
      };

      const outDir = path.resolve("public");
      const outPath = path.join(outDir, "adp.json");

      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");

      console.log(`✅ Wrote ${outPath} (year=${y}, players=${data.players.length})`);
      return; // éxito
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ year=${y} failed: ${e?.message || e}`);
    }
  }

  // ✅ CLAVE: no romper el build si no se pudo actualizar
  console.warn(
    `⚠️ ADP update skipped (all years failed).\nKeeping existing public/adp.json. Last error: ${
      lastErr?.message || lastErr
    }`
  );
  process.exit(0);
}

main().catch((e) => {
  // También “no romper” por si algo raro explota
  console.warn(`⚠️ ADP script error (skipping update): ${e?.message || e}`);
  process.exit(0);
});
