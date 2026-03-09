#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_PATH = path.join(PUBLIC_DIR, 'fantasypros-dynasty-values.json');
const ADP_PATH = path.join(PUBLIC_DIR, 'adp.json');

const URLS = {
  tradeChartIndex: 'https://www.fantasypros.com/content/nfl/dynasty-nfl/nfl-trade-value-chart/',
  tradeChartFallback: 'https://www.fantasypros.com/2026/03/fantasy-football-rankings-dynasty-trade-value-chart-march-2026-update/',
};

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&minus;/g, '-')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<\/(p|div|section|article|li|tr|table|h\d|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

function cleanCell(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim()
  );
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      referer: 'https://www.fantasypros.com/',
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

function parseHtmlTables(html) {
  const tables = [];
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let match;
  while ((match = tableRegex.exec(html))) {
    const fullTable = match[0];
    const rows = [];
    const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(fullTable))) {
      const cells = [];
      const cellRegex = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[0]))) {
        cells.push(cleanCell(cellMatch[2]));
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) continue;

    const prefix = html.slice(Math.max(0, match.index - 3000), match.index);
    const headingMatches = [...prefix.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
    const heading = headingMatches.length ? cleanCell(headingMatches[headingMatches.length - 1][1]) : '';
    tables.push({ heading, rows });
  }
  return tables;
}

function normalizeHeaderValue(v) {
  return normalizeName(String(v || '').replace(/\n/g, ' '));
}

function guessPosFromHeading(heading) {
  const h = normalizeHeaderValue(heading);
  if (h.includes('quarterback')) return 'QB';
  if (h.includes('running back')) return 'RB';
  if (h.includes('wide receiver')) return 'WR';
  if (h.includes('tight end')) return 'TE';
  return '';
}

function findColumnIndex(headers, patterns) {
  return headers.findIndex((h) => patterns.some((p) => p.test(h)));
}

function parsePlayerTablesFromHtml(html) {
  const tables = parseHtmlTables(html);
  const players = [];

  for (const table of tables) {
    const headers = (table.rows[0] || []).map(normalizeHeaderValue);
    const pos = guessPosFromHeading(table.heading);
    if (!pos) continue;

    const playerIdx = findColumnIndex(headers, [/^player$/, /player name/, /^name$/]);
    const valueIdx = findColumnIndex(headers, [/(^|\b)1qb(\b| value)/, /trade value/]);
    const sfIdx = findColumnIndex(headers, [/(^|\b)sf(\b| value)/, /superflex/]);
    const teamIdx = findColumnIndex(headers, [/^team$/, /^tm$/, /nfl team/]);

    if (playerIdx < 0 || valueIdx < 0) continue;
    if (sfIdx === valueIdx) continue;

    for (const row of table.rows.slice(1)) {
      const name = String(row[playerIdx] || '').replace(/\n/g, ' ').trim();
      const team = String(row[teamIdx] || '').replace(/\n/g, ' ').trim().toUpperCase();
      const valueText = String(row[valueIdx] || '').replace(/,/g, '').trim();
      const value = Number(valueText.match(/-?\d+(?:\.\d+)?/)?.[0]);
      if (!name || !Number.isFinite(value)) continue;
      players.push({ name, team, pos, value: Math.round(value) });
    }
  }

  return players;
}

function extractSection(text, startLabel, endLabels) {
  const start = text.search(startLabel);
  if (start < 0) return '';
  let end = text.length;
  for (const re of endLabels) {
    const m = re.exec(text.slice(start + 1));
    if (m) end = Math.min(end, start + 1 + m.index);
  }
  return text.slice(start, end);
}

