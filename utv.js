// Everything specific to u-tv.ru: URLs, page parsing, stream lookup, file names.
// Regex-based on purpose so the exact same code is exercised by the Node tests.

export const ORIGIN = 'https://www.u-tv.ru';

export const showUrl = (slug) => `${ORIGIN}/shows/${slug}/`;

export function slugFromInput(input) {
  const s = String(input || '').trim();
  const m = s.match(/u-tv\.ru\/shows\/([a-z0-9-]+)/i);
  if (m) return m[1].toLowerCase();
  if (/^[a-z0-9-]+$/i.test(s)) return s.toLowerCase();
  return null;
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

export const cleanText = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

// Picks an image URL out of a <picture>: the <img src> when `preferImg`, else the first srcset entry.
function pictureUrl(html, preferImg) {
  const img = html.match(/<img\b[^>]*\bsrc="(https:\/\/img\.u-tv\.ru\/[^"]+)"/i);
  const src = html.match(/\bsrcset="(https:\/\/img\.u-tv\.ru\/[^"\s,]+)/i);
  const pick = preferImg ? (img || src) : (src || img);
  return pick ? decodeEntities(pick[1]) : null;
}

// ---------- show list (/shows/ page and its "load more" pages) ----------

export function parseShowList(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*class="[^"]*\bprojects__item\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = attr(m[0], 'href') || '';
    const sm = href.match(/\/shows\/([a-z0-9-]+)\/?$/i);
    if (!sm) continue;
    const slug = sm[1].toLowerCase();
    if (seen.has(slug)) continue;
    const nm = m[1].match(/projects__name[^>]*>([\s\S]*?)<\/div>/i);
    seen.add(slug);
    out.push({ slug, name: nm ? cleanText(nm[1]) : slug, image: pictureUrl(m[1], false) });
  }
  return out;
}

export function parseCsrf(html) {
  const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  return m ? m[1] : null;
}

// fetchFn is a standard fetch(url, init) that keeps cookies between calls
// (the browser does this itself; the Node tests pass a small cookie jar).
export async function loadAllShows(fetchFn, { maxPages = 30 } = {}) {
  const res = await fetchFn(`${ORIGIN}/shows/`, { credentials: 'include' });
  if (!res.ok) throw new Error(`u-tv.ru returned ${res.status}`);
  const html = await res.text();
  const shows = parseShowList(html);
  const token = parseCsrf(html);
  let complete = !/id="allProjects__btn"/.test(html);
  let page = 1;
  try {
    for (let i = 0; token && page && !complete && i < maxPages; i++) {
      const r = await fetchFn(`${ORIGIN}/projects/loading/`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRF-TOKEN': token,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ tab: 'all', page: String(page), sort: 'new', slug: 'shows' }).toString(),
      });
      if (!r.ok) break;
      const data = await r.json();
      for (const s of parseShowList(data.html || '')) if (!shows.some((x) => x.slug === s.slug)) shows.push(s);
      if (data.btnNextLoad) page = data.btnNumberPage; else complete = true;
    }
  } catch {
    // Extra pages are a bonus; the first page plus the link box still work.
  }
  return { shows, complete };
}

// ---------- show page: seasons and episodes ----------

function parseMinutes(s) {
  if (!s) return null;
  const h = s.match(/(\d+)\s*ч/);
  const m = s.match(/(\d+)\s*мин/);
  if (!h && !m) return null;
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}

