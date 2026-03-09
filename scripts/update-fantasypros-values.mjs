#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_PATH = path.join(PUBLIC_DIR, 'fantasypros-dynasty-values.json');

const URLS = {
  values: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/values.csv',
  ids: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv',
  calculator: 'https://calc.dynastyprocess.com/',
  openData: 'https://github.com/dynastyprocess/data',
};

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(message) {
  console.log(`🟦 DynastyProcess: ${message}`);
}

function nowIso() {
  return new Date().toISOString();
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

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function scaled1qbValue(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return round1(n / 100);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/plain,text/csv,text/html;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer: 'https://dynastyprocess.com/',
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return await res.text();
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }

    if (ch === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
      continue;
    }

    if (ch === '\r') continue;
    cell += ch;
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  return rows.slice(1).filter((r) => r.some((x) => String(x || '').trim() !== '')).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] ?? '';
    });
    return obj;
  });
}

function buildIdIndex(idRows) {
  const byFantasyProsId = new Map();
  const byName = new Map();

  for (const row of idRows) {
    const fpId = String(row.fantasypros_id || '').trim().replace(/\.0$/, '');
    const sleeperId = String(row.sleeper_id || '').trim().replace(/\.0$/, '');
    const nameKey = normalizeName(row.name);
    const team = String(row.team || '').trim().toUpperCase();

    if (fpId && sleeperId) byFantasyProsId.set(fpId, sleeperId);
    if (nameKey) byName.set(`${nameKey}::${team}`, sleeperId || '');
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, sleeperId || '');
  }

  return { byFantasyProsId, byName };
}

function buildPlayerPayload(valueRows, idIndex) {
  const players = [];
  const byId = {};
  const byName = {};
  let mappedById = 0;
  let unmatchedSleeperIds = 0;

  for (const row of valueRows) {
    if (String(row.pos || '').toUpperCase() === 'PICK') continue;

    const name = String(row.player || '').trim();
    const team = String(row.team || '').trim().toUpperCase();
    const value = scaled1qbValue(row.value_1qb);
    if (!name || !Number.isFinite(value)) continue;

    const norm = normalizeName(name);
    if (!norm) continue;
    byName[norm] = value;

    const fpId = String(row.fp_id || '').trim().replace(/\.0$/, '');
    const sleeperId =
      idIndex.byFantasyProsId.get(fpId) ||
      idIndex.byName.get(`${norm}::${team}`) ||
      idIndex.byName.get(norm) ||
      '';

    const item = {
      name,
      value,
      source: 'dynastyprocess-open-data',
    };

    if (sleeperId) {
      byId[sleeperId] = value;
      item.id = sleeperId;
      mappedById += 1;
    } else {
      unmatchedSleeperIds += 1;
    }

    players.push(item);
  }

  return {
    players,
    byId,
    byName,
    mappedById,
    unmatchedSleeperIds,
  };
}

