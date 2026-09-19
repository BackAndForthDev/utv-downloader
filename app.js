import {
  ORIGIN, showUrl, slugFromInput, loadAllShows, parseShowPage, parseEpisodePage, parseEpisodeDetails, parseLatestEpisodes,
  resolveMasterPlaylist, sanitizeName,
} from './utv.js';
import { parseMaster, pickBest, qualityLabel, parseMedia, isTransportStream, tsStreams } from './hls.js';
import { downloadHls, withRetry } from './download.js';
import { matchEpisodes, nameStems, stem } from './match.js';
import { TsToMp4 } from './mp4.js';
import { net } from './net.js';

const ROOT_FOLDER = 'U-TV';
const INFO_CONCURRENCY = 4;
const ACTIVE = new Set(['queued', 'preparing', 'downloading', 'converting', 'saving']);

const $ = (id) => document.getElementById(id);

const state = {
  shows: null,            // [{ slug, name }]
  showsComplete: true,
  show: null,             // parsed show page
  open: new Set(),        // expanded season keys
  selected: new Set(),    // episode ids
  info: new Map(),        // episode id -> { status, variant, quality, media, seconds, error }
  saved: new Set(),       // episode ids already in the Downloads folder
  jobs: [],
  parallel: 2,            // episodes downloading at the same time
  favorites: new Set(),   // show slugs pinned to the top of the show list
  format: 'mp4',          // 'mp4' (repackaged, same quality) or 'ts' (original stream) for new downloads
  defaultFormat: 'mp4',
};

// DOM nodes of the current show, updated in place so clicks are never lost to a re-render.
const view = { seasons: new Map(), eps: new Map() };
const jobViews = new Map();

// ---------- small helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

// Images fade in once loaded; until then their box shows a soft shimmer (see .img-box in app.css).
function thumb(src, alt) {
  const img = h('img', { src, alt, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  img.addEventListener('error', () => { img.hidden = true; }, { once: true });
  return img;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function fmtBytes(n) {
  if (!(n > 0)) return '0 MB';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '…';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function friendlyError(e) {
  const msg = (e && e.message) || String(e);
  if (e && e.name === 'TimeoutError') return 'The connection stalled — press Retry';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Network error — check your connection and press Retry';
  if (/HTTP 40[13]|HTTP 451/.test(msg)) return `${msg} — the server refused (region-locked?)`;
  if (/QuotaExceeded|not enough space|disk/i.test(msg)) return 'Not enough free disk space';
  return msg;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function setView(name, text) {
  for (const v of ['picker', 'show', 'loading', 'error']) $(`${v}View`).hidden = v !== name;
  if (name === 'loading') $('loadingText').textContent = text || 'Loading…';
  $('bar').hidden = name !== 'show';
}

let retryAction = null;
function showError(msg, retry) {
  $('errorText').textContent = msg;
  retryAction = retry;
  $('retryBtn').hidden = !retry;
  setView('error');
}

// ---------- show picker ----------

let showLoadToken = 0;

async function openPicker() {
  const token = ++showLoadToken;
  clearShow();
  history.replaceState(null, '', location.pathname);
  updateTitle();
  if (!state.shows) {
    setView('loading', 'Loading shows…');
    try {
      const r = await loadAllShows((url, init) => fetch(url, init));
      state.shows = r.shows;
      state.showsComplete = r.complete;
    } catch (e) {
      if (token === showLoadToken) showError(`Couldn't load the show list: ${friendlyError(e)}`, openPicker);
      return;
    }
    if (token !== showLoadToken) return;
  }
  setView('picker');
  renderShowList();
  $('searchInput').focus();
  countEpisodes();
}

function renderShowList() {
  const raw = $('searchInput').value.trim();
  const q = raw.toLowerCase();
  const pasted = /u-tv\.ru\/shows\//i.test(raw) ? slugFromInput(raw) : null;
  const shows = state.shows || [];
  const items = pasted
    ? [{ slug: pasted, name: `Open “${pasted}”` }]
    : shows.filter((s) => !q || s.name.toLowerCase().includes(q) || s.slug.includes(q));
  // Favourites first, shows with no videos last (once we know about them).
  if (!pasted) items.sort((a, b) => (state.favorites.has(b.slug) - state.favorites.has(a.slug)) || ((a.count === 0) - (b.count === 0)));
  const card = (s) => {
    const count = h('span', { class: 'show-count' });
    const main = h('button', { type: 'button', class: 'show-card', onclick: () => loadShow(s.slug) },
      h('span', { class: 'poster' }, s.image ? thumb(s.image, '') : null),
      h('span', { class: 'show-name' }, s.name),
      count);
    const fav = state.favorites.has(s.slug);
    const star = h('button', {
      type: 'button', class: `fav-star${fav ? ' on' : ''}`, title: fav ? 'Remove from favourites' : 'Add to favourites',
      'aria-label': fav ? `Remove ${s.name} from favourites` : `Add ${s.name} to favourites`,
      onclick: (e) => { e.stopPropagation(); toggleFavorite(s.slug); },
    }, fav ? '★' : '☆');
    showCardViews.set(s.slug, { card: main, count });
    updateShowCard(s);
    return h('li', { class: 'show-item' }, main, star);
  };
  const favs = pasted ? [] : items.filter((s) => state.favorites.has(s.slug));
  const rest = items.filter((s) => !favs.includes(s));
  const groups = [];
  if (favs.length) {
    groups.push(h('li', { class: 'group-head' }, '★ Favourites'), ...favs.map(card));
    if (rest.length) groups.push(h('li', { class: 'group-head' }, q ? 'Other matches' : 'All shows'));
  }
  groups.push(...rest.map(card));
  $('showList').replaceChildren(...groups);
  let note = `${shows.length} shows`;
  if (!state.showsComplete) note += ' (couldn’t load the full list — paste any u-tv.ru show link above to open it)';
  if (q && !items.length) note = 'No show matches. You can paste a u-tv.ru show link.';
  $('pickerNote').textContent = note;
}

// ---------- what's new ----------
// Two feeds on the right: the newest episodes of your starred shows (the default once you have
// favourites) and the site-wide "Новые выпуски" strip from the u-tv.ru home page.
// "NEW" = released since you last opened that show (counting starts when you star it).

const news = { tab: null, all: [], fav: [], loading: false, again: false, againFresh: false, seen: {}, newBySlug: {}, dates: {}, saved: new Map() };
const showCache = new Map(); // slug -> { show, at }
const SHOW_TTL = 20 * 60e3;

function cacheShow(show) {
  showCache.set(show.slug, { show, at: Date.now() });
}

async function getShow(slug, fresh = false) {
  const c = showCache.get(slug);
  if (!fresh && c && Date.now() - c.at < SHOW_TTL) return c.show;
  const show = parseShowPage(await net.text(showUrl(slug)), slug);
  cacheShow(show);
  return show;
}

// Finds an episode, re-reading the show page once if our copy predates it.
async function findEpisode(slug, id) {
  let show = await getShow(slug);
  let ep = show.seasons.flatMap((s) => s.episodes).find((e) => e.id === id);
  if (!ep) {
    show = await getShow(slug, true);
    ep = show.seasons.flatMap((s) => s.episodes).find((e) => e.id === id);
  }
  return { show, ep };
}

const maxEpisodeId = (show) => Math.max(0, ...show.seasons.filter((s) => s.num != null).flatMap((s) => s.episodes.map((e) => Number(e.id))));
const isNew = (item) => state.favorites.has(item.slug) && news.seen[item.slug] !== undefined && Number(item.id) > news.seen[item.slug];
// Every new episode of every favourite, not just the ones listed (the list is capped, counts aren't).
const newIds = (slug) => (state.favorites.has(slug) && news.newBySlug[slug]) || [];
const totalNew = () => [...state.favorites].reduce((n, slug) => n + newIds(slug).length, 0);
const isSaved = (slug, id) => (news.saved.get(slug) || new Set()).has(id);

async function loadNewsState() {
  try {
    const r = await chrome.storage.local.get(['seen', 'epDates']);
    news.seen = (r && r.seen) || {};
    news.dates = (r && r.epDates) || {};
  } catch { /* start fresh */ }
}

function saveNewsState() {
  try {
    chrome.storage.local.set({ seen: news.seen, epDates: news.dates }).catch(() => {});
  } catch { /* kept for this session */ }
}

async function buildFavFeed(fresh) {
  const shows = [];
  const queue = [...state.favorites];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const slug = queue.shift();
      try { shows.push(await getShow(slug, fresh)); } catch { /* skip this one */ }
    }
  }));
  const items = [];
  const newBySlug = {};
  for (const show of shows) {
    const eps = show.seasons.filter((s) => s.num != null).flatMap((s) => s.episodes);
    if (!eps.length) continue;
    if (news.seen[show.slug] === undefined) news.seen[show.slug] = maxEpisodeId(show); // new = from now on
    const fresh = eps.filter((e) => Number(e.id) > news.seen[show.slug]);
    newBySlug[show.slug] = fresh.map((e) => e.id);
    // Every new episode, plus the 4 most recent for context.
    const shown = new Map([...fresh, ...[...eps].sort((a, b) => b.id - a.id).slice(0, 4)].map((e) => [e.id, e]));
    for (const ep of shown.values()) {
      items.push({ slug: show.slug, id: ep.id, showName: show.title, code: ep.code, label: ep.label, minutes: ep.minutes, image: ep.image });
    }
  }
  news.newBySlug = newBySlug;
  saveNewsState(); // keep new starting points even if the tab closes mid-refresh
  // Every NEW episode is always listed; the rest of the list (up to 16) is the most recent ones.
  const isNewItem = (i) => (newBySlug[i.slug] || []).includes(i.id);
  const newItems = items.filter(isNewItem);
  const others = items.filter((i) => !isNewItem(i)).sort((a, b) => b.id - a.id).slice(0, Math.max(0, 16 - newItems.length));
  return [...newItems, ...others].sort((a, b) => b.id - a.id);
}

let newsTimer = null;
async function refreshNews({ fresh = false } = {}) {
  // A refresh asked for while one runs (e.g. starring several shows quickly) runs right after it.
  if (news.loading) { news.again = true; news.againFresh = news.againFresh || fresh; return; }
  news.loading = true;
  renderNews();
  try {
    const [all, fav] = await Promise.all([
      net.text(`${ORIGIN}/`).then(parseLatestEpisodes).catch(() => null),
      buildFavFeed(fresh),
    ]);
    if (all) news.all = all;
    news.fav = fav;
    renderNews();
    // Extras that fill in afterwards: "✓ saved" marks and how long ago each episode came out.
    const slugs = new Set([...news.fav, ...news.all].map((i) => i.slug));
    await Promise.all([...slugs].map(async (slug) => {
      try { news.saved.set(slug, await savedIdsFor(await getShow(slug))); } catch { /* no marks */ }
    }));
    const undated = [...news.fav, ...news.all].filter((i) => !news.dates[i.id]);
    const seenIds = new Set();
    const queue = undated.filter((i) => !seenIds.has(i.id) && seenIds.add(i.id));
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const i = queue.shift();
        try {
          const html = await net.text(i.url || `${ORIGIN}/shows/${i.slug}/episodes/${i.id}/`);
          const d = parseEpisodeDetails(html);
          if (d.date) news.dates[i.id] = d.date;
          if (d.description && !descs.has(i.id)) descs.set(i.id, d.description);
        } catch { /* no date */ }
      }
    }));
    saveNewsState();
  } finally {
    news.loading = false;
    renderNews();
  }
  clearTimeout(newsTimer);
  newsTimer = setTimeout(refreshNews, 20 * 60e3);
  if (news.again) {
    const again = { fresh: news.againFresh };
    news.again = false;
    news.againFresh = false;
    setTimeout(() => refreshNews(again), 0);
  }
}

