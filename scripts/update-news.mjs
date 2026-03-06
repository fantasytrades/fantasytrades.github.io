#!/usr/bin/env node
/**
 * Fetches NFL news from ESPN RSS + FantasyPros player news (best-effort) and writes `public/news.json`.
 * Designed to run in GitHub Actions / CI as part of `npm run build` (prebuild).
 *
 * Output shape:
 * {
 *   generatedAt: ISOString,
 *   items: [{ id, source, title, url, publishedAt, publishedTs, description }]
 * }
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const OUT_PATH = path.join(process.cwd(), "public", "news.json");

// Sources
const ESPN_NFL_RSS = "https://www.espn.com/espn/rss/nfl/news";

// FantasyPros: this "partners" endpoint is used by FantasyPros widgets in the wild; it may be rate-limited or change.
// We handle failure gracefully and fall back to scraping the public page (also best-effort).
const FP_PARTNER_JSON = "https://partners.fantasypros.com/api/v1/player-news.php?output=JSON&sport=NFL";
const FP_PUBLIC_PAGE = "https://www.fantasypros.com/nfl/player-news.php";

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function stripCdata(v) {
  return String(v || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchText(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "fantasytrades-newsbot/1.0 (+https://fantasytrades.github.io)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function parseRss(xml, sourceName) {
  const out = [];
  const items = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);

  for (const m of items) {
    const block = m[1];

    const getTag = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
      return r ? decodeEntities(stripCdata(r[1]).trim()) : "";
    };

    const title = getTag("title");
    const url = getTag("link");
    const pubDate = getTag("pubDate");
    const description = stripHtml(getTag("description"));

    const publishedAt = pubDate ? new Date(pubDate).toISOString() : null;
    const publishedTs = publishedAt ? Date.parse(publishedAt) : 0;

    if (!title || !url) continue;

    out.push({
      id: sha1(`${sourceName}|${title}|${url}|${publishedAt || ""}`),
      source: sourceName,
      title,
      url,
      publishedAt,
      publishedTs,
      description,
    });
  }

  return out;
}

function safeJsonParse(maybeJson) {
  const t = String(maybeJson || "").trim();
  if (!t) return null;

  // If it's JSONP, try to unwrap: callbackName(...)
  const jsonp = t.match(/^[a-zA-Z0-9_$]+\(([\s\S]*)\)\s*;?\s*$/);
  const raw = jsonp ? jsonp[1] : t;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeFpItem(it) {
  // We don't know exact shape, so we map defensively.
  // Common fields we've seen in partner feeds: player_name/name, title/headline, url/link, timestamp/date, analysis/impact.
  const title =
    it?.headline ||
    it?.title ||
    it?.news ||
    it?.text ||
    it?.blurb ||
    "";

  const url = it?.url || it?.link || it?.story_url || it?.more_url || "";
  const dateRaw = it?.published || it?.date || it?.timestamp || it?.time || "";

  const publishedAt = dateRaw ? new Date(dateRaw).toISOString() : null;
  const publishedTs = publishedAt ? Date.parse(publishedAt) : 0;

  const description = stripHtml(it?.impact || it?.analysis || it?.description || it?.fantasy_impact || "");

  if (!title || !url) return null;

  return {
    id: sha1(`FantasyPros|${title}|${url}|${publishedAt || ""}`),
    source: "FantasyPros",
    title: stripHtml(title),
    url,
    publishedAt,
    publishedTs,
    description,
  };
}

function parseFantasyProsFromHtml(html) {
  // Best-effort extraction: grab blocks that look like: "Fantasy Impact:" and work backwards to find a headline.
  // This is intentionally conservative and may return fewer items if structure changes.
  const out = [];

  // Try to find anchors that point to /news/... or /nfl/news/...
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]{12,200})<\/a>/gi;
  for (const m of html.matchAll(linkRe)) {
    let href = m[1] || "";
    const text = stripHtml(m[2] || "");
    if (!text) continue;

    // ignore navigation
    if (text.includes("Rankings") || text.includes("Stats") || text.includes("More News")) continue;

    if (href.startsWith("/")) href = `https://www.fantasypros.com${href}`;

    // Keep only plausible news/story links
    if (!href.includes("fantasypros.com")) continue;
    if (!href.includes("/nfl/")) continue;

    out.push({
      id: sha1(`FantasyPros|${text}|${href}`),
      source: "FantasyPros",
      title: text,
      url: href,
      publishedAt: null,
      publishedTs: 0,
      description: "",
    });

    if (out.length >= 40) break;
  }

  // Dedupe by url
  const seen = new Set();
  return out.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

async function main() {
  const items = [];
  const warnings = [];

  // ESPN RSS
  try {
    const xml = await fetchText(ESPN_NFL_RSS);
    items.push(...parseRss(xml, "ESPN"));
  } catch (e) {
    warnings.push(`ESPN RSS failed: ${e.message || e}`);
  }

  // FantasyPros
  try {
    const txt = await fetchText(FP_PARTNER_JSON, { timeoutMs: 20000 });
    const json = safeJsonParse(txt);

    if (json) {
      const arr =
        Array.isArray(json) ? json :
        Array.isArray(json?.news) ? json.news :
        Array.isArray(json?.items) ? json.items :
        Array.isArray(json?.data) ? json.data :
        null;

      if (arr && arr.length) {
        for (const it of arr) {
          const mapped = normalizeFpItem(it);
          if (mapped) items.push(mapped);
        }
      } else {
        warnings.push("FantasyPros partner JSON parsed but no array field found (news/items/data). Falling back to HTML.");
        const html = await fetchText(FP_PUBLIC_PAGE, { timeoutMs: 20000 });
        items.push(...parseFantasyProsFromHtml(html));
      }
    } else {
      warnings.push("FantasyPros partner endpoint didn't return JSON. Falling back to HTML.");
      const html = await fetchText(FP_PUBLIC_PAGE, { timeoutMs: 20000 });
      items.push(...parseFantasyProsFromHtml(html));
    }
  } catch (e) {
    warnings.push(`FantasyPros fetch failed: ${e.message || e}`);
  }

  // Sort + cap
  items.sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0));
  const capped = items.slice(0, 120);

  const out = {
    generatedAt: new Date().toISOString(),
    items: capped,
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), "utf-8");

  if (warnings.length) {
    for (const w of warnings) console.warn(`⚠️ ${w}`);
  }
  console.log(`✅ Wrote ${OUT_PATH} (items=${capped.length})`);
}

main().catch((e) => {
  console.error("update-news.mjs failed:", e);
  process.exitCode = 0; // don't fail the build
});
