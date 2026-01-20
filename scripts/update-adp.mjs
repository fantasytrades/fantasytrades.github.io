// scripts/update-adp.mjs
import fs from "node:fs";
import path from "node:path";

const ADP_SCORING = process.env.ADP_SCORING || "ppr";
const ADP_TEAMS = Number(process.env.ADP_TEAMS || 10);

// FantasyFootballCalculator API (server-side fetch OK)
function ffcUrl(year) {
  return `https://fantasyfootballcalculator.com/api/v1/adp/${ADP_SCORING}?teams=${ADP_TEAMS}&year=${year}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "fantasytrades-adp-updater" },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const yearNow = new Date().getFullYear();
  const yearsToTry = [yearNow, yearNow - 1];

  let lastErr = null;
  for (const y of yearsToTry) {
    try {
      const data = await fetchJson(ffcUrl(y));
      if (!data?.players || !Array.isArray(data.players)) {
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
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ year=${y} failed: ${e?.message || e}`);
    }
  }

  throw lastErr || new Error("Could not fetch ADP");
}

main().catch((e) => {
  console.error("❌ ADP update failed:", e?.message || e);
  process.exit(1);
});