// Local calendar day as YYYY-MM-DD (toISOString would use the UTC day).
const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function relDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  const days = Math.round((Date.now() - d.getTime()) / 86400e3);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function renderNews() {
  const tab = news.tab || (state.favorites.size ? 'fav' : 'all');
  document.querySelectorAll('[data-news]').forEach((b) => {
    b.classList.toggle('on', b.dataset.news === tab);
    b.setAttribute('aria-selected', String(b.dataset.news === tab));
  });
  const favNew = totalNew();
  $('newsFavCount').hidden = !favNew;
  setText($('newsFavCount'), String(favNew));
  const items = tab === 'fav' ? news.fav : news.all;
  let note = '';
  if (tab === 'fav' && !state.favorites.size) note = 'Star (☆) the shows you follow and their new episodes show up here.';
  else if (news.loading && !items.length) note = 'Checking for new episodes…';
  else if (!items.length) note = tab === 'fav' ? 'No episodes in your favourites yet.' : "Couldn't load the latest episodes. Try ↻ Refresh.";
  $('newsNote').hidden = !note;
  setText($('newsNote'), note);
  $('newsSeen').hidden = !(tab === 'fav' && favNew);
  $('newsList').replaceChildren(...items.map(newsItem));
  updateNewsButtons();
  for (const slug of state.favorites) updateShowCard((state.shows || []).find((s) => s.slug === slug) || { slug });
  updateBadge();
}

// New episodes of favourites that aren't downloaded or downloading yet (uncapped).
function wantedNew() {
  const out = [];
  for (const slug of state.favorites) {
    for (const id of newIds(slug)) if (!isQueued(id) && !isSaved(slug, id)) out.push({ slug, id });
  }
  return out;
}

// One click for everything new in your favourites that you don't have yet.
async function downloadAllNew() {
  const wanted = wantedNew();
  let added = 0;
  for (const slug of new Set(wanted.map((i) => i.slug))) {
    try {
      const ids = new Set(wanted.filter((i) => i.slug === slug).map((i) => i.id));
      let show = await getShow(slug);
      let eps = show.seasons.flatMap((s) => s.episodes).filter((e) => ids.has(e.id));
      if (eps.length < ids.size) {
        show = await getShow(slug, true);
        eps = show.seasons.flatMap((s) => s.episodes).filter((e) => ids.has(e.id));
      }
      added += enqueue(eps.sort((a, b) => a.id - b.id), show);
    } catch { /* skip that show */ }
  }
  toast(added ? `Added ${added} new episode${added === 1 ? '' : 's'} to the download list` : 'Nothing new to download');
  renderNews();
}

// ⬇ buttons are updated in place (no re-render), so they follow the queue without losing focus.
const newsButtons = new Map(); // item id -> { button, item }
function updateNewsButtons() {
  for (const [id, { button, item }] of newsButtons) {
    if (!button.isConnected) { newsButtons.delete(id); continue; }
    const queued = isQueued(id);
    const saved = isSaved(item.slug, id);
    button.disabled = queued;
    setText(button, queued ? '…' : '⬇');
    button.title = queued ? 'Downloading' : saved ? 'Already downloaded (download again)' : `Download as ${state.format.toUpperCase()}`;
  }
  $('newsGetAll').hidden = !((news.tab || (state.favorites.size ? 'fav' : 'all')) === 'fav' && wantedNew().length);
}

function newsItem(item) {
  const saved = isSaved(item.slug, item.id);
  const sub = [item.code || item.label, item.minutes ? `${item.minutes} min` : '', relDate(news.dates[item.id])].filter(Boolean).join(' · ');
  const open = () => goTo(item.slug, item.id);
  const button = h('button', {
    type: 'button', class: 'news-dl',
    'aria-label': `Download ${item.showName} ${item.code || item.label}`,
    onclick: (e) => { e.stopPropagation(); downloadNewsItem(item); },
  }, '⬇');
  newsButtons.set(item.id, { button, item });
  return h('li', {
    class: 'news-item', role: 'button', tabindex: '0', title: `Open ${item.showName} ${item.code || item.label}`,
    onclick: open,
    // Only keys aimed at the row itself; Enter on the ⬇ button must not also open the show.
    onkeydown: (e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
  },
  h('span', { class: 'news-thumb' }, item.image ? thumb(item.image, '') : null, isNew(item) ? h('span', { class: 'new' }, 'NEW') : null,
    playButton(() => watchNewsItem(item), `Watch ${item.showName} ${item.code || item.label}`)),
  h('span', { class: 'news-text' },
    h('span', { class: 'news-show' }, item.showName),
    h('span', { class: 'news-sub' }, sub, saved ? h('span', { class: 'ok' }, ' · ✓ saved') : null)),
  button);
}

async function watchNewsItem(item) {
  try {
    const { show, ep } = await findEpisode(item.slug, item.id);
    if (!ep) throw new Error('episode not found on the show page');
    watchEpisode(ep, show);
  } catch (e) {
    toast(`Couldn't play that episode: ${friendlyError(e)}`);
  }
}

async function downloadNewsItem(item) {
  try {
    const { show, ep } = await findEpisode(item.slug, item.id);
    if (!ep) throw new Error('episode not found on the show page');
    const added = enqueue([ep], show);
    toast(added ? `Added ${show.title} ${ep.code || ep.label} to the download list` : 'That episode is already downloading');
    updateNewsButtons();
  } catch (e) {
    toast(`Couldn't start that download: ${friendlyError(e)}`);
  }
}

function markShowSeen(show) {
  if (news.seen[show.slug] === undefined && !state.favorites.has(show.slug)) return;
  const max = maxEpisodeId(show);
  if (max > (news.seen[show.slug] || 0) || newIds(show.slug).length) {
    news.seen[show.slug] = Math.max(max, news.seen[show.slug] || 0);
    news.newBySlug[show.slug] = [];
    saveNewsState();
    renderNews();
  }
}

function markAllSeen() {
  for (const slug of state.favorites) {
    const ids = newIds(slug).map(Number);
    if (ids.length) news.seen[slug] = Math.max(news.seen[slug] || 0, ...ids);
    news.newBySlug[slug] = [];
  }
  saveNewsState();
  renderNews();
}

// ---------- ▶ Watch (stream without downloading) ----------
// Chrome plays HLS natively. We point it straight at the best variant (fixed 1080p, no
// adaptive dips) over plain http, which streams in real time where the CDN's HTTP/3 route stalls.

const player = { ep: null, show: null, token: 0 };

async function watchEpisode(ep, show) {
  const token = ++player.token;
  player.ep = ep;
  player.show = show;
  const v = $('playerVideo');
  setText($('playerShow'), show.title);
  setText($('playerTitle'), ep.code ? `${ep.code} · ${ep.label}` : ep.label);
  setText($('playerNote'), 'Finding the best stream…');
  $('playerCast').hidden = true;
  if (!$('playerDlg').open) $('playerDlg').showModal();
  try {
    let info = state.info.get(ep.id);
    if (!info || info.status !== 'ok') {
      info = await resolveEpisode(ep);
      state.info.set(ep.id, info);
      onInfoChanged(ep, info);
    }
    if (token !== player.token) return;
    if (info.status === 'blocked') { setText($('playerNote'), 'This episode is region-locked for your connection.'); return; }
    const https = info.variant.url;
    const fast = https.replace(/^https:/i, 'http:');
    let triedHttps = false;
    v.onerror = () => {
      if (token !== player.token || triedHttps) return;
      triedHttps = true; // plain http blocked on this network: use the normal route
      v.src = https;
      v.play().catch(() => {});
    };
    v.src = fast;
    setText($('playerNote'), `${info.quality} · streaming, nothing is saved`);
    await v.play().catch(() => {});
    // Cast button only when Chrome sees a Cast device (Chromecast / Google TV) on the network.
    if (v.remote && v.remote.watchAvailability) {
      v.remote.cancelWatchAvailability().catch(() => {});
      v.remote.watchAvailability((available) => { if (token === player.token) $('playerCast').hidden = !available; })
        .catch(() => { $('playerCast').hidden = false; }); // can't tell: offer it, Chrome explains if there's nothing
    }
  } catch (e) {
    if (token === player.token) setText($('playerNote'), `Couldn't play this episode: ${friendlyError(e)}`);
  }
}

function closePlayer() {
  player.token++;
  const v = $('playerVideo');
  v.onerror = null;
  v.pause();
  v.removeAttribute('src');
  v.load(); // stops the stream
  if ($('playerDlg').open) $('playerDlg').close();
}

async function castPlayer() {
  const v = $('playerVideo');
  try {
    await v.remote.prompt();
  } catch (e) {
    toast(e && e.name === 'NotFoundError' ? 'No Cast-capable TV found on your network' : `Couldn't cast: ${friendlyError(e)}`);
  }
}

function playButton(onPlay, label) {
  return h('button', {
    type: 'button', class: 'play-btn', title: 'Watch now', 'aria-label': label,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); onPlay(); },
  }, h('span', null, '▶'));
}

