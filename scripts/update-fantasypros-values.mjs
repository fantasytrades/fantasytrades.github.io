#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const OUT_PATH = path.join(PUBLIC_DIR, "fantasypros-dynasty-values.json");
const ADP_PATH = path.join(PUBLIC_DIR, "adp.json");

const URLS = {
  rankings: "https://www.fantasypros.com/nfl/rankings/?type=dynasty",
  rankingsAlt: "https://www.fantasypros.com/nfl/rankings/dynasty-overall.php",
  rookieRankings: "https://www.fantasypros.com/nfl/rankings/dynasty-rookies-overall.php",
  tradeChartIndex: "https://www.fantasypros.com/content/nfl/dynasty-nfl/nfl-trade-value-chart/",
  tradeChartFallback: "https://www.fantasypros.com/2026/03/fantasy-football-rankings-dynasty-trade-value-chart-march-2026-update/",
};

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function log(message) {
  console.log(`🟦 FantasyPros: ${message}`);
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(str) {
  return String(str || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<\/(p|div|section|article|li|tr|table|h\d|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": "en-US,en;q=0.9",
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      referer: "https://www.fantasypros.com/",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return await res.text();
}

function extractTradeChartUrl(indexHtml) {
  const absMatches = [...indexHtml.matchAll(/https:\/\/www\.fantasypros\.com\/\d{4}\/\d{2}\/fantasy-football-rankings-dynasty-trade-value-chart[^"'\s<)]+/g)].map((m) => m[0]);
  if (absMatches.length) return absMatches[0];

  const relMatches = [...indexHtml.matchAll(/href=["'](\/\d{4}\/\d{2}\/fantasy-football-rankings-dynasty-trade-value-chart[^"']+)["']/g)].map((m) => `https://www.fantasypros.com${m[1]}`);
  if (relMatches.length) return relMatches[0];

  return URLS.tradeChartFallback;
}

function uniquePlayers(rows) {
  const byName = new Map();
  for (const row of rows || []) {
    const key = normalizeName(row?.name);
    if (!key) continue;
    const rank = Number(row?.rank);
    const current = byName.get(key);
    if (!current || (Number.isFinite(rank) && rank < current.rank)) {
      byName.set(key, {
        name: String(row.name || "").trim(),
        rank,
        pos: String(row.pos || "").toUpperCase(),
        team: String(row.team || "").toUpperCase(),
        id: row.id ? String(row.id) : "",
      });
    }
  }
  return [...byName.values()];
}

function extractPlayersFromText(text) {
  const rows = [];
  const re = /(?:^|\n)\s*(\d{1,3})\s+([A-Za-z0-9.'’\- ]+?)\s+\((QB|RB|WR|TE)\s*-\s*([A-Z]{1,4}|FA)\)/g;
  for (const match of text.matchAll(re)) {
    rows.push({
      rank: Number(match[1]),
      name: match[2].trim(),
      pos: match[3].trim().toUpperCase(),
      team: match[4].trim().toUpperCase(),
    });
  }
  return uniquePlayers(rows);
}

function normalizePlayerCandidate(row) {
  if (!row || typeof row !== "object") return null;
  const name = row.name || row.player_name || row.playerName || row.player || row.full_name || row.fullName || "";
  const pos = String(row.pos || row.position || row.player_position || row.playerPosition || "").toUpperCase();
  const rank = Number(
    row.rank ?? row.ecr ?? row.overall_rank ?? row.overallRank ?? row.playerRank ?? row.rk ?? row.overall_rank_ecr
  );
  if (!name || !["QB", "RB", "WR", "TE"].includes(pos) || !Number.isFinite(rank) || rank <= 0) return null;
  return {
    name: String(name).trim(),
    pos,
    rank,
    team: String(row.team || row.team_name || row.player_team_id || row.nfl_team || "").toUpperCase(),
    id: String(row.player_id || row.playerId || row.sleeper_id || row.sleeperId || row.id || "").trim(),
  };
}

function collectPlayerArrays(node, sink = [], seen = new Set()) {
  if (!node || typeof node !== "object") return sink;
  if (seen.has(node)) return sink;
  seen.add(node);

  if (Array.isArray(node)) {
    if (node.length >= 20) {
      const normalized = node.map(normalizePlayerCandidate).filter(Boolean);
      if (normalized.length >= 20) sink.push(uniquePlayers(normalized));
    }
    for (const item of node) collectPlayerArrays(item, sink, seen);
    return sink;
  }

  for (const value of Object.values(node)) collectPlayerArrays(value, sink, seen);
  return sink;
}

function extractPlayersFromJsonScripts(html) {
  const candidates = [];
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

  for (const script of scripts) {
    const trimmed = script.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        collectPlayerArrays(parsed, candidates);
      } catch {}
    }

    const dataVarMatches = [
      ...trimmed.matchAll(/(?:var|let|const)\s+[A-Za-z0-9_$]+\s*=\s*(\[[\s\S]*?\]);/g),
      ...trimmed.matchAll(/(?:var|let|const)\s+[A-Za-z0-9_$]+\s*=\s*(\{[\s\S]*?\});/g),
    ];

    for (const m of dataVarMatches) {
      try {
        const parsed = JSON.parse(m[1]);
        collectPlayerArrays(parsed, candidates);
      } catch {}
    }
  }

  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || [];
}

function extractPlayers(html) {
  const text = stripHtmlToText(html);
  const fromText = extractPlayersFromText(text);
  if (fromText.length >= 80) return fromText;

  const fromJson = extractPlayersFromJsonScripts(html);
  if (fromJson.length >= fromText.length) return fromJson;
  return fromText;
}

function interpolate(points, x) {
  const safeX = Math.max(points[0][0], x);
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    if (safeX <= x2) {
      const t = (safeX - x1) / (x2 - x1);
      return y1 + (y2 - y1) * t;
    }
  }
  return points[points.length - 1][1];
}

const OVERALL_CURVE = [
  [1, 100],
  [5, 90],
  [10, 80],
  [20, 66],
  [30, 56],
  [50, 41],
  [75, 30],
  [100, 22],
  [150, 14],
  [200, 9],
  [300, 4],
];

const ROOKIE_VALUE_LADDER = [
  68, 58, 56, 54, 52, 50, 48, 46, 44, 42, 40, 38,
  35, 33, 31, 29, 27, 24, 22, 20, 18, 16, 15, 14,
  12, 10, 9, 8, 7, 6, 5, 4, 3,
];

function valueFromOverallRank(rank, pos) {
  let value = interpolate(OVERALL_CURVE, rank);
  if (pos === "QB") value *= 0.8;
  if (pos === "TE") value *= 0.94;
  return clamp(Math.round(value), 3, 100);
}

function valueFromRookieRank(rank, pos) {
  const idx = Math.max(0, Math.round(rank) - 1);
  let base = ROOKIE_VALUE_LADDER[idx];
  if (!Number.isFinite(base)) {
    const last = ROOKIE_VALUE_LADDER[ROOKIE_VALUE_LADDER.length - 1];
    base = Math.max(3, Math.round(last - (idx - ROOKIE_VALUE_LADDER.length + 1) * 0.35));
  }
  if (pos === "QB") base = Math.max(3, Math.round(base * 0.9));
  return clamp(base, 3, 80);
}

function expandPickValuesFromTradeText(text) {
  const pickValues = {};

  const lineValue = (label, re) => {
    const match = text.match(re);
    return match ? Number(match[1]) : NaN;
  };

  for (let slot = 1; slot <= 10; slot += 1) {
    const key = `2026-1.${String(slot).padStart(2, "0")}`;
    const exactLine = new RegExp(`1\\.${slot}\\s+(\\d+)`, "i");
    const exact = lineValue(`1.${slot}`, exactLine);
    if (Number.isFinite(exact)) pickValues[key] = exact;
  }

  const early2 = lineValue("Early 2nd", /Early\s+2nd\s+(\d+)/i);
  const mid2 = lineValue("Mid 2nd", /Mid\s+2nd\s+(\d+)/i);
  const late2 = lineValue("Late 2nd", /Late\s+2nd\s+(\d+)/i);
  const early3 = lineValue("Early 3rd", /Early\s+3rd\s+(\d+)/i);
  const mid3 = lineValue("Middle 3rd", /Middle\s+3rd\s+(\d+)/i);
  const late3 = lineValue("Late 3rd", /Late\s+3rd\s+(\d+)/i);
  const early4 = lineValue("Early 4th", /Early\s+4th\s+(\d+)/i);
  const late4 = lineValue("Late 4th", /Late\s+4th\s+(\d+)/i);
  const round5Plus = lineValue("Round 5+", /All\s+Picks\s+(\d+)/i);

  for (let slot = 1; slot <= 10; slot += 1) {
    const s = String(slot).padStart(2, "0");
    pickValues[`2026-2.${s}`] = slot <= 3 ? early2 : slot <= 7 ? mid2 : late2;
    pickValues[`2026-3.${s}`] = slot <= 3 ? early3 : slot <= 7 ? mid3 : late3;
    pickValues[`2026-4.${s}`] = slot <= 5 ? early4 : late4;
    pickValues[`2026-5.${s}`] = round5Plus;
    pickValues[`2026-6.${s}`] = round5Plus;
  }

  const r27Top = lineValue("2027 top tier", /1\.01\s*[–-]\s*1\.03\s+(\d+)/i);
  const r27Mid = lineValue("2027 mid tier", /1\.04\s*[–-]\s*1\.06\s+(\d+)/i);
  const r27Late = lineValue("2027 late tier", /1\.07\s*[–-]\s*1\.12\s+(\d+)/i);
  const r27Early2 = lineValue("2027 early 2nd", /Early\s+2nd\s+(\d+)/i);
  const r27Late2 = lineValue("2027 late 2nd", /Late\s+2nd\s+(\d+)/i);
  const r27Early3 = lineValue("2027 early 3rd", /Early\s+3rd\s+(\d+)/i);
  const r27Late3 = lineValue("2027 late 3rd", /Late\s+3rd\s+(\d+)/i);
  const r27Other = lineValue("2027 all others", /All\s+others\s+(\d+)/i);

  pickValues["2027-1"] = r27Mid || r27Top || 55;
  pickValues["2027-2"] = Number.isFinite(r27Early2) && Number.isFinite(r27Late2)
    ? Math.round((r27Early2 + r27Late2) / 2)
    : 30;
  pickValues["2027-3"] = Number.isFinite(r27Early3) && Number.isFinite(r27Late3)
    ? Math.round((r27Early3 + r27Late3) / 2)
    : 17;
  pickValues["2027-4"] = r27Other || 8;
  pickValues["2027-5"] = r27Other || 8;
  pickValues["2027-6"] = r27Other || 8;

  for (let slot = 1; slot <= 10; slot += 1) {
    const s = String(slot).padStart(2, "0");
    pickValues[`2027-1.${s}`] = slot <= 3 ? r27Top : slot <= 6 ? r27Mid : r27Late;
    pickValues[`2027-2.${s}`] = slot <= 5 ? r27Early2 : r27Late2;
    pickValues[`2027-3.${s}`] = slot <= 5 ? r27Early3 : r27Late3;
    pickValues[`2027-4.${s}`] = r27Other;
    pickValues[`2027-5.${s}`] = r27Other;
    pickValues[`2027-6.${s}`] = r27Other;
  }

  for (const round of [1, 2, 3, 4, 5, 6]) {
    const base2027 = pickValues[`2027-${round}`] || 8;
    pickValues[`2028-${round}`] = Math.max(3, Math.round(base2027 * 0.86));
    for (let slot = 1; slot <= 10; slot += 1) {
      const s = String(slot).padStart(2, "0");
      const p27 = pickValues[`2027-${round}.${s}`] || base2027;
      pickValues[`2028-${round}.${s}`] = Math.max(3, Math.round(p27 * 0.86));
    }
  }

  for (const [key, value] of Object.entries(pickValues)) {
    if (!Number.isFinite(Number(value))) delete pickValues[key];
  }

  return pickValues;
}

async function readAdpPlayers() {
  try {
    const raw = JSON.parse(await fs.readFile(ADP_PATH, "utf8"));
    return Array.isArray(raw?.players) ? raw.players : [];
  } catch {
    return [];
  }
}

async function main() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });

  log("fetching latest trade chart index");
  const tradeIndexHtml = await fetchText(URLS.tradeChartIndex).catch(() => "");
  const tradeChartUrl = extractTradeChartUrl(tradeIndexHtml || "");
  log(`trade chart: ${tradeChartUrl}`);

  const [tradeHtml, overallHtml, rookieHtml, altOverallHtml] = await Promise.all([
    fetchText(tradeChartUrl),
    fetchText(URLS.rankings),
    fetchText(URLS.rookieRankings).catch(() => ""),
    fetchText(URLS.rankingsAlt).catch(() => ""),
  ]);

  const tradeText = stripHtmlToText(tradeHtml);
  const overallPlayers = uniquePlayers([
    ...extractPlayers(overallHtml),
    ...extractPlayers(altOverallHtml),
  ]);
  const rookiePlayers = extractPlayers(rookieHtml);

  log(`overall players parsed: ${overallPlayers.length}`);
  log(`rookies parsed: ${rookiePlayers.length}`);

  const byNameMeta = new Map();
  for (const row of overallPlayers) {
    const key = normalizeName(row.name);
    if (!key) continue;
    byNameMeta.set(key, {
      name: row.name,
      pos: row.pos,
      team: row.team,
      value: valueFromOverallRank(row.rank, row.pos),
      rank: row.rank,
      source: "fantasypros-overall-rank",
    });
  }

  for (const row of rookiePlayers) {
    const key = normalizeName(row.name);
    if (!key) continue;
    const rookieValue = valueFromRookieRank(row.rank, row.pos);
    const existing = byNameMeta.get(key);
    if (!existing || rookieValue > existing.value) {
      byNameMeta.set(key, {
        name: row.name,
        pos: row.pos,
        team: row.team,
        value: rookieValue,
        rank: row.rank,
        source: "fantasypros-rookie-rank",
      });
    }
  }

  const adpPlayers = await readAdpPlayers();
  const byId = {};
  const byName = {};
  const players = [];
  let fallbackPlayers = 0;

  for (const [key, meta] of byNameMeta.entries()) {
    byName[key] = meta.value;
  }

  for (const p of adpPlayers) {
    const id = String(p?.player_id ?? p?.id ?? "").trim();
    const name = String(p?.name || p?.player_name || p?.full_name || "").trim();
    if (!id || !name) continue;

    const key = normalizeName(name);
    const fpMeta = byNameMeta.get(key);
    const pos = String(p?.position || p?.pos || p?.player_position || "").toUpperCase();
    let value;
    let source;

    if (fpMeta) {
      value = fpMeta.value;
      source = fpMeta.source;
    } else {
      const rank = Number(p?.dynasty_rank ?? p?.ecr ?? p?.rank ?? p?.adp ?? p?.adp_ppr ?? p?.adp_rank);
      value = valueFromOverallRank(Number.isFinite(rank) ? rank : 220, pos);
      source = "local-fallback";
      fallbackPlayers += 1;
      if (!(key in byName)) byName[key] = value;
    }

    byId[id] = value;
    players.push({ id, name, value, source });
  }

  const pickValues = expandPickValuesFromTradeText(tradeText);

  const payload = {
    source: "FantasyPros",
    generatedFor: "FantasyPros dynasty 1QB PPR",
    updatedAt: nowIso(),
    tradeChartUrl,
    rankingsUrl: URLS.rankings,
    rookieRankingsUrl: URLS.rookieRankings,
    complete: fallbackPlayers === 0,
    counts: {
      adpPlayers: adpPlayers.length,
      fantasyProsNames: Object.keys(byName).length,
      byId: Object.keys(byId).length,
      picks: Object.keys(pickValues).length,
      fallbackPlayers,
    },
    players,
    byId,
    byName,
    pickValues,
  };

  await fs.writeFile(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  log(`wrote ${OUT_PATH} (players=${players.length}, picks=${Object.keys(pickValues).length}, fallbackPlayers=${fallbackPlayers})`);
}

main().catch((err) => {
  console.error(`❌ FantasyPros update failed: ${err?.message || err}`);
  process.exit(1);
});
