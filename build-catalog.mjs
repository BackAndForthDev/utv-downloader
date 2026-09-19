// Builds the website's data (index.html reads it; the TV can't read u-tv.ru itself):
//   catalog.json  every show, season and episode: picture, length, one-line summary,
//                 best-quality stream, air date, the site's "Новые выпуски", related-show links
//   descs.json    full episode descriptions (for "Find a name")
// Run:  node build-catalog.mjs            (GitHub runs it every 3 hours, see .github/workflows)
//       node build-catalog.mjs --fresh    (ignore the existing files and look at everything again)
// Later runs reuse what's known, so they only open new episodes (and ones that were locked).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  ORIGIN, showUrl, loadAllShows, parseShowPage, parseEpisodePage, parseEpisodeDetails,
  parseLatestEpisodes, resolveMasterPlaylist,
} from './utv.js';
import { parseMaster, pickBest } from './hls.js';
import { matchEpisodes } from './match.js';

const CATALOG = new URL('./catalog.json', import.meta.url);
const DESCS = new URL('./descs.json', import.meta.url);
const CDN = 'https://cdn.media1.ru/videos/';
const AT_ONCE = 6;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// ---------- fetch with cookies and retries ----------

const jar = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('User-Agent', UA);
  for (let attempt = 1; ; attempt++) {
    if (jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    try {
      const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30000) });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(2000 * attempt); continue; }
      return res;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(1500 * attempt);
    }
  }
}