// ---------- settings (⚙): format, episodes at once, theme, notifications ----------

const SETTINGS = { format: ['mp4', 'ts'], parallel: ['1', '2', '3'], theme: ['system', 'light', 'dark'], notify: ['on', 'off'] };
state.settings = { format: 'mp4', parallel: '2', theme: 'system', notify: 'on' };

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('theme', theme); } catch { /* theme.js falls back to the system */ }
}

function applySettings() {
  state.format = state.settings.format;
  state.parallel = Number(state.settings.parallel) || 2;
  applyTheme(state.settings.theme);
  document.querySelectorAll('[data-set]').forEach((b) => {
    const on = state.settings[b.dataset.set] === b.dataset.val;
    b.classList.toggle('on', on);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(on));
  });
  setText($('fmtHint'), `as ${state.format.toUpperCase()}`);
  setText($('formatHelp'), state.format === 'mp4'
    ? 'Plays everywhere: TVs, phones, Topaz and other editors. Same picture and sound as the original, no re-encoding.'
    : 'The original broadcast stream, byte for byte. Plays in VLC, PotPlayer, mpv and most TVs.');
}

async function loadSettings() {
  try {
    const r = await chrome.storage.local.get(['settings', 'defaultFormat']);
    const saved = (r && r.settings) || {};
    if (!saved.format && (r.defaultFormat === 'mp4' || r.defaultFormat === 'ts')) saved.format = r.defaultFormat;
    try { if (!saved.parallel && ['1', '2', '3'].includes(localStorage.getItem('parallel'))) saved.parallel = localStorage.getItem('parallel'); } catch { /* none */ }
    for (const [k, allowed] of Object.entries(SETTINGS)) if (allowed.includes(String(saved[k]))) state.settings[k] = String(saved[k]);
  } catch { /* defaults */ }
  applySettings();
}

async function setSetting(key, value) {
  if (!SETTINGS[key] || !SETTINGS[key].includes(value)) return;
  state.settings[key] = value;
  applySettings();
  if (key === 'parallel') runQueue();
  renderNews(); // the ⬇ buttons mention the format
  try { await chrome.storage.local.set({ settings: state.settings }); } catch { /* applies to this session */ }
}

// ---------- notifications and toolbar badge ----------

function notifyDone(job) {
  if (state.settings.notify !== 'on' || !document.hidden) return; // you're looking at the tab already
  try {
    chrome.notifications.create(`job-${job.key}-${job.downloadId}`, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: `Saved: ${job.show.title} ${job.ep.code || ''}`.trim(),
      message: `${fmtBytes(job.bytes)} · ${job.quality || ''} · ${/\.mp4$/i.test(job.filename || '') ? 'MP4' : 'TS'} — click to show the file`,
      priority: 0,
    });
  } catch { /* notifications unavailable */ }
}

// While something downloads the icon shows its progress; otherwise the number of NEW episodes.
let lastBadge = null;
function updateBadge() {
  const active = state.jobs.filter((j) => ACTIVE.has(j.status));
  let text = '';
  let color = '#e2185b';
  if (active.length) {
    const running = active.filter((j) => j.status === 'downloading' || j.status === 'converting');
    const pct = running.length ? Math.floor(running.reduce((s, j) => s + jobPercent(j), 0) / running.length) : 0;
    text = running.length ? `${pct}%` : '…';
    color = '#2563eb';
  } else {
    const favNew = totalNew();
    text = favNew ? String(favNew) : '';
  }
  const key = `${text}|${color}`;
  if (key === lastBadge) return;
  lastBadge = key;
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
    // Lets background.js put the NEW count back if this tab closes mid-download.
    chrome.storage.session.set({ newCount: totalNew() }).catch(() => {});
  } catch { /* no badge */ }
}

// ---------- history (past downloads, from Chrome's own download list) ----------

let historyItems = [];
async function loadHistory() {
  try {
    historyItems = await chrome.downloads.search({
      filenameRegex: `[\\\\/]${escapeRe(ROOT_FOLDER)}[\\\\/]`, state: 'complete', orderBy: ['-startTime'], limit: 300,
    });
  } catch { historyItems = []; }
  renderHistory();
}

function renderHistory() {
  const q = $('historyFilter').value.trim().toLowerCase();
  const rows = historyItems.map((it) => {
    const parts = it.filename.split(/[\\/]/);
    const file = parts.pop();
    const folder = parts.pop() || '';
    return { it, file, folder, name: file.replace(/\.[^.]+$/, '').replace(`${folder} - `, '') };
  }).filter((r) => !q || `${r.folder} ${r.name}`.toLowerCase().includes(q));
  setText($('historyNote'), !historyItems.length
    ? 'Nothing downloaded yet. Finished episodes show up here.'
    : q && !rows.length ? 'No download matches that.' : `${rows.length} download${rows.length === 1 ? '' : 's'}`);
  $('historyList').replaceChildren(...rows.slice(0, 150).map(({ it, file, folder, name }) => {
    const kind = /\.mp4$/i.test(file) ? 'mp4' : 'ts';
    const when = it.endTime || it.startTime;
    const listed = (state.shows || []).find((s) => sanitizeFolder(s.name) === folder);
    return h('li', { class: `history-item${it.exists === false ? ' gone' : ''}`, title: it.filename },
      h('span', { class: `history-kind ${kind}` }, kind.toUpperCase()),
      h('span', { class: 'history-text' },
        listed
          ? h('button', { type: 'button', class: 'link history-show', onclick: () => loadShow(listed.slug) }, folder)
          : h('span', { class: 'history-show' }, folder),
        h('span', { class: 'history-name' }, name),
        h('span', { class: 'history-meta' }, [when ? relDate(localIso(new Date(when))) : '', fmtBytes(it.fileSize || it.totalBytes),
          it.exists === false ? 'file deleted' : ''].filter(Boolean).join(' · '))),
      it.exists === false ? h('span') : h('span', { class: 'history-actions' },
        h('button', {
          type: 'button', class: 'link small', title: 'Open in your usual video player (QuickTime on a Mac has AirPlay; Films & TV on Windows has Cast to device)',
          onclick: () => { try { chrome.downloads.open(it.id); } catch (e) { toast(`Couldn't open it: ${friendlyError(e)}`); } },
        }, '▶ Play'),
        h('button', { type: 'button', class: 'link small', onclick: () => chrome.downloads.show(it.id) }, 'Show file')));
  }));
}

// Folder names are the sanitised show titles; compare the same way.
const sanitizeFolder = (title) => sanitizeName(title, 60);

function showDlTab(tab) {
  document.querySelectorAll('[data-dl]').forEach((b) => b.classList.toggle('on', b.dataset.dl === tab));
  $('dlNow').hidden = tab !== 'now';
  $('dlHistory').hidden = tab !== 'history';
  if (tab === 'history') loadHistory();
}

// ---------- favourites ----------

async function loadFavorites() {
  try {
    const r = await chrome.storage.local.get('favorites');
    for (const slug of (r && r.favorites) || []) state.favorites.add(slug);
  } catch { /* none saved */ }
}

async function toggleFavorite(slug) {
  if (state.favorites.has(slug)) {
    state.favorites.delete(slug);
    // Forget it right away; starring it again starts counting new episodes from then.
    news.fav = news.fav.filter((i) => i.slug !== slug);
    delete news.seen[slug];
    delete news.newBySlug[slug];
  } else {
    state.favorites.add(slug);
    const known = (showCache.get(slug) || {}).show || (state.show && state.show.slug === slug ? state.show : null);
    if (known && news.seen[slug] === undefined) news.seen[slug] = maxEpisodeId(known);
  }
  saveNewsState();
  if (!$('pickerView').hidden) renderShowList();
  updateShowStar();
  renderNews();
  try { await chrome.storage.local.set({ favorites: [...state.favorites] }); } catch { /* kept for this session */ }
  refreshNews();
}

function updateShowStar() {
  const btn = $('favBtn');
  if (!state.show) return;
  const on = state.favorites.has(state.show.slug);
  btn.classList.toggle('on', on);
  setText(btn, on ? '★ Favourite' : '☆ Add to favourites');
  btn.title = on ? 'Remove from favourites' : 'Show this at the top of the show list';
}

// Episode counts on the show cards, so empty archive pages don't look like real shows.
// Checked quietly in the background and remembered for a day.
const showCardViews = new Map();
let countsStarted = false;

function updateShowCard(s) {
  const v = showCardViews.get(s.slug);
  if (!v) return;
  v.card.classList.toggle('empty', s.count === 0);
  const fresh = newIds(s.slug).length;
  const base = s.count === undefined ? '' : s.count === 0 ? 'no videos' : `${s.count} episode${s.count === 1 ? '' : 's'}`;
  setText(v.count, fresh ? `${base}${base ? ' · ' : ''}${fresh} new` : base);
  v.count.classList.toggle('has-new', fresh > 0);
}

async function countEpisodes() {
  if (countsStarted || !state.shows) return;
  countsStarted = true;
  let cached = {};
  try { cached = (await chrome.storage.local.get('showCounts')).showCounts || {}; } catch { /* no cache */ }
  const fresh = cached.at && Date.now() - cached.at < 24 * 3600 * 1000 ? cached.counts || {} : {};
  for (const s of state.shows) if (fresh[s.slug] !== undefined) s.count = fresh[s.slug];
  if (Object.keys(fresh).length) renderShowList();
  const queue = state.shows.filter((s) => s.count === undefined);
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const show = parseShowPage(await net.text(showUrl(s.slug)), s.slug);
        s.count = show.seasons.reduce((n, x) => n + x.episodes.length, 0);
        updateShowCard(s);
      } catch { /* leave it unknown */ }
    }
  }));
  const counts = {};
  for (const s of state.shows) if (s.count !== undefined) counts[s.slug] = s.count;
  try { await chrome.storage.local.set({ showCounts: { at: Date.now(), counts } }); } catch { /* not cached */ }
}

// ---------- show page ----------

function latestSeason(show) {
  const numbered = show.seasons.filter((s) => s.num != null);
  if (!numbered.length) return show.seasons[show.seasons.length - 1] || null;
  return numbered.reduce((a, b) => (b.num > a.num ? b : a));
}