export function parseShowPage(html, slug) {
  const h1 = html.match(/<h1\b[^>]*class="[^"]*\bproject__title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  let title = h1 ? cleanText(h1[1]) : '';
  if (!title) {
    const t = html.match(/<title>([\s\S]*?)<\/title>/i);
    title = t ? cleanText(t[1]).replace(/\s*[-|]\s*Телеканал «Ю».*$/i, '').split(' | ')[0].trim() : slug;
  }

  const start = html.indexOf('seasonTabs');
  const body = start === -1 ? '' : html.slice(start);

  // Old slugs redirect (beremenna-v-16 -> mama-v-16), so the episode links can
  // carry a different slug than the one we asked for. Trust the page.
  const linkSlugs = [...body.matchAll(/swiperGroup__slide\b[^>]*href="[^"]*\/shows\/([a-z0-9-]+)\/episodes\/\d+/gi)].map((x) => x[1].toLowerCase());
  if (linkSlugs.length && !linkSlugs.includes(slug)) {
    const counts = new Map();
    for (const s of linkSlugs) counts.set(s, (counts.get(s) || 0) + 1);
    slug = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }

  const parts = body.split(/data-season="/);
  const seasons = [];
  const seen = new Set();
  for (let p = 1; p < parts.length; p++) {
    const chunk = parts[p];
    const rawLabel = decodeEntities(chunk.slice(0, chunk.indexOf('"'))).trim();
    const numMatch = rawLabel.match(/^(\d+)\s*сезон/i);
    const season = {
      key: `s${p}`,
      num: numMatch ? +numMatch[1] : null,
      label: numMatch ? rawLabel : rawLabel.replace(/\s*сезон\s*$/i, '') || rawLabel,
      episodes: [],
    };
    const aRe = /<a\b[^>]*class="[^"]*\bswiperGroup__slide\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = aRe.exec(chunk))) {
      const href = attr(m[0], 'href') || '';
      const em = href.match(/\/shows\/([a-z0-9-]+)\/episodes\/(\d+)/i);
      if (!em || (slug && em[1].toLowerCase() !== slug)) continue;
      const id = em[2];
      if (seen.has(id)) continue;
      seen.add(id);
      const nameM = m[1].match(/swiperGroup__name[^>]*>([\s\S]*?)<\/div>/i);
      const timeM = m[1].match(/timeVideo[^>]*>([\s\S]*?)<\/div>/i);
      const label = nameM ? cleanText(nameM[1]) : `#${id}`;
      const se = label.match(/(\d+)\s*сезон\s*(\d+)\s*серия/i);
      const eOnly = !se && label.match(/(\d+)\s*серия/i);
      season.episodes.push({
        id,
        url: new URL(href, ORIGIN).href,
        image: pictureUrl(m[1], true),
        label,
        minutes: parseMinutes(timeM ? cleanText(timeM[1]) : ''),
        // Only a numbered tab makes a real "SxxEyy". Special tabs (эксклюзив, анонс…)
        // can hold clips labelled "2 сезон 1 серия" that are not that episode.
        season: season.num,
        labelSeason: se ? +se[1] : null,
        episode: se ? +se[2] : eOnly ? +eOnly[1] : null,
      });
    }
    if (season.episodes.length) {
      if (season.num != null && season.episodes.every((e) => e.episode != null)) {
        season.episodes.sort((a, b) => a.episode - b.episode);
      }
      seasons.push(season);
    }
  }
  const poster = html.match(/https:\/\/img\.u-tv\.ru\/u\/storage\/images\/tv_programs\/normal\/[^"\s,]+@200x172[^"\s,]*/i)
    || html.match(/https:\/\/img\.u-tv\.ru\/u\/storage\/images\/tv_programs\/normal\/[^"\s,]+/i);
  const show = { slug, title, image: poster ? decodeEntities(poster[0]) : null, seasons };
  assignFileNames(show);
  return show;
}

// ---------- episode page -> player -> master playlist ----------

export function parseEpisodePage(html) {
  const tag = html.match(/<iframe\b[^>]*\bid\s*=\s*"gplayer"[^>]*>/i);
  if (tag) {
    const src = attr(tag[0], 'src');
    if (src) return { playerUrl: new URL(src, ORIGIN).href };
  }
  if (/\/static\/img\/region\.webp/i.test(html)) return { blocked: true };
  return { error: 'No video player on this episode page' };
}

// The home page's "Новые выпуски" (latest episodes) strip.
export function parseLatestEpisodes(html) {
  const sections = String(html).split(/<section\b/i);
  const section = sections.find((s) => /default__title[^>]*>\s*Новые выпуски/i.test(s));
  if (!section) return [];
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*class="[^"]*\bswiperGroup__slide\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(section))) {
    const href = attr(m[0], 'href') || '';
    const em = href.match(/\/shows\/([a-z0-9-]+)\/episodes\/(\d+)/i);
    if (!em || seen.has(em[2])) continue;
    seen.add(em[2]);
    const name = m[1].match(/swiperGroup__name[^>]*>([\s\S]*?)<\/div>/i);
    const label = m[1].match(/class="season[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const time = m[1].match(/timeVideo[^>]*>([\s\S]*?)<\/div>/i);
    const text = label ? cleanText(label[1]) : '';
    const se = text.match(/(\d+)\s*сезон\s*(\d+)\s*серия/i);
    out.push({
      slug: em[1].toLowerCase(),
      id: em[2],
      url: new URL(href, ORIGIN).href,
      showName: name ? cleanText(name[1]) : em[1],
      label: text,
      code: se ? `S${se[1].padStart(2, '0')}E${se[2].padStart(2, '0')}` : null,
      minutes: parseMinutes(time ? cleanText(time[1]) : ''),
      image: pictureUrl(m[1], true),
    });
  }
  return out;
}