function buildPickPayload(valueRows) {
  const pickValues = {};
  let derivedPicks = 0;

  const setPick = (key, rawValue) => {
    const value = Number(rawValue);
    if (!key || !Number.isFinite(value)) return;
    pickValues[key] = round1(value);
  };

  for (const row of valueRows) {
    if (String(row.pos || '').toUpperCase() !== 'PICK') continue;
    const label = String(row.player || '').trim();
    const value = scaled1qbValue(row.value_1qb);
    if (!label || !Number.isFinite(value)) continue;

    let match = label.match(/^(\d{4})\s+Pick\s+(\d)\.(\d{2})$/i);
    if (match) {
      const year = Number(match[1]);
      const round = Number(match[2]);
      const slot = Number(match[3]);
      if (year === 2026 && slot <= 10) {
        setPick(`${year}-${round}.${String(slot).padStart(2, '0')}`, value);
      }
      continue;
    }

    match = label.match(/^(\d{4})\s+(\d)(?:st|nd|rd|th)$/i);
    if (match) {
      setPick(`${match[1]}-${match[2]}`, value);
      continue;
    }
  }

  for (let round = 2; round <= 5; round += 1) {
    for (let slot = 1; slot <= 10; slot += 1) {
      const key = `2026-${round}.${String(slot).padStart(2, '0')}`;
      if (!Number.isFinite(pickValues[key])) {
        const prev = pickValues[`2026-${round - 1}.${String(slot).padStart(2, '0')}`];
        if (Number.isFinite(prev)) {
          setPick(key, prev * 0.82);
          derivedPicks += 1;
        }
      }
    }
  }

  for (let slot = 1; slot <= 10; slot += 1) {
    const prev = pickValues[`2026-5.${String(slot).padStart(2, '0')}`];
    if (Number.isFinite(prev)) {
      setPick(`2026-6.${String(slot).padStart(2, '0')}`, prev * 0.8);
      derivedPicks += 1;
    }
  }

  for (let round = 1; round <= 5; round += 1) {
    if (!Number.isFinite(pickValues[`2027-${round}`])) {
      const slots = Array.from({ length: 10 }, (_, idx) => pickValues[`2026-${round}.${String(idx + 1).padStart(2, '0')}`]).filter(Number.isFinite);
      if (slots.length) {
        const avg = slots.reduce((sum, n) => sum + n, 0) / slots.length;
        setPick(`2027-${round}`, avg * 0.92);
        derivedPicks += 1;
      }
    }
  }

  if (!Number.isFinite(pickValues['2027-6']) && Number.isFinite(pickValues['2027-5'])) {
    setPick('2027-6', pickValues['2027-5'] * 0.8);
    derivedPicks += 1;
  }

  for (let round = 1; round <= 6; round += 1) {
    if (!Number.isFinite(pickValues[`2028-${round}`]) && Number.isFinite(pickValues[`2027-${round}`])) {
      setPick(`2028-${round}`, pickValues[`2027-${round}`] * 0.8);
      derivedPicks += 1;
    }
  }

  return { pickValues, derivedPicks };
}

async function main() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });

  log('fetching DynastyProcess open data');
  const [valuesCsv, idsCsv] = await Promise.all([
    fetchText(URLS.values),
    fetchText(URLS.ids),
  ]);

  const valueRows = parseCSV(valuesCsv);
  const idRows = parseCSV(idsCsv);
  if (!valueRows.length) throw new Error('DynastyProcess values.csv came back empty.');
  if (!idRows.length) throw new Error('DynastyProcess db_playerids.csv came back empty.');

  const idIndex = buildIdIndex(idRows);
  const players = buildPlayerPayload(valueRows, idIndex);
  const picks = buildPickPayload(valueRows);

  const latestScrape = valueRows[0]?.scrape_date || nowIso().slice(0, 10);

  const payload = {
    source: 'DynastyProcess Open Data',
    generatedFor: 'DynastyProcess dynasty 1QB',
    updatedAt: nowIso(),
    sourceUpdatedAt: latestScrape,
    calculatorUrl: URLS.calculator,
    openDataUrl: URLS.openData,
    file: 'values.csv',
    complete: Object.keys(players.byName).length > 0 && Object.keys(picks.pickValues).length > 0,
    counts: {
      players: players.players.length,
      byId: Object.keys(players.byId).length,
      byName: Object.keys(players.byName).length,
      picks: Object.keys(picks.pickValues).length,
      unmatchedSleeperIds: players.unmatchedSleeperIds,
      derivedPicks: picks.derivedPicks,
      fallbackPlayers: 0,
    },
    players: players.players,
    byId: players.byId,
    byName: players.byName,
    pickValues: picks.pickValues,
  };

  await fs.writeFile(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log(`wrote ${OUT_PATH} (players=${payload.counts.players}, byId=${payload.counts.byId}, picks=${payload.counts.picks})`);
}

main().catch((err) => {
  console.error(`❌ DynastyProcess update failed: ${err?.message || err}`);
  process.exit(1);
});