function clearShow() {
  state.show = null;
  state.selected.clear();
  state.open.clear();
  state.saved.clear();
  view.seasons.clear();
  view.eps.clear();
  dirtyEps.clear();
  $('seasons').replaceChildren();
}

async function loadShow(slug) {
  const token = ++showLoadToken;
  setView('loading', 'Loading episodes…');
  try {
    const html = await net.text(showUrl(slug));
    if (token !== showLoadToken) return;
    const show = parseShowPage(html, slug);
    if (!show.seasons.length) {
      showError(`“${show.title}” has no videos on u-tv.ru right now (it's an archive page).`, null);
      return;
    }
    clearShow();
    state.show = show;
    cacheShow(show);
    markShowSeen(show);
    pruneInfoQueue(show);
    $('searchInput').value = '';
    $('findInput').value = '';
    $('findResults').hidden = true;
    const latest = latestSeason(show);
    if (latest) state.open.add(latest.key);
    history.replaceState(null, '', `?show=${encodeURIComponent(show.slug)}`);
    updateTitle();
    renderShow();
    setView('show');
    if (latest) latest.episodes.forEach(requestInfo);
    refreshSaved();
    if (pendingFocus) {
      const id = pendingFocus;
      pendingFocus = null;
      focusEpisode(id);
    }
    setupFamily(show);
  } catch (e) {
    if (token === showLoadToken) showError(`Couldn't load this show: ${friendlyError(e)}`, () => loadShow(slug));
  }
}

function seasonOf(epId) {
  return state.show && state.show.seasons.find((s) => s.episodes.some((e) => e.id === epId));
}

function isPickable(ep) {
  const info = state.info.get(ep.id);
  return !(info && info.status === 'blocked');
}

function qClass(v) {
  if (!v) return '';
  if (v.height >= 1440) return 'top';
  if (v.height >= 1080) return 'good';
  return '';
}

function episodeSeconds(ep, info) {
  if (info && info.status === 'ok' && info.seconds) return info.seconds;
  return ep.minutes ? ep.minutes * 60 : 0;
}

function estimateBytes(ep, info) {
  if (!info || info.status !== 'ok' || !info.variant.bandwidth) return 0;
  return (info.variant.bandwidth * episodeSeconds(ep, info)) / 8;
}

function renderShow() {
  const show = state.show;
  $('showTitle').textContent = show.title;
  $('showLink').href = showUrl(show.slug);
  updateShowStar();
  const listed = (state.shows || []).find((s) => s.slug === show.slug);
  const poster = (listed && listed.image) || show.image;
  $('showPoster').replaceChildren(...(poster ? [thumb(poster, '')] : []));
  $('showPoster').hidden = !poster;
  view.seasons.clear();
  view.eps.clear();
  $('seasons').replaceChildren(...show.seasons.map(buildSeason));
  updateBar();
}

function buildSeason(season) {
  const cb = h('input', {
    type: 'checkbox',
    'aria-label': `Select all of ${season.label}`,
    onclick: (e) => { e.stopPropagation(); selectEpisodes(season.episodes, cb.checked); },
  });
  const saved = h('span', { class: 'muted small' });
  const sel = h('span', { class: 'small' });
  const best = h('span', { class: 'q' });
  const head = h('div', { class: 'season-head', onclick: () => toggleOpen(season) },
    cb,
    h('span', { class: 'name' }, season.label),
    h('span', { class: 'muted small' }, `${season.episodes.length} ep.`),
    h('span', { class: 'meta' }, saved, sel, best, h('span', { class: 'caret' }, '▸')));
  const root = h('div', { class: 'season' }, head);
  const v = { root, cb, saved, sel, best, list: null };
  view.seasons.set(season.key, v);
  if (state.open.has(season.key)) openList(season, v);
  updateSeasonHead(season);
  return root;
}

function openList(season, v) {
  v.list = h('ul', { class: 'episodes' }, season.episodes.map(buildEpisode));
  v.root.append(v.list);
  v.root.classList.add('open');
}

function closeList(season, v) {
  if (v.list) v.list.remove();
  v.list = null;
  v.root.classList.remove('open');
  for (const ep of season.episodes) view.eps.delete(ep.id);
}

function toggleOpen(season) {
  const v = view.seasons.get(season.key);
  if (!v) return;
  if (state.open.has(season.key)) {
    state.open.delete(season.key);
    closeList(season, v);
  } else {
    state.open.add(season.key);
    openList(season, v);
    season.episodes.forEach(requestInfo);
  }
}

function updateSeasonHead(season) {
  const v = view.seasons.get(season.key);
  if (!v) return;
  const pickable = season.episodes.filter(isPickable);
  const selCount = pickable.filter((e) => state.selected.has(e.id)).length;
  v.cb.checked = pickable.length > 0 && selCount === pickable.length;
  v.cb.indeterminate = selCount > 0 && selCount < pickable.length;
  v.cb.disabled = pickable.length === 0;
  const savedCount = season.episodes.filter((e) => state.saved.has(e.id)).length;
  setText(v.saved, savedCount ? `${savedCount} saved` : '');
  v.saved.hidden = !savedCount;
  setText(v.sel, selCount ? `${selCount} selected` : '');
  v.sel.hidden = !selCount;
  const best = season.episodes.map((e) => state.info.get(e.id)).filter((i) => i && i.status === 'ok')
    .reduce((a, i) => (!a || i.variant.height > a.variant.height ? i : a), null);
  v.best.hidden = !best;
  if (best) {
    v.best.className = `q ${qClass(best.variant)}`;
    setText(v.best, `up to ${best.quality}`);
  }
}

function buildEpisode(ep) {
  const cb = h('input', { type: 'checkbox', onchange: () => selectEpisodes([ep], cb.checked) });
  const meta = h('span', { class: 'dur' });
  const badge = h('span', { class: 'q' });
  const links = h('span', { class: 'ep-links', hidden: true });
  const title = h('span', { class: 'title' }, ep.label);
  const syn = h('span', { class: 'syn', hidden: true });
  const li = h('li', { class: 'ep' },
    h('label', null,
      cb,
      h('span', { class: 'thumb' }, ep.image ? thumb(ep.image, '') : null,
        playButton(() => watchEpisode(ep, state.show), `Watch ${ep.code || ep.label}`)),
      h('span', { class: 'code' }, ep.code || '—'),
      h('span', { class: 'title-cell' }, title, syn, links)),
    meta,
    badge);
  view.eps.set(ep.id, { li, cb, meta, badge, links, title, syn });
  updateEpisodeRow(ep);
  return li;
}

function updateEpisodeRow(ep) {
  const v = view.eps.get(ep.id);
  if (!v) return;
  const info = state.info.get(ep.id);
  const blocked = !!(info && info.status === 'blocked');
  v.li.classList.toggle('blocked', blocked);
  v.cb.checked = state.selected.has(ep.id);
  v.cb.disabled = blocked;

  let cls = 'q';
  let text = '';
  let title = '';
  if (info && info.status === 'ok') {
    cls = `q ${qClass(info.variant)}`;
    text = info.quality;
    title = `Best available: ${info.variant.width}×${info.variant.height}`;
  } else if (blocked) {
    cls = 'q bad';
    text = 'Locked';
    title = 'u-tv.ru shows a region block for this episode on your connection';
  } else if (info && info.status === 'error') {
    cls = 'q bad';
    text = 'Error';
    title = info.error || 'Error';
  }
  v.badge.className = cls;
  v.badge.title = title;
  if (info && info.status === 'loading') {
    if (!v.badge.querySelector('.mini-spin')) v.badge.replaceChildren(h('span', { class: 'mini-spin' }));
  } else setText(v.badge, text);

  const secs = episodeSeconds(ep, info);
  const size = estimateBytes(ep, info);
  setText(v.meta, [secs ? `${Math.round(secs / 60)} min` : '', size ? `≈${fmtBytes(size)}` : '', state.saved.has(ep.id) ? '✓ saved' : '']
    .filter(Boolean).join(' · '));
  renderSummary(ep, v);
  renderLinks(ep, v.links);
}

// "1 сезон 3 серия" says nothing the code column doesn't, so such rows lead with who the
// episode is about (first sentence of the site's own description, full text on hover).
const PLAIN_LABEL = /^\d+\s*сезон\s*\d+\s*серия$/i;
function firstSentence(text) {
  const t = String(text).trim();
  const m = t.match(/^(.{20,220}?[.!?…])(\s|$)/);
  return m ? m[1] : t.slice(0, 180);
}
function renderSummary(ep, v) {
  const d = descs.get(ep.id);
  if (!d) return;
  const line = firstSentence(d);
  if (PLAIN_LABEL.test(ep.label)) {
    setText(v.title, line);
    v.title.title = `${ep.label}\n\n${d}`;
  } else {
    setText(v.syn, line);
    v.syn.hidden = false;
    v.syn.title = d;
  }
}

function refreshShowView() {
  if (!state.show) return;
  for (const s of state.show.seasons) {
    updateSeasonHead(s);
    for (const ep of s.episodes) updateEpisodeRow(ep);
  }
  updateBar();
}

function selectEpisodes(episodes, on) {
  for (const ep of episodes) {
    if (on && isPickable(ep)) {
      state.selected.add(ep.id);
      requestInfo(ep);
    } else if (!on) state.selected.delete(ep.id);
  }
  for (const ep of episodes) updateEpisodeRow(ep);
  new Set(episodes.map((e) => seasonOf(e.id)).filter(Boolean)).forEach(updateSeasonHead);
  updateBar();
}

function quickSelect(kind) {
  const show = state.show;
  if (!show) return;
  state.selected.clear();
  let seasons = [];
  if (kind === 'all') {
    seasons = show.seasons.filter((s) => s.num != null);
    if (!seasons.length) seasons = show.seasons;
  } else if (kind === 'latest') {
    const l = latestSeason(show);
    if (l) seasons = [l];
  }
  for (const s of seasons) {
    for (const ep of s.episodes) {
      if (isPickable(ep) && !state.saved.has(ep.id)) { state.selected.add(ep.id); requestInfo(ep); }
    }
  }
  if (kind === 'latest' && seasons[0] && !state.open.has(seasons[0].key)) toggleOpen(seasons[0]);
  refreshShowView();
  const skipped = seasons.reduce((n, s) => n + s.episodes.filter((e) => state.saved.has(e.id)).length, 0);
  if (skipped) toast(`Left out ${skipped} episode(s) you already downloaded — tick them yourself to get them again`);
}