const net = {
  async text(url) {
    const r = await request(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.text();
  },
};

async function pool(items, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: AT_ONCE }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// Same one-liner the extension shows under an episode title.
function firstSentence(text) {
  const t = String(text).trim();
  const m = t.match(/^(.{20,220}?[.!?…])(\s|$)/);
  return m ? m[1] : t.slice(0, 180);
}

const baseTitle = (t) => String(t).split(/\s+[-–—]\s+/)[0].trim().toLowerCase();

// ---------- what we had last time ----------

const fresh = process.argv.includes('--fresh');
const prev = !fresh && existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf8')) : null;
const descs = prev && existsSync(DESCS) ? JSON.parse(readFileSync(DESCS, 'utf8')) : {};
const known = new Map(); // episode id -> last catalog entry
if (prev) for (const d of Object.values(prev.details)) for (const s of d.seasons) for (const e of s.eps) known.set(e.id, e);
const started = Date.now();

// ---------- 1. the show list ----------

const { shows: list, complete } = await loadAllShows(request);
if (prev) for (const s of prev.shows) if (!list.some((x) => x.slug === s.slug)) list.push({ slug: s.slug, name: s.name, image: s.image });
console.log(`${list.length} shows${complete ? '' : ' (the site list was cut short; kept the known ones)'}`);

// ---------- 2. seasons and episodes of each show ----------

const parsed = new Map(); // list slug -> parsed show page
await pool(list, async (s) => {
  try {
    parsed.set(s.slug, parseShowPage(await net.text(showUrl(s.slug)), s.slug));
  } catch (e) {
    console.warn(`  ${s.slug}: ${e.message}`);
  }
});

// ---------- 3. best stream, date and description of each episode ----------

const shows = [...new Map([...parsed.values()].map((sh) => [sh.slug, sh])).values()]; // aliases share a page
const allEps = shows.flatMap((sh) => sh.seasons.flatMap((s) => s.episodes));
const todo = [];
for (const ep of allEps) {
  const old = known.get(ep.id);
  if (old && old.s && descs[ep.id] !== undefined) Object.assign(ep, { s: old.s, w: old.w, h: old.h, date: old.date });
  else todo.push(ep); // new, locked last time, or not readable last time
}
console.log(`${allEps.length} episodes, opening ${todo.length}`);
let done = 0;
await pool(todo, async (ep) => {
  const old = known.get(ep.id);
  try {
    const html = await net.text(ep.url);
    const d = parseEpisodeDetails(html);
    descs[ep.id] = d.description;
    ep.date = d.date || (old && old.date) || null;
    const page = parseEpisodePage(html);
    if (page.blocked) { ep.lock = 1; return; }
    if (page.error) return;
    const master = await resolveMasterPlaylist(page.playerUrl, net);
    const best = pickBest(parseMaster(master.text, master.url).variants);
    ep.s = best.url.startsWith(CDN) ? best.url.slice(CDN.length) : best.url;
    ep.w = best.width || 0;
    ep.h = best.height || 0;
  } catch (e) {
    if (old) Object.assign(ep, { s: old.s, w: old.w, h: old.h, date: old.date, lock: old.lock });
    if (!old || !old.s) console.warn(`  ${ep.url}: ${e.message}`);
  } finally {
    if (++done % 200 === 0) console.log(`  ${done}/${todo.length}`);
  }
});

// ---------- 4. related shows (Чадо из ада ↔ Предки): spin-off episode -> original episode ----------

const links = {};
const families = new Map();
for (const s of list) {
  const b = baseTitle(s.name);
  if (!families.has(b)) families.set(b, []);
  families.get(b).push(s);
}
for (const [base, members] of families) {
  const originalMeta = members.find((s) => s.name.trim().toLowerCase() === base);
  if (members.length < 2 || !originalMeta) continue;
  const original = parsed.get(originalMeta.slug);
  const spinoffs = members.map((m) => parsed.get(m.slug)).filter((sh) => sh && sh !== original && sh.seasons.length);
  if (!original || !original.seasons.some((s) => s.num != null) || !spinoffs.length) continue;
  const withText = (e) => ({ id: e.id, description: descs[e.id] || '' });
  const origEps = original.seasons.filter((s) => s.num != null).flatMap((s) => s.episodes);
  const spinEps = spinoffs.flatMap((sh) => sh.seasons.flatMap((s) => s.episodes));
  for (const [id, found] of matchEpisodes(origEps.map(withText), spinEps.map(withText))) {
    links[id] = found.map((l) => (l.confidence === 'high' ? [l.originalId] : [l.originalId, 1]));
  }
}

// ---------- 5. the site's "Новые выпуски" ----------

let latest = prev ? prev.latest : [];
try {
  const items = parseLatestEpisodes(await net.text(`${ORIGIN}/`));
  if (items.length) latest = items.map(({ url, ...rest }) => rest);
} catch (e) {
  console.warn(`  latest episodes: ${e.message}`);
}

// ---------- write ----------

const details = {};
for (const sh of shows) {
  details[sh.slug] = {
    title: sh.title,
    image: sh.image,
    seasons: sh.seasons.map((s) => ({
      label: s.label,
      num: s.num,
      eps: s.episodes.map((e) => {
        const out = { id: e.id, label: e.label };
        if (e.code) out.code = e.code;
        if (e.minutes) out.min = e.minutes;
        if (e.image) out.img = e.image;
        if (e.date) out.date = e.date;
        if (descs[e.id]) out.d = firstSentence(descs[e.id]);
        if (e.s) Object.assign(out, { s: e.s, w: e.w, h: e.h });
        else if (e.lock) out.lock = 1;
        return out;
      }),
    })),
  };
}
// Shows whose page couldn't be read this time keep their last known episodes.
const prevKey = (slug) => {
  const p = prev && prev.shows.find((x) => x.slug === slug);
  return (p && p.real) || slug;
};
if (prev) for (const s of list) if (!parsed.has(s.slug) && prev.details[prevKey(s.slug)]) details[prevKey(s.slug)] = prev.details[prevKey(s.slug)];

const catalog = {
  generatedAt: null,
  shows: list.map((s) => {
    const sh = parsed.get(s.slug);
    const real = sh ? sh.slug : prevKey(s.slug);
    const d = details[real];
    const out = { slug: s.slug, name: s.name, image: s.image };
    if (d) out.count = d.seasons.reduce((n, x) => n + x.eps.length, 0);
    else if (sh) out.count = 0;
    if (real !== s.slug) out.real = real; // e.g. beremenna-v-16 now lives at mama-v-16
    return out;
  }),
  latest,
  links,
  details,
};

// Keep the old date when nothing changed, so a scheduled run only commits real news —
// but stamp it at least every 20 days, because GitHub turns off schedules in quiet repositories.
const same = prev && JSON.stringify({ ...catalog, generatedAt: null }) === JSON.stringify({ ...prev, generatedAt: null });
const age = prev ? Date.now() - new Date(prev.generatedAt).getTime() : Infinity;
catalog.generatedAt = same && age < 20 * 864e5 ? prev.generatedAt : new Date().toISOString();

const playable = (c) => Object.values(c.details).reduce((n, d) => n + d.seasons.reduce((m, s) => m + s.eps.filter((e) => e.s).length, 0), 0);
const now = playable(catalog);
if (prev && now < playable(prev) * 0.5) {
  // u-tv.ru was down or blocked us: keep the old files rather than publish an empty site.
  console.error(`Only ${now} playable episodes (was ${playable(prev)}); not saving.`);
  process.exit(1);
}
const keep = new Set(allEps.map((e) => e.id));
writeFileSync(DESCS, JSON.stringify(Object.fromEntries(Object.entries(descs).filter(([id, t]) => keep.has(id) && t))));
writeFileSync(CATALOG, JSON.stringify(catalog));
console.log(`catalog.json: ${list.length} shows, ${allEps.length} episodes (${now} playable, ${allEps.filter((e) => e.lock).length} region-locked), `
  + `${Object.keys(links).length} linked, ${(JSON.stringify(catalog).length / 1024).toFixed(0)} KB, ${Math.round((Date.now() - started) / 1000)}s`);