function parsePlayerSection(sectionText, pos) {
  const rows = [];
  const lineRegex = /(?:^|\n)\s*(\d{1,3})\s+([A-Za-z0-9.'’\- ]+?),\s*([A-Z]{1,4}|FA),\s*(\d{1,3})(?:\s*,\s*[-+−\d.\/ ]+)?/g;
  let match;
  while ((match = lineRegex.exec(sectionText))) {
    rows.push({
      rank: Number(match[1]),
      name: match[2].trim(),
      team: match[3].trim().toUpperCase(),
      pos,
      value: Number(match[4]),
    });
  }
  return rows;
}

function parsePlayersFromText(html) {
  const text = stripHtmlToText(html);
  const endLabels = [
    /Dynasty Trade Values: Quarterbacks/i,
    /Dynasty Trade Values: Running Backs/i,
    /Dynasty Trade Values: Wide Receivers/i,
    /Dynasty Trade Value Chart: Tight Ends/i,
    /Subscribe:/i,
    /Articles\s+Dynasty/i,
  ];

  const sections = [
    { pos: 'QB', start: /Dynasty Trade Values: Quarterbacks/i },
    { pos: 'RB', start: /Dynasty Trade Values: Running Backs/i },
    { pos: 'WR', start: /Dynasty Trade Values: Wide Receivers/i },
    { pos: 'TE', start: /Dynasty Trade Value Chart: Tight Ends/i },
  ];

  const out = [];
  for (const sec of sections) {
    const sectionText = extractSection(text, sec.start, endLabels.filter((x) => String(x) !== String(sec.start)));
    out.push(...parsePlayerSection(sectionText, sec.pos));
  }
  return out;
}

function uniquePlayers(rows) {
  const byName = new Map();
  for (const row of rows || []) {
    const key = normalizeName(row?.name);
    if (!key) continue;
    const current = byName.get(key);
    if (!current) {
      byName.set(key, row);
      continue;
    }
    const currentRank = Number(current.rank || 999999);
    const nextRank = Number(row.rank || 999999);
    if (nextRank < currentRank) byName.set(key, row);
  }
  return [...byName.values()];
}

function parsePlayersFromTradeChart(html) {
  const fromTables = parsePlayerTablesFromHtml(html);
  if (fromTables.length >= 40) return uniquePlayers(fromTables);

  const fromText = parsePlayersFromText(html);
  if (fromText.length >= fromTables.length) return uniquePlayers(fromText);
  return uniquePlayers(fromTables);
}

function lineValue(text, re) {
  const match = text.match(re);
  return match ? Number(match[1]) : NaN;
}

function expandPickValuesFromTradeText(text) {
  const pickValues = {};

  for (let slot = 1; slot <= 12; slot += 1) {
    const key = `2026-1.${String(slot).padStart(2, '0')}`;
    const exact = lineValue(text, new RegExp(`1\\.${slot}\\s+(\\d+)`, 'i'));
    if (Number.isFinite(exact)) pickValues[key] = exact;
  }

  const early2 = lineValue(text, /Early\s+2nd\s+(\d+)/i);
  const mid2 = lineValue(text, /Mid\s+2nd\s+(\d+)/i);
  const late2 = lineValue(text, /Late\s+2nd\s+(\d+)/i);
  const early3 = lineValue(text, /Early\s+3rd\s+(\d+)/i);
  const mid3 = lineValue(text, /Middle\s+3rd\s+(\d+)/i);
  const late3 = lineValue(text, /Late\s+3rd\s+(\d+)/i);
  const early4 = lineValue(text, /Early\s+4th\s+(\d+)/i);
  const late4 = lineValue(text, /Late\s+4th\s+(\d+)/i);
  const round5Plus = lineValue(text, /All\s+Picks\s+(\d+)/i);

  for (let slot = 1; slot <= 10; slot += 1) {
    const s = String(slot).padStart(2, '0');
    pickValues[`2026-2.${s}`] = slot <= 3 ? early2 : slot <= 7 ? mid2 : late2;
    pickValues[`2026-3.${s}`] = slot <= 3 ? early3 : slot <= 7 ? mid3 : late3;
    pickValues[`2026-4.${s}`] = slot <= 5 ? early4 : late4;
    pickValues[`2026-5.${s}`] = round5Plus;
    pickValues[`2026-6.${s}`] = round5Plus;
  }

  const r27Top = lineValue(text, /1\.01\s*[–-]\s*1\.03\s+(\d+)/i);
  const r27Mid = lineValue(text, /1\.04\s*[–-]\s*1\.06\s+(\d+)/i);
  const r27Late = lineValue(text, /1\.07\s*[–-]\s*1\.12\s+(\d+)/i);
  const r27Early2 = lineValue(text, /Early\s+2nd\s+(\d+)/i);
  const r27Late2 = lineValue(text, /Late\s+2nd\s+(\d+)/i);
  const r27Early3 = lineValue(text, /Early\s+3rd\s+(\d+)/i);
  const r27Late3 = lineValue(text, /Late\s+3rd\s+(\d+)/i);
  const r27Other = lineValue(text, /All\s+others\s+(\d+)/i);

  pickValues['2027-1'] = r27Mid || r27Top || 55;
  pickValues['2027-2'] = Number.isFinite(r27Early2) && Number.isFinite(r27Late2)
    ? Math.round((r27Early2 + r27Late2) / 2)
    : 30;
  pickValues['2027-3'] = Number.isFinite(r27Early3) && Number.isFinite(r27Late3)
    ? Math.round((r27Early3 + r27Late3) / 2)
    : 17;
  pickValues['2027-4'] = r27Other || 8;
  pickValues['2027-5'] = r27Other || 8;
  pickValues['2027-6'] = r27Other || 8;

  for (let slot = 1; slot <= 10; slot += 1) {
    const s = String(slot).padStart(2, '0');
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
      const s = String(slot).padStart(2, '0');
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
    const raw = JSON.parse(await fs.readFile(ADP_PATH, 'utf8'));
    return Array.isArray(raw?.players) ? raw.players : [];
  } catch {
    return [];
  }
}

function buildArticleExactValues(playersFromChart, adpPlayers) {
  const chartByName = new Map();
  for (const row of playersFromChart) {
    const key = normalizeName(row.name);
    if (!key || !Number.isFinite(Number(row.value))) continue;
    chartByName.set(key, {
      name: row.name,
      team: row.team || '',
      pos: row.pos || '',
      value: Math.round(Number(row.value)),
      source: 'fantasypros-trade-chart-1qb',
    });
  }

  const byName = {};
  for (const [key, row] of chartByName.entries()) byName[key] = row.value;

  const byId = {};
  const players = [];
  let unmatchedAdp = 0;

  for (const p of adpPlayers) {
    const id = String(p?.player_id ?? p?.id ?? '').trim();
    const name = String(p?.name || p?.player_name || p?.full_name || '').trim();
    if (!id || !name) continue;
    const key = normalizeName(name);
    const exact = chartByName.get(key);
    if (!exact) {
      unmatchedAdp += 1;
      continue;
    }
    byId[id] = exact.value;
    players.push({ id, name, value: exact.value, source: exact.source });
  }

  return { byName, byId, players, unmatchedAdp, chartPlayers: chartByName.size };
}

async function main() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });

  log('fetching latest trade chart index');
  const tradeIndexHtml = await fetchText(URLS.tradeChartIndex).catch(() => '');
  const tradeChartUrl = extractTradeChartUrl(tradeIndexHtml || '');
  log(`trade chart: ${tradeChartUrl}`);

  const tradeHtml = await fetchText(tradeChartUrl);
  const tradeText = stripHtmlToText(tradeHtml);

  const playersFromChart = parsePlayersFromTradeChart(tradeHtml);
  if (!playersFromChart.length) {
    throw new Error('Could not parse player values from the latest FantasyPros trade value chart.');
  }
  log(`parsed player values from chart: ${playersFromChart.length}`);

  const adpPlayers = await readAdpPlayers();
  const exact = buildArticleExactValues(playersFromChart, adpPlayers);
  const pickValues = expandPickValuesFromTradeText(tradeText);

  const payload = {
    source: 'FantasyPros Trade Value Chart',
    generatedFor: 'FantasyPros dynasty 1QB / Trade Value only',
    updatedAt: nowIso(),
    tradeChartUrl,
    complete: exact.unmatchedAdp === 0,
    counts: {
      adpPlayers: adpPlayers.length,
      chartPlayers: exact.chartPlayers,
      byId: Object.keys(exact.byId).length,
      byName: Object.keys(exact.byName).length,
      picks: Object.keys(pickValues).length,
      unmatchedAdpPlayers: exact.unmatchedAdp,
    },
    players: exact.players,
    byId: exact.byId,
    byName: exact.byName,
    pickValues,
  };

  await fs.writeFile(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log(`wrote ${OUT_PATH} (players=${payload.players.length}, picks=${Object.keys(pickValues).length}, unmatchedAdpPlayers=${exact.unmatchedAdp})`);
}

main().catch((err) => {
  console.error(`❌ FantasyPros update failed: ${err?.message || err}`);
  process.exit(1);
});