function selectedEpisodes() {
  const out = [];
  if (!state.show) return out;
  for (const s of state.show.seasons) for (const ep of s.episodes) if (state.selected.has(ep.id)) out.push(ep);
  return out;
}

function updateBar() {
  const eps = selectedEpisodes();
  const n = eps.length;
  let text = n ? `${n} episode${n === 1 ? '' : 's'} selected` : 'Tick seasons or episodes to download';
  if (n) {
    const infos = eps.map((e) => state.info.get(e.id));
    if (infos.some((i) => !i || i.status === 'loading')) text += ' · checking quality…';
    else {
      const total = eps.reduce((sum, e, i) => sum + estimateBytes(e, infos[i]), 0);
      const unknown = eps.filter((e, i) => !estimateBytes(e, infos[i])).length;
      if (total) text += unknown ? ` · at least ${fmtBytes(total)} (${unknown} size${unknown === 1 ? '' : 's'} unknown)` : ` · ≈${fmtBytes(total)}`;
    }
  }
  setText($('selSummary'), text);
  $('downloadBtn').disabled = n === 0;
}

// ---------- episode info (best quality, duration) ----------

const infoQueue = [];
let infoActive = 0;

async function resolveEpisode(ep, signal) {
  const html = await net.text(ep.url, signal);
  rememberDescription(ep, html);
  const page = parseEpisodePage(html);
  if (page.blocked) return { status: 'blocked' };
  if (page.error) throw new Error(page.error);
  const master = await resolveMasterPlaylist(page.playerUrl, net, signal);
  const variant = pickBest(parseMaster(master.text, master.url).variants);
  const media = parseMedia(await net.text(variant.url, signal), variant.url);
  return { status: 'ok', variant, quality: qualityLabel(variant), media, seconds: media.totalDuration };
}

// Badge lookups for the list. Errors are not cached: asking again re-checks.
function requestInfo(ep) {
  const cur = state.info.get(ep.id);
  if (cur && cur.status !== 'error') return;
  const entry = { status: 'loading' };
  state.info.set(ep.id, entry);
  infoQueue.push({ ep, entry });
  if (view.eps.has(ep.id)) updateEpisodeRow(ep);
  pumpInfo();
}

function pumpInfo() {
  while (infoActive < INFO_CONCURRENCY && infoQueue.length) {
    const { ep, entry } = infoQueue.shift();
    infoActive++;
    resolveEpisode(ep)
      .then((r) => Object.assign(entry, r), (e) => Object.assign(entry, { status: 'error', error: friendlyError(e) }))
      .finally(() => {
        infoActive--;
        if (state.info.get(ep.id) === entry) onInfoChanged(ep, entry);
        pumpInfo();
      });
  }
}

// Leaving a show drops its not-yet-started lookups so the new show isn't stuck behind them.
function pruneInfoQueue(show) {
  const keep = new Set(show.seasons.flatMap((s) => s.episodes.map((e) => e.id)));
  for (let i = infoQueue.length - 1; i >= 0; i--) {
    const { ep, entry } = infoQueue[i];
    if (keep.has(ep.id)) continue;
    infoQueue.splice(i, 1);
    if (state.info.get(ep.id) === entry) state.info.delete(ep.id);
  }
}

function dropQueuedInfo(epId) {
  const i = infoQueue.findIndex((x) => x.ep.id === epId);
  if (i !== -1) infoQueue.splice(i, 1);
}

let infoRenderTimer = null;
const dirtyEps = new Set();
function onInfoChanged(ep, entry) {
  if (entry.status === 'blocked') state.selected.delete(ep.id);
  dirtyEps.add(ep.id);
  if (infoRenderTimer) return;
  infoRenderTimer = setTimeout(() => {
    infoRenderTimer = null;
    const seasons = new Set();
    for (const id of dirtyEps) {
      const season = seasonOf(id);
      if (!season) continue; // belongs to a show that's no longer open
      seasons.add(season);
      const ep = season.episodes.find((e) => e.id === id);
      updateEpisodeRow(ep);
    }
    dirtyEps.clear();
    seasons.forEach(updateSeasonHead);
    updateBar();
  }, 150);
}

// ---------- "already downloaded" marks ----------

function baseFromPath(p) {
  return p.split(/[\\/]/).pop().replace(/(?: \(\d+\))?\.[^.]+$/, '');
}

// Episode ids of `show` that are already in Downloads/U-TV/<show>/.
async function savedIdsFor(show) {
  const items = await chrome.downloads.search({
    filenameRegex: `[\\\\/]${escapeRe(ROOT_FOLDER)}[\\\\/]${escapeRe(show.folder)}[\\\\/][^\\\\/]+$`,
    state: 'complete',
    exists: true,
  });
  const bases = new Set(items.map((i) => baseFromPath(i.filename)));
  const ids = new Set();
  for (const s of show.seasons) for (const ep of s.episodes) if (bases.has(ep.baseName)) ids.add(ep.id);
  return ids;
}

async function refreshSaved() {
  const show = state.show;
  if (!show) return;
  try {
    const ids = await savedIdsFor(show);
    if (state.show !== show) return;
    state.saved.clear();
    ids.forEach((id) => state.saved.add(id));
    refreshShowView();
  } catch {
    // Marks are a convenience; downloading works without them.
  }
}

function markSaved(job) {
  const set = family.saved.get(job.show.slug);
  if (set) set.add(job.ep.id);
  if (!news.saved.has(job.show.slug)) news.saved.set(job.show.slug, new Set());
  news.saved.get(job.show.slug).add(job.ep.id);
  renderNews();
  if (state.show && state.show.slug === job.show.slug) state.saved.add(job.ep.id);
  refreshShowView();
}

// ---------- related shows (e.g. Чадо из ада ↔ Предки ↔ Новые испытания) ----------
// Shows named "<Title> - <Spin-off>" are linked to the original "<Title>": each spin-off episode
// points to the original episode(s) with the same people, found by the names in the descriptions.

const descs = new Map(); // episode id -> "О серии" text, kept in chrome.storage.local
let descsLoaded = null;
let descSaveTimer = null;
let pendingFocus = null;

// The cache only saves time; without chrome.storage everything still works, just re-reads pages.
function loadDescs() {
  if (!descsLoaded) {
    descsLoaded = (async () => {
      try {
        const r = await chrome.storage.local.get('descs');
        for (const [k, v] of Object.entries((r && r.descs) || {})) if (!descs.has(k)) descs.set(k, v);
      } catch { /* no cache available */ }
    })();
  }
  return descsLoaded;
}

function saveDescs() {
  clearTimeout(descSaveTimer);
  descSaveTimer = setTimeout(async () => {
    try { await chrome.storage.local.set({ descs: Object.fromEntries(descs) }); } catch { /* not cached this time */ }
  }, 1500);
}

function rememberDescription(ep, html) {
  const d = parseEpisodeDetails(html).description;
  if (d && descs.get(ep.id) !== d) {
    descs.set(ep.id, d);
    saveDescs();
  }
}

async function ensureDescriptions(eps, onProgress) {
  await loadDescs();
  const need = eps.filter((e) => !descs.has(e.id));
  let done = eps.length - need.length;
  if (onProgress) onProgress(done, eps.length);
  const queue = [...need];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const ep = queue.shift();
      try { rememberDescription(ep, await net.text(ep.url)); } catch { /* tried again next time */ }
      done++;
      if (onProgress) onProgress(done, eps.length);
    }
  }));
}

const family = {
  ready: false,
  base: null,
  shows: new Map(),   // slug -> parsed show (original + spin-offs)
  eps: new Map(),     // episode id -> { ep, show }
  links: new Map(),   // spin-off episode id -> [{ originalId, confidence, names }]
  reverse: new Map(), // original episode id -> [spin-off episode ids]
  saved: new Map(),   // slug -> Set of downloaded episode ids
};

const baseTitle = (t) => String(t).split(/\s+[-–—]\s+/)[0].trim().toLowerCase();
const spinName = (show) => {
  const parts = show.title.split(/\s+[-–—]\s+/);
  return parts.length > 1 ? parts.slice(1).join(' - ') : show.title;
};

function resetFamily() {
  family.ready = false;
  family.base = null;
  family.shows.clear();
  family.eps.clear();
  family.links.clear();
  family.reverse.clear();
  family.saved.clear();
  $('familyBar').hidden = true;
}

function renderFamilyBar(text) {
  const bar = $('familyBar');
  const chips = [...family.shows.values()].map((s) => (state.show && s.slug === state.show.slug
    ? h('span', { class: 'fam-show current' }, spinName(s))
    : h('button', { type: 'button', class: 'fam-show', onclick: () => loadShow(s.slug) }, spinName(s))));
  bar.replaceChildren(h('span', { class: 'fam-text' }, text), ...(family.ready ? [h('span', { class: 'fam-shows' }, chips)] : []));
  bar.hidden = false;
}

