// scripts/update-adp.mjs
import fs from "node:fs";
import path from "node:path";

const ADP_SCORING = process.env.ADP_SCORING || "ppr"; // "ppr" | "standard" | "half-ppr"
const ADP_TEAMS = Number(process.env.ADP_TEAMS || 10);

// FantasyFootballCalculator API (server-side fetch OK)
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
    // cache: "no-store", // opcional
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.json();
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

      const payload = {
        meta: {
          source: "fantasyfootballcalculator.com",
          scoring: ADP_SCORING,
          teams: ADP_TEAMS,
          year: y,
          updatedAt: new Date().toISOString(),
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
    `⚠️ ADP update skipped (all years failed). Keeping existing public/adp.json. Last error: ${
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