// "О серии" text and air date of an episode page (these name the people in the episode).
export function parseEpisodeDetails(html) {
  const d = html.match(/class="project__info-descr"[^>]*>([\s\S]*?)<\/div>/i);
  const date = html.match(/class="project__control-date"[^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})/i);
  return {
    description: d ? cleanText(d[1]) : '',
    date: date ? `${date[3]}-${date[2]}-${date[1]}` : null,
  };
}

export function findM3u8InHtml(html) {
  const unescaped = String(html).replace(/\\\//g, '/');
  const src = unescaped.match(/"source"\s*:\s*"(https?:[^"]+?\.m3u8[^"]*)"/i);
  if (src) return decodeEntities(src[1]);
  const any = unescaped.match(/https?:\/\/[^"'\s<>]+?\.m3u8[^"'\s<>]*/i);
  return any ? decodeEntities(any[0]) : null;
}

// net.text(url, signal) -> Promise<string>
export async function resolveMasterPlaylist(playerUrl, net, signal) {
  const u = new URL(playerUrl);
  const m = u.pathname.match(/^\/videos\/([^/]+)\/?$/);
  const tried = new Set();
  let guessErr = null;
  if (m) {
    const guess = `${u.origin}/videos/${m[1]}/master.m3u8`;
    tried.add(guess);
    try {
      const text = await net.text(guess, signal);
      if (text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')) return { url: guess, text };
      guessErr = new Error('The video stream could not be read');
    } catch (e) {
      if (signal && signal.aborted) throw e;
      guessErr = e;
    }
  }
  // The player page normally points at the same master.m3u8; it's only a fallback.
  // If it can't help, report the original failure (network, 403…) rather than a vague one.
  let html;
  try {
    html = await net.text(playerUrl, signal);
  } catch (e) {
    throw guessErr || e;
  }
  const found = findM3u8InHtml(html);
  if (!found || tried.has(found)) throw guessErr || new Error('Could not find the video stream in the player');
  const text = await net.text(found, signal);
  if (!text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')) throw new Error('The video stream could not be read');
  return { url: found, text };
}

// ---------- file names (valid on Windows, macOS and Linux) ----------

const RESERVED = /^(con|prn|aux|nul|clock\$|com[0-9]|lpt[0-9])(\..*)?$/i;

// Strict enough for Windows, and for chrome.downloads, which also refuses
// invisible format characters (soft hyphen, zero-width, bidi marks) and a
// leading/trailing "~", and rewrites "%".
export function sanitizeName(s, max = 100) {
  let t = String(s).normalize('NFC')
    .replace(/[<>:"/\\|?*%\p{Cc}\p{Cf}﷐-﷯]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ~]+|[. ~]+$/g, '');
  if (t.length > max) t = t.slice(0, max).replace(/[. ]+$/g, '');
  if (RESERVED.test(t)) t = `_${t}`;
  return t || '_';
}

function stripShowPrefix(label, title) {
  const l = label.trim();
  const low = l.toLowerCase();
  const t = title.trim().toLowerCase();
  if (t && low.startsWith(t)) {
    const rest = l.slice(t.length).replace(/^\s*[|:—–-]\s*/, '').trim();
    if (rest) return rest;
  }
  return l;
}

function assignFileNames(show) {
  const title = sanitizeName(show.title, 60);
  show.folder = title;
  const used = new Set();
  // Numbered seasons first, so the plain "Show - SxxEyy" names always go to real episodes.
  const ordered = [...show.seasons.filter((s) => s.num != null), ...show.seasons.filter((s) => s.num == null)];
  for (const season of ordered) {
    const maxEp = Math.max(0, ...season.episodes.map((e) => e.episode || 0));
    const width = Math.max(2, String(maxEp).length);
    for (const ep of season.episodes) {
      const epNum = ep.episode != null ? `E${String(ep.episode).padStart(width, '0')}` : null;
      let base;
      if (season.num != null && epNum) {
        ep.code = `S${String(season.num).padStart(2, '0')}${epNum}`;
        base = `${title} - ${ep.code}`;
      } else if (epNum) {
        ep.code = ep.labelSeason != null ? `S${String(ep.labelSeason).padStart(2, '0')}${epNum}` : epNum;
        base = `${title} - ${sanitizeName(season.label, 30)} ${ep.code}`;
      } else {
        ep.code = null;
        base = `${title} - ${sanitizeName(season.label, 30)} - ${sanitizeName(stripShowPrefix(ep.label, show.title), 70)}`;
      }
      if (used.has(base.toLowerCase())) base = `${base} [${ep.id}]`;
      used.add(base.toLowerCase());
      ep.baseName = base;
    }
  }
}