async function setupFamily(show) {
  const token = showLoadToken;
  const base = baseTitle(show.title);
  if (family.ready && family.base === base && family.shows.has(show.slug)) {
    // Same family as before: links are already known, just refresh the saved marks.
    await refreshFamilySaved();
    if (token === showLoadToken) { renderFamilyBar(familySummary()); refreshShowView(); }
    return;
  }
  resetFamily();
  if (!state.shows) {
    try {
      const r = await loadAllShows((url, init) => fetch(url, init));
      state.shows = r.shows;
      state.showsComplete = r.complete;
    } catch {
      return;
    }
  }
  if (token !== showLoadToken) return;
  const members = state.shows.filter((s) => baseTitle(s.name) === base);
  if (!members.some((s) => s.slug === show.slug)) members.push({ slug: show.slug, name: show.title });
  const originalMeta = members.find((s) => s.name.trim().toLowerCase() === base);
  if (members.length < 2 || !originalMeta) return;

  $('familyBar').hidden = false;
  $('familyBar').replaceChildren(h('span', { class: 'fam-text' }, 'Looking at related shows…'));
  const shows = await Promise.all(members.map((m) => (m.slug === show.slug
    ? show
    : net.text(showUrl(m.slug)).then((html) => parseShowPage(html, m.slug)).catch(() => null))));
  if (token !== showLoadToken) return;
  const original = shows.find((s) => s && s.slug === originalMeta.slug);
  const spinoffs = shows.filter((s) => s && s !== original && s.seasons.length);
  if (!original || !original.seasons.some((s) => s.num != null) || !spinoffs.length) { $('familyBar').hidden = true; return; }

  const originalEps = original.seasons.filter((s) => s.num != null).flatMap((s) => s.episodes);
  const spinEps = spinoffs.flatMap((s) => s.seasons.flatMap((x) => x.episodes));
  await ensureDescriptions([...originalEps, ...spinEps], (d, n) => {
    if (token === showLoadToken) $('familyBar').firstChild.textContent = `Matching the people across ${spinoffs.length + 1} related shows… ${d}/${n}`;
  });
  if (token !== showLoadToken) return;

  const withText = (e) => ({ id: e.id, description: descs.get(e.id) || '' });
  const links = matchEpisodes(originalEps.map(withText), spinEps.map(withText));
  family.base = base;
  for (const s of [original, ...spinoffs]) {
    family.shows.set(s.slug, s);
    for (const season of s.seasons) for (const ep of season.episodes) family.eps.set(ep.id, { ep, show: s });
  }
  for (const [spinId, list] of links) {
    family.links.set(spinId, list);
    for (const l of list) {
      if (!family.reverse.has(l.originalId)) family.reverse.set(l.originalId, []);
      family.reverse.get(l.originalId).push(spinId);
    }
  }
  await refreshFamilySaved();
  if (token !== showLoadToken) return;
  family.ready = true;
  renderFamilyBar(familySummary());
  refreshShowView();
}

function familySummary() {
  const n = family.links.size;
  const original = [...family.shows.values()].find((s) => baseTitle(s.title) === family.base && s.title.trim().toLowerCase() === family.base);
  return `${n} episode${n === 1 ? '' : 's'} linked to the original «${original ? original.title : ''}» by the people in them.`;
}

async function refreshFamilySaved() {
  await Promise.all([...family.shows.values()].map(async (s) => {
    try { family.saved.set(s.slug, await savedIdsFor(s)); } catch { family.saved.set(s.slug, new Set()); }
  }));
}

function isQueued(id) {
  return state.jobs.some((j) => j.ep.id === id && ACTIVE.has(j.status));
}

// Link chips under an episode title. Only rebuilt when their content changes, so a click is never lost.
function renderLinks(ep, el) {
  const items = [];
  if (family.ready && family.eps.has(ep.id)) {
    for (const l of family.links.get(ep.id) || []) {
      const o = family.eps.get(l.originalId);
      if (!o) continue;
      const saved = !!(family.saved.get(o.show.slug) || new Set()).has(o.ep.id);
      items.push({
        kind: 'from', target: o, probable: l.confidence !== 'high', names: l.names,
        status: saved ? 'saved' : isQueued(o.ep.id) ? 'queued' : 'missing',
      });
    }
    const bySpin = new Map();
    for (const id of family.reverse.get(ep.id) || []) {
      const f = family.eps.get(id);
      if (!f) continue;
      if (!bySpin.has(f.show.slug)) bySpin.set(f.show.slug, []);
      bySpin.get(f.show.slug).push(f);
    }
    for (const list of bySpin.values()) items.push({ kind: 'to', targets: list });
  }
  const key = JSON.stringify(items.map((i) => (i.kind === 'from' ? [i.target.ep.id, i.probable, i.status] : i.targets.map((t) => t.ep.id))));
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.hidden = !items.length;
  el.replaceChildren(...items.map((i) => {
    if (i.kind === 'from') {
      const label = `↩ ${i.probable ? 'probably ' : ''}from ${spinName(i.target.show)} ${i.target.ep.code || i.target.ep.label}`;
      const jump = h('button', {
        type: 'button', class: `link-chip${i.probable ? ' probable' : ''}`,
        title: i.probable ? 'Matched by a first name only — worth a quick check' : 'Same family (matched by name)',
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); goTo(i.target.show.slug, i.target.ep.id); },
      }, label, i.probable ? ' ?' : '');
      const extra = i.status === 'saved'
        ? h('span', { class: 'link-state ok' }, '✓ saved')
        : i.status === 'queued'
          ? h('span', { class: 'link-state' }, 'downloading')
          : h('button', {
            type: 'button', class: 'link-add', title: `Download ${i.target.show.title} ${i.target.ep.code || ''} too`,
            onclick: (e) => { e.preventDefault(); e.stopPropagation(); addOriginal(i.target); },
          }, '+ Download');
      return h('span', { class: 'link-item' }, jump, extra);
    }
    const first = i.targets[0];
    const name = spinName(first.show);
    const label = i.targets.length <= 2
      ? `↪ continues in ${name} ${i.targets.map((t) => t.ep.code || t.ep.label).join(', ')}`
      : `↪ in ${i.targets.length} episodes of ${name}`;
    return h('span', { class: 'link-item' }, h('button', {
      type: 'button', class: 'link-chip', title: i.targets.map((t) => t.ep.code || t.ep.label).join(', '),
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); goTo(first.show.slug, first.ep.id); },
    }, label));
  }));
}

function addOriginal(target) {
  const added = enqueue([target.ep], target.show);
  refreshShowView();
  toast(added ? `Added ${target.show.title} ${target.ep.code || ''} to the download list` : 'That episode is already downloading');
}

function goTo(slug, id) {
  if (state.show && state.show.slug === slug) { focusEpisode(id); return; }
  pendingFocus = id;
  loadShow(slug);
}

function focusEpisode(id) {
  const season = seasonOf(id);
  if (!season) return;
  if (!state.open.has(season.key)) toggleOpen(season);
  const v = view.eps.get(id);
  if (!v) return;
  v.li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  v.li.classList.remove('flash');
  void v.li.offsetWidth; // restart the highlight animation
  v.li.classList.add('flash');
}

// "Find a name": searches episode descriptions of this show (and its related shows).
let findTimer = null;
let findSeq = 0;
async function runFind() {
  const seq = ++findSeq;
  const q = $('findInput').value.trim();
  const list = $('findResults');
  if (q.length < 2 || !state.show) { list.hidden = true; list.replaceChildren(); return; }
  const scope = family.ready && family.shows.has(state.show.slug) ? [...family.shows.values()] : [state.show];
  const eps = scope.flatMap((s) => s.seasons.flatMap((x) => x.episodes.map((ep) => ({ ep, show: s }))));
  if (eps.some((x) => !descs.has(x.ep.id))) {
    const note = h('li', { class: 'muted small' }, 'Reading episode descriptions…');
    list.replaceChildren(note);
    list.hidden = false;
    await ensureDescriptions(eps.map((x) => x.ep), (d, n) => { note.textContent = `Reading episode descriptions… ${d}/${n}`; });
    if (seq !== findSeq) return;
  }
  const needle = q.toLowerCase().replace(/ё/g, 'е');
  const wanted = q.split(/\s+/).filter((w) => w.length >= 3).map(stem);
  const hits = eps.filter(({ ep }) => {
    const text = `${ep.label} ${descs.get(ep.id) || ''}`;
    if (text.toLowerCase().replace(/ё/g, 'е').includes(needle)) return true;
    if (!wanted.length) return false;
    const found = nameStems(text);
    return wanted.every((s) => found.has(s));
  });
  list.replaceChildren(...(hits.length
    ? hits.slice(0, 40).map(({ ep, show }) => h('li', null, h('button', {
      type: 'button', class: 'find-hit', onclick: () => goTo(show.slug, ep.id),
    }, h('span', { class: 'find-show' }, spinName(show)), h('span', { class: 'find-code' }, ep.code || ''), h('span', { class: 'find-label' }, ep.label))))
    : [h('li', { class: 'muted small' }, `No episode mentions “${q}”.`)]));
  list.hidden = false;
}

// ---------- downloads ----------

let jobSeq = 0;

// Adds episodes of `show` to the download list; returns how many were new.
function enqueue(eps, show) {
  let added = 0;
  for (const ep of eps) {
    if (state.jobs.some((j) => j.ep.id === ep.id && ACTIVE.has(j.status))) continue;
    for (const old of state.jobs.filter((j) => j.ep.id === ep.id)) discardPart(old);
    state.jobs = state.jobs.filter((j) => j.ep.id !== ep.id);
    state.jobs.push({
      key: ++jobSeq,
      ep,
      show: { title: show.title, folder: show.folder, slug: show.slug },
      format: state.format,
      status: 'queued',
      progress: null,
      error: null,
      ctl: null,
    });
    added++;
  }
  renderQueue();
  runQueue();
  updateNewsButtons();
  return added;
}

function onDownloadClick() {
  const eps = selectedEpisodes();
  if (!eps.length) return;
  const added = enqueue(eps, state.show);
  state.selected.clear();
  refreshShowView();
  toast(added ? `Added ${added} episode${added === 1 ? '' : 's'} to the download list` : 'Those episodes are already downloading');
}

// Starts queued episodes until `state.parallel` are running at once.
// runJob flips a job to 'preparing' synchronously, so it can't be picked twice.
let runners = 0;
function runQueue() {
  let job;
  while (runners < state.parallel && (job = state.jobs.find((j) => j.status === 'queued'))) {
    runners++;
    if (runners === 1) keepAlive(true);
    runJob(job).finally(() => {
      runners--;
      if (runners === 0 && !state.jobs.some((j) => j.status === 'queued')) {
        keepAlive(false);
        renderQueue();
      }
      runQueue();
    });
  }
}

async function workDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('work', { create: true });
}

async function cleanWorkDir() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('work', { recursive: true });
  } catch {
    // Nothing left over, or a file is still in use.
  }
}

async function discardPart(job) {
  const names = [job.partName, job.mp4Name, job.readyName].filter(Boolean);
  job.partName = null;
  job.mp4Name = null;
  job.readyName = null;
  job.resume = null;
  if (!names.length) return;
  try {
    const dir = await workDir();
    for (const name of names) await dir.removeEntry(name).catch(() => {});
  } catch { /* already gone */ }
}

function setJob(job, status, note) {
  job.status = status;
  job.note = note || null;
  if (status !== 'downloading' && status !== 'preparing') job.waiting = null;
  updateJobRow(job);
  updateQueueChrome();
  if (!ACTIVE.has(status)) updateNewsButtons();
}

function jobWaiting(job, w) {
  const secs = Math.round(w.delayMs / 1000);
  job.waiting = w.network ? `connection problem, retrying in ${secs}s…` : `server hiccup, retrying in ${secs}s…`;
  scheduleJobUpdate(job);
}

async function jobInfo(job, signal) {
  const cached = state.info.get(job.ep.id);
  if (cached && (cached.status === 'ok' || cached.status === 'blocked')) return cached;
  dropQueuedInfo(job.ep.id);
  const r = await withRetry(() => resolveEpisode(job.ep, signal), { signal, retries: 3, onWait: (w) => jobWaiting(job, w) });
  const entry = { ...r };
  state.info.set(job.ep.id, entry);
  onInfoChanged(job.ep, entry);
  return entry;
}

function checkHasSound(firstSegment) {
  const s = tsStreams(firstSegment);
  if (s && s.video && !s.audio && !s.unknown) {
    throw new Error('This stream has no sound track (separate audio tracks are not supported)');
  }
}

async function runJob(job) {
  job.ctl = new AbortController();
  const { signal } = job.ctl;
  let keepPart = false;
  try {
    setJob(job, 'preparing', 'Finding the best stream…');
    const dir = await workDir();
    let file = null;
    // A finished file from an earlier attempt whose save failed: just save it again.
    if (job.readyName) {
      try { file = await (await dir.getFileHandle(job.readyName)).getFile(); } catch { job.readyName = null; }
      job.resume = null;
    }
    if (!file) file = await fetchEpisodeFile(job, dir, signal, () => { keepPart = true; });

    setJob(job, 'saving', 'Saving to your Downloads folder…');
    job.bytes = file.size;
    try {
      job.downloadId = await saveToDownloads(file, job.filename, signal);
    } catch (e) {
      if (!signal.aborted) {
        job.resume = { pct: 100 }; // the finished file (job.readyName) is kept for Retry
        keepPart = true;
      }
      throw e;
    }
    setJob(job, 'done');
    markSaved(job);
    notifyDone(job);
    if (!$('dlHistory').hidden) loadHistory();
  } catch (e) {
    if (signal.aborted) job.status = 'canceled';
    else {
      job.error = friendlyError(e);
      const tail = job.resume ? ` — Retry continues from ${job.resume.pct}%` : '';
      setJob(job, 'error', job.error + tail);
    }
  } finally {
    if (job.writable) await job.writable.abort().catch(() => {});
    job.writable = null;
    if (!keepPart) await discardPart(job);
    job.ctl = null;
    if (job.status === 'canceled') removeJob(job);
  }
}

// Downloads the episode into private storage (resuming a partial file if there is one),
// converts it to MP4 when asked, and returns the finished file. It is then job.readyName;
// the intermediate .ts is deleted as soon as the MP4 exists, so peak disk use stays low.
async function fetchEpisodeFile(job, dir, signal, keepPartial) {
  {
    const info = await jobInfo(job, signal);
    signal.throwIfAborted();
    if (info.status === 'blocked') throw new Error('Region-locked for your connection');
    job.quality = info.quality;
    const { media, variant } = info;
    // fMP4 sources are already MP4; TS sources become MP4 only if asked for.
    const wantMp4 = !media.init && job.format === 'mp4';
    const ext = media.init || wantMp4 ? 'mp4' : 'ts';
    job.filename = `${ROOT_FOLDER}/${job.show.folder}/${job.ep.baseName}.${ext}`;

    if (!job.partName) job.partName = `${job.ep.id}-${job.key}.part`;
    const fh = await dir.getFileHandle(job.partName, { create: true });
    let startAt = 0;
    let startBytes = 0;
    const resume = job.resume;
    job.resume = null;
    if (resume && resume.variantUrl === variant.url && (await fh.getFile()).size >= resume.bytes) {
      startAt = resume.segments;
      startBytes = resume.bytes;
    }

    if (startAt < media.segments.length) {
      const writable = await fh.createWritable({ keepExistingData: startAt > 0 });
      job.writable = writable;
      if (startAt > 0) {
        await writable.truncate(startBytes);
        await writable.seek(startBytes);
      }
      job.startedAt = performance.now();
      job.samples = [];
      job.progress = null;
      setJob(job, 'downloading');
      let last = null;
      try {
        await downloadHls({
          segments: media.segments,
          init: media.init,
          startAt,
          startBytes,
          fetchSegment: net.bytes,
          write: (bytes) => writable.write(bytes),
          validate: media.init ? (b) => b.length > 0 : isTransportStream,
          checkFirst: media.init ? null : checkHasSound,
          signal,
          onProgress: (p) => { last = p; job.progress = p; job.waiting = null; scheduleJobUpdate(job); },
          onWait: (w) => jobWaiting(job, w),
        });
      } catch (e) {
        // Keep what's already on disk so Retry continues from here instead of 0%.
        if (!signal.aborted && last && last.segmentsDone > 0) {
          try {
            await writable.close();
            job.writable = null;
            job.resume = { segments: last.segmentsDone, bytes: last.bytes, variantUrl: variant.url, pct: Math.floor((last.seconds / last.totalSeconds) * 100) };
            keepPartial();
          } catch { /* couldn't keep it; start over next time */ }
        }
        throw e;
      }
      await writable.close();
      job.writable = null;
    }

    let file = await fh.getFile();
    job.note2 = null;
    if (wantMp4) {
      try {
        file = await convertToMp4(job, file, dir, signal);
        // The .ts isn't needed any more: free that space before Chrome writes its own copy.
        await dir.removeEntry(job.partName).catch(() => {});
        job.partName = null;
        job.readyName = job.mp4Name;
        job.mp4Name = null;
      } catch (e) {
        if (signal.aborted) throw e;
        // Never lose a finished download over the conversion: keep the original stream instead.
        job.filename = job.filename.replace(/.mp4$/, '.ts');
        job.note2 = `MP4 conversion failed (${e.message}), saved the original .ts`;
      }
    }
    if (!job.readyName) {
      job.readyName = job.partName;
      job.partName = null;
    }
    return file;
  }
}

// Repackages the downloaded .ts into an .mp4 next to it in private storage (same frames,
// no re-encoding) and returns the new file. Takes a few seconds even for a 3 GB episode.
async function convertToMp4(job, tsFile, dir, signal) {
  const name = `${job.partName}.mp4`;
  const handle = await dir.getFileHandle(name, { create: true });
  const out = await handle.createWritable();
  job.mp4Name = name;
  job.convertPct = 0;
  setJob(job, 'converting');
  try {
    const conv = new TsToMp4({
      write: (bytes) => out.write(bytes),
      writeAt: (position, bytes) => out.write({ type: 'write', position, data: bytes }),
    });
    const reader = tsFile.stream().getReader();
    let done = 0;
    for (;;) {
      signal.throwIfAborted();
      const { value, done: end } = await reader.read();
      if (end) break;
      await conv.push(value);
      done += value.length;
      job.convertPct = Math.floor((done / tsFile.size) * 100);
      scheduleJobUpdate(job);
    }
    await conv.finish();
    await out.close();
  } catch (e) {
    await out.abort().catch(() => {});
    await dir.removeEntry(name).catch(() => {});
    job.mp4Name = null;
    throw e;
  }
  return handle.getFile();
}

function saveToDownloads(file, filename, signal) {
  // The OPFS file has no MIME type, so Chrome would sniff it and rename the
  // download to ".txt". A generic binary type makes Chrome keep our name as-is
  // on every OS. Wrapping the File doesn't copy it; it stays disk-backed.
  const url = URL.createObjectURL(new Blob([file], { type: 'application/octet-stream' }));
  return new Promise((resolve, reject) => {
    let id = null;
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      signal.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(url);
      if (err) reject(err); else resolve(id);
    };
    const check = (stateName, errName) => {
      if (stateName === 'complete') finish();
      else if (stateName === 'interrupted') finish(new Error(`Chrome couldn't save the file (${errName || 'interrupted'})`));
    };
    const onChanged = (d) => {
      if (id !== null && d.id === id && d.state) check(d.state.current, d.error && d.error.current);
    };
    const onAbort = () => {
      if (id !== null) chrome.downloads.cancel(id).catch(() => {});
      finish(new DOMException('Download canceled', 'AbortError'));
    };
    chrome.downloads.onChanged.addListener(onChanged);
    signal.addEventListener('abort', onAbort, { once: true });
    chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' }).then(async (newId) => {
      id = newId;
      if (signal.aborted) return onAbort();
      const [item] = await chrome.downloads.search({ id });
      if (item) check(item.state, item.error);
    }, (e) => finish(e));
  });
}

async function keepAlive(on) {
  // Stop Chrome's memory saver from unloading this tab mid-download.
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab) await chrome.tabs.update(tab.id, { autoDiscardable: !on });
  } catch {
    // Not fatal.
  }
}

// Cancel means "I don't want it": the row goes away (its temp file is removed by runJob).
function cancelJob(job) {
  if (job.status === 'queued') removeJob(job);
  else if (job.ctl) job.ctl.abort();
  toast(`Canceled ${job.show.title} ${job.ep.code || job.ep.label}`);
}

function removeJob(job) {
  discardPart(job);
  state.jobs = state.jobs.filter((j) => j !== job);
  renderQueue();
  refreshShowView();
  updateNewsButtons();
}

function retryJob(job) {
  if (ACTIVE.has(job.status)) return;
  job.status = 'queued';
  job.progress = null;
  job.error = null;
  job.note = null;
  updateJobRow(job);
  updateQueueChrome();
  runQueue();
}

// ---------- queue rendering (rows are updated in place) ----------

const updateTimers = new Map();
function scheduleJobUpdate(job) {
  if (updateTimers.has(job.key)) return;
  updateTimers.set(job.key, setTimeout(() => {
    updateTimers.delete(job.key);
    updateJobRow(job);
    updateTitle();
  }, 250));
}

function jobPercent(job) {
  if (job.status === 'done' || job.status === 'saving') return 100;
  if (job.status === 'converting') return job.convertPct || 0;
  const p = job.progress;
  if (p && p.totalSeconds) return Math.min(100, (p.seconds / p.totalSeconds) * 100);
  return job.resume ? job.resume.pct : 0;
}

function jobSpeed(job) {
  // Average over the last ~10 s so the number settles quickly and stays honest.
  const p = job.progress;
  if (!p) return 0;
  const now = performance.now();
  const s = job.samples || (job.samples = []);
  if (!s.length || s[s.length - 1].b !== p.bytes) s.push({ t: now, b: p.bytes });
  while (s.length > 2 && now - s[0].t > 10000) s.shift();
  if (s.length < 2) return 0;
  const dt = (s[s.length - 1].t - s[0].t) / 1000;
  return dt > 0 ? (s[s.length - 1].b - s[0].b) / dt : 0;
}

function jobStatusText(job) {
  const p = job.progress;
  switch (job.status) {
    case 'queued': return job.resume ? `Waiting… (continues from ${job.resume.pct}%)` : 'Waiting…';
    case 'preparing': return job.waiting ? `Finding the best stream — ${job.waiting}` : (job.note || 'Finding the best stream…');
    case 'downloading': {
      const pct = `${Math.floor(jobPercent(job))}%`;
      if (job.waiting) return `${pct} · ${job.waiting}`;
      if (!p) return 'Starting…';
      const speed = jobSpeed(job);
      const perSecond = p.seconds > 0 ? p.bytes / p.seconds : 0;
      const eta = speed > 0 && perSecond > 0 ? ((p.totalSeconds - p.seconds) * perSecond) / speed : NaN;
      return `${pct} · ${fmtBytes(p.bytes)} · ${speed ? `${fmtBytes(speed)}/s` : '…'} · ${fmtTime(eta)} left · ${job.quality}`;
    }
    case 'converting': return `Converting to MP4… ${job.convertPct || 0}% · same quality, no re-encoding`;
    case 'done': {
      const kind = /\.mp4$/i.test(job.filename || '') ? 'MP4' : 'TS';
      return `Saved · ${fmtBytes(job.bytes)} · ${job.quality} · ${kind}${job.note2 ? ` — ${job.note2}` : ''}`;
    }
    default: return job.note || '';
  }
}

function jobActions(job) {
  const out = [];
  if (ACTIVE.has(job.status)) out.push(h('button', { class: 'link', type: 'button', onclick: () => cancelJob(job) }, 'Cancel'));
  if (job.status === 'error') {
    out.push(h('button', { class: 'link', type: 'button', onclick: () => retryJob(job) }, 'Retry'));
    out.push(h('button', { class: 'link muted-link', type: 'button', onclick: () => removeJob(job) }, 'Remove'));
  }
  if (job.status === 'done' && job.downloadId != null) {
    out.push(h('button', { class: 'link', type: 'button', onclick: () => chrome.downloads.show(job.downloadId) }, 'Show file'));
  }
  return out;
}

function jobView(job) {
  let v = jobViews.get(job.key);
  if (!v) {
    const name = h('span', { class: 'job-name' });
    const actions = h('span', { class: 'job-actions' });
    const fill = h('div');
    const status = h('div', { class: 'job-status' });
    const li = h('li', { class: 'job' }, h('div', { class: 'job-top' }, name, actions), h('div', { class: 'progress' }, fill), status);
    v = { li, name, actions, fill, status, actionsFor: null };
    jobViews.set(job.key, v);
  }
  return v;
}

function updateJobRow(job) {
  if (!state.jobs.includes(job)) return;
  const v = jobView(job);
  if (!v.li.isConnected) renderQueue();
  v.li.className = `job ${job.status}`;
  const name = `${job.show.title} · ${job.ep.code || job.ep.label}`;
  setText(v.name, name);
  v.name.title = job.filename || name;
  v.fill.style.width = `${jobPercent(job)}%`;
  setText(v.status, jobStatusText(job));
  if (v.actionsFor !== job.status) {
    v.actionsFor = job.status;
    v.actions.replaceChildren(...jobActions(job));
  }
}

function renderQueue() {
  const list = $('queueList');
  for (const [key, v] of jobViews) {
    if (!state.jobs.some((j) => j.key === key)) { v.li.remove(); jobViews.delete(key); }
  }
  state.jobs.forEach((job, i) => {
    const v = jobView(job);
    if (list.children[i] !== v.li) list.insertBefore(v.li, list.children[i] || null);
    updateJobRow(job);
  });
  updateQueueChrome();
}

function updateQueueChrome() {
  const active = state.jobs.filter((j) => ACTIVE.has(j.status));
  $('side').classList.toggle('busy', active.length > 0);
  $('queueEmpty').hidden = state.jobs.length > 0;
  $('clearBtn').hidden = !state.jobs.some((j) => !ACTIVE.has(j.status));
  $('retryAllBtn').hidden = !state.jobs.some((j) => j.status === 'error');
  $('dlCount').hidden = !active.length;
  setText($('dlCount'), String(active.length));
  setText($('queueSummary'), queueSummary(active));
  updateTitle();
}

// "3 left · about 18 min": remaining bytes of everything queued over the current speed.
function queueSummary(active) {
  if (!active.length) return '';
  const running = active.filter((j) => j.status === 'downloading' && j.progress);
  const speed = running.reduce((s, j) => s + jobSpeed(j), 0);
  let remaining = 0;
  let known = true;
  for (const j of active) {
    const info = state.info.get(j.ep.id);
    const p = j.progress;
    if (j.status === 'downloading' && p && p.seconds > 0) remaining += (p.totalSeconds - p.seconds) * (p.bytes / p.seconds);
    else if (j.status === 'queued' || j.status === 'preparing' || j.status === 'downloading') {
      const est = estimateBytes(j.ep, info);
      if (est) remaining += est; else known = false;
    }
  }
  const eta = speed > 0 && known ? remaining / speed : NaN;
  return `${active.length} left${Number.isFinite(eta) ? ` · about ${fmtTime(eta)}` : ''}`;
}

function updateTitle() {
  const active = state.jobs.filter((j) => ACTIVE.has(j.status));
  const base = state.show ? `${state.show.title} — U-TV Downloader` : 'U-TV Downloader';
  let title = base;
  if (active.length) {
    const cur = state.jobs.find((j) => j.status === 'downloading');
    title = `${cur ? `${Math.floor(jobPercent(cur))}% · ` : ''}${active.length} left — U-TV Downloader`;
  }
  if (document.title !== title) document.title = title;
  updateBadge();
}

// ---------- wiring ----------

function init() {
  $('searchInput').addEventListener('input', renderShowList);
  $('findInput').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 250); });
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = $('showList').querySelector('button');
    if (first) first.click();
  });
  $('backBtn').addEventListener('click', openPicker);
  $('errorBackBtn').addEventListener('click', openPicker);
  $('retryBtn').addEventListener('click', () => retryAction && retryAction());
  $('downloadBtn').addEventListener('click', onDownloadClick);
  $('folderBtn').addEventListener('click', () => chrome.downloads.showDefaultFolder());
  $('clearBtn').addEventListener('click', () => {
    for (const j of state.jobs) if (!ACTIVE.has(j.status)) discardPart(j);
    state.jobs = state.jobs.filter((j) => ACTIVE.has(j.status));
    renderQueue();
    updateNewsButtons();
  });
  $('retryAllBtn').addEventListener('click', () => {
    for (const j of state.jobs) {
      if (j.status !== 'error') continue;
      j.status = 'queued';
      j.progress = null;
      j.error = null;
      j.note = null;
    }
    renderQueue();
    runQueue();
  });
  document.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => quickSelect(b.dataset.quick)));

  // Player
  $('playerClose').addEventListener('click', closePlayer);
  $('playerDlg').addEventListener('close', closePlayer); // Esc
  $('playerDlg').addEventListener('click', (e) => { if (e.target === $('playerDlg')) closePlayer(); });
  $('playerCast').addEventListener('click', castPlayer);
  $('playerDownload').addEventListener('click', () => {
    if (!player.ep) return;
    const added = enqueue([player.ep], player.show);
    toast(added ? `Added ${player.show.title} ${player.ep.code || player.ep.label} to the download list` : 'That episode is already downloading');
  });

  // Settings dialog
  $('settingsBtn').addEventListener('click', () => $('settingsDlg').showModal());
  $('fmtHint').addEventListener('click', () => $('settingsDlg').showModal());
  document.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => setSetting(b.dataset.set, b.dataset.val)));
  $('settingsDlg').addEventListener('click', (e) => { if (e.target === $('settingsDlg')) $('settingsDlg').close(); }); // click outside closes

  // Downloads / History tabs
  document.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => showDlTab(b.dataset.dl)));
  $('historyFilter').addEventListener('input', renderHistory);
  try {
    chrome.downloads.onChanged.addListener((d) => { if (d.state && !$('dlHistory').hidden) loadHistory(); });
    // background.js resets the toolbar badge if this tab closes (it also handles notification clicks).
    chrome.tabs.getCurrent().then((t) => t && chrome.storage.session.set({ appTab: t.id })).catch(() => {});
  } catch { /* not available */ }

  // "/" jumps to the search box that's on screen
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || $('settingsDlg').open) return;
    const box = !$('pickerView').hidden ? $('searchInput') : !$('showView').hidden ? $('findInput') : null;
    if (box) { e.preventDefault(); box.focus(); box.select(); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.jobs.some((j) => ACTIVE.has(j.status))) { e.preventDefault(); e.returnValue = ''; }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'open-show' || !msg.slug) return;
    // Clicking the icon on the show that's already open just brings this tab forward.
    if (state.show && state.show.slug === msg.slug && !$('showView').hidden) return;
    loadShow(msg.slug);
  });

  $('favBtn').addEventListener('click', () => state.show && toggleFavorite(state.show.slug));

  cleanWorkDir();
  loadDescs().then(refreshShowView);
  renderQueue();
  const slug = slugFromInput(new URLSearchParams(location.search).get('show') || '');
  document.querySelectorAll('[data-news]').forEach((b) => b.addEventListener('click', () => {
    news.tab = b.dataset.news;
    renderNews();
  }));
  $('newsRefresh').addEventListener('click', () => refreshNews());
  $('newsSeen').addEventListener('click', markAllSeen);
  $('newsGetAll').addEventListener('click', downloadAllNew);
  Promise.all([loadSettings(), loadFavorites()]).finally(() => {
    if (slug) loadShow(slug); else openPicker();
    loadNewsState().then(refreshNews);
  });
}

init();
