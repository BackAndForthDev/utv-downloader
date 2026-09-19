// The website: the extension's screen for watching (no downloading), on a computer or a TV browser.
// Browsers can't read u-tv.ru pages from another site, so shows and episodes come from
// catalog.json (made by build-catalog.mjs); videos play straight from u-tv's video server,
// which allows it, at the best quality. Plain script (no modules) so older TV browsers run it too.
(function () {
  'use strict';

  const ORIGIN = 'https://www.u-tv.ru';
  const CDN = 'https://cdn.media1.ru/videos/';
  const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
  const IS_TV = /SmartTV|SMART-TV|VIDAA|Hisense|HbbTV|Tizen|Web0S|webOS|NetCast|BRAVIA|AFT|CrKey|\bTV\b/i.test(navigator.userAgent);

  const $ = (id) => document.getElementById(id);
  const flat = (lists) => [].concat.apply([], lists);

  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (let i = 0; i < arguments.length; i++) {
        const k = arguments[i];
        this.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
      }
    };
  }

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(`utv.${key}`);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`utv.${key}`, JSON.stringify(value)); } catch (e) { /* kept for this visit */ }
    },
  };

  const state = {
    cat: null,              // catalog.json
    shows: null,            // [{ slug, name, image, count, real }]
    show: null,             // the open show
    open: new Set(),        // expanded season keys
    favorites: new Set(store.get('favorites', [])),
  };

  // DOM nodes of the open show, updated in place.
  const view = { seasons: new Map(), eps: new Map() };

  // ---------- small helpers (same as the extension) ----------

  function h(tag, props) {
    const el = document.createElement(tag);
    const p = props || {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (typeof v === 'boolean') el[k] = v;
      else el.setAttribute(k, v);
    }
    const kids = flat(flat(Array.prototype.slice.call(arguments, 2)));
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function thumb(src, alt) {
    const img = h('img', { src, alt, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => { img.hidden = true; }, { once: true });
    return img;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
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
    if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Network error — check your connection';
    return msg;
  }

  const showUrl = (slug) => `${ORIGIN}/shows/${slug}/`;

  function slugFromInput(input) {
    const s = String(input || '').trim();
    const m = s.match(/u-tv\.ru\/shows\/([a-z0-9-]+)/i);
    if (m) return m[1].toLowerCase();
    if (/^[a-z0-9-]+$/i.test(s)) return s.toLowerCase();
    return null;
  }

  const qualityLabel = (height) => (height >= 2160 ? '4K' : height > 0 ? `${height}p` : 'HD');
  const qClass = (height) => (height >= 1440 ? 'top' : height >= 1080 ? 'good' : '');

  function fmtClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }

  function setView(name, text) {
    for (const v of ['picker', 'show', 'loading', 'error']) $(`${v}View`).hidden = v !== name;
    if (name === 'loading') $('loadingText').textContent = text || 'Loading…';
  }

  let retryAction = null;
  function showError(msg, retry) {
    $('errorText').textContent = msg;
    retryAction = retry;
    $('retryBtn').hidden = !retry;
    setView('error');
  }

  // ---------- the catalog ----------

  const showCache = new Map(); // real slug -> show in the extension's shape

  async function fetchCatalog() {
    const r = await fetch(`catalog.json?v=${Math.floor(Date.now() / 60000)}`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`the episode list is missing (HTTP ${r.status})`);
    return r.json();
  }

  function applyCatalog(cat) {
    state.cat = cat;
    state.shows = cat.shows;
    showCache.clear();
  }

  function realSlug(slug) {
    const listed = (state.shows || []).find((s) => s.slug === slug);
    return (listed && listed.real) || slug;
  }

  // Same fields the extension's parser gives, plus the stream (url, w, h) found when the list was built.
  function getShow(slug) {
    const real = realSlug(slug);
    if (showCache.has(real)) return showCache.get(real);
    const d = state.cat && state.cat.details[real];
    if (!d) return null;
    const show = {
      slug: real,
      title: d.title,
      image: d.image,
      seasons: d.seasons.map((s, i) => ({
        key: `s${i + 1}`,
        label: s.label,
        num: s.num,
        episodes: s.eps.map((e) => ({
          id: e.id,
          code: e.code || null,
          label: e.label,
          minutes: e.min || null,
          image: e.img || null,
          date: e.date || null,
          summary: e.d || '',
          url: e.s ? (e.s.indexOf('://') > 0 ? e.s : CDN + e.s) : null,
          width: e.w || 0,
          height: e.h || 0,
          locked: !!e.lock,
        })),
      })),
    };
    showCache.set(real, show);
    return show;
  }

  function findEpisode(slug, id) {
    const show = getShow(slug);
    const ep = show && flat(show.seasons.map((s) => s.episodes)).find((e) => e.id === id);
    return { show, ep };
  }

  // ---------- show picker ----------

  let showLoadToken = 0;

  function openPicker() {
    ++showLoadToken;
    clearShow();
    updateTitle();
    setView('picker');
    renderShowList();
    if (IS_TV) focusFirst($('showList')); // no on-screen keyboard popping up on a TV
    else $('searchInput').focus();
  }

  const showCardViews = new Map();

  function renderShowList() {
    const raw = $('searchInput').value.trim();
    const q = raw.toLowerCase();
    const pasted = /u-tv\.ru\/shows\//i.test(raw) ? slugFromInput(raw) : null;
    const shows = state.shows || [];
    const items = pasted
      ? [{ slug: pasted, name: `Open “${pasted}”` }]
      : shows.filter((s) => !q || s.name.toLowerCase().indexOf(q) !== -1 || s.slug.indexOf(q) !== -1);
    // Favourites first, shows with no videos last.
    if (!pasted) items.sort((a, b) => (state.favorites.has(b.slug) - state.favorites.has(a.slug)) || ((a.count === 0) - (b.count === 0)));
    showCardViews.clear();
    const card = (s) => {
      const count = h('span', { class: 'show-count' });
      const main = h('button', { type: 'button', class: 'show-card', onclick: () => openShow(s.slug) },
        h('span', { class: 'poster' }, s.image ? thumb(s.image, '') : null),
        h('span', { class: 'show-name' }, s.name),
        count);
      const fav = state.favorites.has(s.slug);
      const star = h('button', {
        type: 'button', class: `fav-star${fav ? ' on' : ''}`, tabindex: '-1', title: fav ? 'Remove from favourites' : 'Add to favourites',
        'aria-label': fav ? `Remove ${s.name} from favourites` : `Add ${s.name} to favourites`,
        onclick: (e) => { e.stopPropagation(); toggleFavorite(s.slug); },
      }, fav ? '★' : '☆');
      showCardViews.set(s.slug, { card: main, count });
      updateShowCard(s);
      return h('li', { class: 'show-item' }, main, star);
    };
    const favs = pasted ? [] : items.filter((s) => state.favorites.has(s.slug));
    const rest = items.filter((s) => favs.indexOf(s) === -1);
    const groups = [];
    if (favs.length) {
      groups.push(h('li', { class: 'group-head' }, '★ Favourites'));
      groups.push.apply(groups, favs.map(card));
      if (rest.length) groups.push(h('li', { class: 'group-head' }, q ? 'Other matches' : 'All shows'));
    }
    groups.push.apply(groups, rest.map(card));
    $('showList').replaceChildren.apply($('showList'), groups);
    let note = `${shows.length} shows`;
    if (q && !items.length) note = 'No show matches. You can paste a u-tv.ru show link.';
    $('pickerNote').textContent = note;
  }

  function updateShowCard(s) {
    const v = showCardViews.get(s.slug);
    if (!v) return;
    v.card.classList.toggle('empty', s.count === 0);
    const fresh = newIds(s.slug).length;
    const base = s.count === undefined ? '' : s.count === 0 ? 'no videos' : `${s.count} episode${s.count === 1 ? '' : 's'}`;
    setText(v.count, fresh ? `${base}${base ? ' · ' : ''}${fresh} new` : base);
    v.count.classList.toggle('has-new', fresh > 0);
  }

  // ---------- what's new ----------
  // Favourites feed (default once you have favourites) and the site's own "Новые выпуски".
  // "NEW" = released since you last opened that show (counting starts when you star it).

  const news = { tab: null, all: [], fav: [], loading: false, seen: store.get('seen', {}), newBySlug: {} };

  function maxEpisodeId(show) {
    return Math.max.apply(Math, [0].concat(flat(show.seasons.filter((s) => s.num != null).map((s) => s.episodes.map((e) => Number(e.id))))));
  }
  const isNew = (item) => state.favorites.has(item.slug) && news.seen[item.slug] !== undefined && Number(item.id) > news.seen[item.slug];
  const newIds = (slug) => (state.favorites.has(slug) && news.newBySlug[slug]) || [];
  const totalNew = () => Array.from(state.favorites).reduce((n, slug) => n + newIds(slug).length, 0);
  const saveSeen = () => store.set('seen', news.seen);

  function buildFavFeed() {
    const items = [];
    const newBySlug = {};
    for (const slug of state.favorites) {
      const show = getShow(slug);
      if (!show) continue;
      const eps = flat(show.seasons.filter((s) => s.num != null).map((s) => s.episodes));
      if (!eps.length) continue;
      if (news.seen[slug] === undefined) news.seen[slug] = maxEpisodeId(show); // new = from now on
      const fresh = eps.filter((e) => Number(e.id) > news.seen[slug]);
      newBySlug[slug] = fresh.map((e) => e.id);
      const shown = new Map(fresh.concat(eps.slice().sort((a, b) => b.id - a.id).slice(0, 4)).map((e) => [e.id, e]));
      for (const ep of shown.values()) {
        items.push({ slug, id: ep.id, showName: show.title, code: ep.code, label: ep.label, minutes: ep.minutes, image: ep.image });
      }
    }
    news.newBySlug = newBySlug;
    saveSeen();
    const isNewItem = (i) => (newBySlug[i.slug] || []).indexOf(i.id) !== -1;
    const newItems = items.filter(isNewItem);
    const others = items.filter((i) => !isNewItem(i)).sort((a, b) => b.id - a.id).slice(0, Math.max(0, 16 - newItems.length));
    return newItems.concat(others).sort((a, b) => b.id - a.id);
  }

  function rebuildNews() {
    news.all = (state.cat && state.cat.latest) || [];
    news.fav = buildFavFeed();
    renderNews();
  }

  let newsTimer = null;
  // ↻ and every 20 minutes: fetch the list again (it's rebuilt from u-tv.ru every few hours).
  async function refreshNews() {
    if (news.loading) return;
    news.loading = true;
    renderNews();
    try {
      const cat = await fetchCatalog();
      if (!state.cat || cat.generatedAt !== state.cat.generatedAt) {
        applyCatalog(cat);
        refreshCurrentView();
      }
    } catch (e) {
      toast(`Couldn't check for new episodes: ${friendlyError(e)}`);
    } finally {
      news.loading = false;
      rebuildNews();
    }
    clearTimeout(newsTimer);
    newsTimer = setTimeout(refreshNews, 20 * 60e3);
  }

  function refreshCurrentView() {
    if (!$('pickerView').hidden) renderShowList();
    else if (!$('showView').hidden && state.show) {
      const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.ep');
      const id = focused && focused.getAttribute('data-id');
      const show = getShow(state.show.slug);
      if (!show) return;
      const open = new Set(state.open);
      state.show = show;
      state.open = open;
      renderShow();
      setupFamily(show);
      if (id) focusEpisode(id, false);
    }
  }

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
    // Keep the remote's place when the list is redrawn.
    const focused = document.activeElement && $('newsList').contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused ? `${focused.closest('.news-item').getAttribute('data-id')}|${focused.className}` : null;
    $('newsList').replaceChildren.apply($('newsList'), items.map(newsItem));
    if (focusKey) {
      const [id, cls] = focusKey.split('|');
      const li = $('newsList').querySelector(`.news-item[data-id="${id}"]`);
      const again = li && (li.getElementsByClassName(cls.split(' ')[0])[0] || li.querySelector('button'));
      if (again) again.focus();
    }
    for (const slug of state.favorites) updateShowCard((state.shows || []).find((s) => s.slug === slug) || { slug });
  }

  function newsItem(item) {
    const { ep } = findEpisode(item.slug, item.id);
    const sub = [item.code || item.label, item.minutes ? `${item.minutes} min` : '', relDate(ep && ep.date)].filter(Boolean).join(' · ');
    const name = `${item.showName} ${item.code || item.label}`;
    const open = h('button', { type: 'button', class: 'news-text news-open', title: `Open ${name}`, onclick: () => goTo(item.slug, item.id) },
      h('span', { class: 'news-show' }, item.showName),
      h('span', { class: 'news-sub' }, sub, ep && watchedPct(ep.id) >= 100 ? h('span', { class: 'ok' }, ' · ✓ watched') : null));
    return h('li', { class: 'news-item', 'data-id': item.id, onclick: (e) => { if (e.target === e.currentTarget) open.click(); } },
      h('span', { class: 'news-thumb' }, item.image ? thumb(item.image, '') : null, isNew(item) ? h('span', { class: 'new' }, 'NEW') : null,
        playButton(() => watchNewsItem(item), `Watch ${name}`), posBar(ep)),
      open);
  }

  function watchNewsItem(item) {
    const { show, ep } = findEpisode(item.slug, item.id);
    if (!ep) { toast('That episode isn’t in the list yet. Try ↻ Refresh in a while.'); return; }
    watchEpisode(ep, show);
  }

  function markShowSeen(show) {
    if (news.seen[show.slug] === undefined && !state.favorites.has(show.slug)) return;
    const max = maxEpisodeId(show);
    if (max > (news.seen[show.slug] || 0) || newIds(show.slug).length) {
      news.seen[show.slug] = Math.max(max, news.seen[show.slug] || 0);
      news.newBySlug[show.slug] = [];
      saveSeen();
      renderNews();
    }
  }

  function markAllSeen() {
    for (const slug of state.favorites) {
      const ids = newIds(slug).map(Number);
      if (ids.length) news.seen[slug] = Math.max.apply(Math, [news.seen[slug] || 0].concat(ids));
      news.newBySlug[slug] = [];
    }
    saveSeen();
    renderNews();
  }

  // ---------- favourites ----------

  function toggleFavorite(slug) {
    if (state.favorites.has(slug)) {
      state.favorites.delete(slug);
      delete news.seen[slug]; // starring it again starts counting new episodes from then
      delete news.newBySlug[slug];
    } else {
      state.favorites.add(slug);
      const known = getShow(slug);
      if (known && news.seen[slug] === undefined) news.seen[slug] = maxEpisodeId(known);
    }
    store.set('favorites', Array.from(state.favorites));
    saveSeen();
    if (!$('pickerView').hidden) {
      const had = document.activeElement;
      renderShowList();
      if (had && had.classList && had.classList.contains('show-card')) focusFirst($('showList'));
    }
    updateShowStar();
    rebuildNews();
  }

  function updateShowStar() {
    const btn = $('favBtn');
    if (!state.show) return;
    const on = state.favorites.has(state.show.slug);
    btn.classList.toggle('on', on);
    setText(btn, on ? '★ Favourite' : '☆ Add to favourites');
    btn.title = on ? 'Remove from favourites' : 'Show this at the top of the show list';
  }

  // ---------- watched positions (continue where you stopped) ----------

  const positions = store.get('pos', {}); // episode id -> [seconds, duration, when]

  function watchedPct(id) {
    const p = positions[id];
    if (!p || !p[1]) return 0;
    return p[0] >= p[1] - 60 ? 100 : Math.floor((p[0] / p[1]) * 100);
  }

  function resumeAt(id) {
    const p = positions[id];
    return p && p[0] >= 30 && p[0] < p[1] - 60 ? p[0] : 0;
  }

  function savePosition(ep, t, dur) {
    if (!ep || !(dur > 0) || !(t > 0)) return;
    positions[ep.id] = [Math.floor(t), Math.floor(dur), Date.now()];
    const ids = Object.keys(positions);
    if (ids.length > 500) ids.sort((a, b) => positions[a][2] - positions[b][2]).slice(0, ids.length - 500).forEach((id) => { delete positions[id]; });
    store.set('pos', positions);
    const season = seasonOf(ep.id);
    if (season) { updateEpisodeRow(ep); updateSeasonHead(season); }
  }

  function posBar(ep) {
    const pct = ep ? watchedPct(ep.id) : 0;
    const bar = h('span', { class: 'ep-pos', hidden: !pct });
    bar.style.width = `${pct}%`;
    return bar;
  }

  // ---------- show page ----------

  function latestSeason(show) {
    const numbered = show.seasons.filter((s) => s.num != null);
    if (!numbered.length) return show.seasons[show.seasons.length - 1] || null;
    return numbered.reduce((a, b) => (b.num > a.num ? b : a));
  }

  function clearShow() {
    state.show = null;
    state.open.clear();
    view.seasons.clear();
    view.eps.clear();
    $('seasons').replaceChildren();
  }

  let pendingFocus = null;

  function loadShow(slug) {
    ++showLoadToken;
    const show = getShow(slug);
    if (!show) {
      showError(`“${slug}” isn't in the episode list. New shows appear after the next update.`, null);
      return;
    }
    if (!show.seasons.length) {
      showError(`“${show.title}” has no videos on u-tv.ru right now (it's an archive page).`, null);
      return;
    }
    clearShow();
    state.show = show;
    markShowSeen(show);
    $('searchInput').value = '';
    $('findInput').value = '';
    $('findResults').hidden = true;
    const latest = latestSeason(show);
    if (latest) state.open.add(latest.key);
    if (slugFromInput(new URLSearchParams(location.search).get('show') || '') !== show.slug) {
      history.replaceState(history.state, '', `?show=${encodeURIComponent(show.slug)}`);
    }
    updateTitle();
    renderShow();
    setView('show');
    window.scrollTo(0, 0);
    setupFamily(show);
    if (pendingFocus) {
      const id = pendingFocus;
      pendingFocus = null;
      focusEpisode(id, true);
    } else if (IS_TV || document.body.classList.contains('keys')) {
      const first = latest && view.eps.get(latest.episodes[0].id);
      if (first) first.play.focus();
    }
  }

  function seasonOf(epId) {
    return state.show && state.show.seasons.find((s) => s.episodes.some((e) => e.id === epId));
  }

  function renderShow() {
    const show = state.show;
    $('showTitle').textContent = show.title;
    $('showLink').href = showUrl(show.slug);
    updateShowStar();
    const listed = (state.shows || []).find((s) => realSlug(s.slug) === show.slug);
    const poster = (listed && listed.image) || show.image;
    $('showPoster').replaceChildren.apply($('showPoster'), poster ? [thumb(poster, '')] : []);
    $('showPoster').hidden = !poster;
    view.seasons.clear();
    view.eps.clear();
    $('seasons').replaceChildren.apply($('seasons'), show.seasons.map(buildSeason));
  }

  function buildSeason(season) {
    const watched = h('span', { class: 'muted small' });
    const best = h('span', { class: 'q' });
    const head = h('div', {
      class: 'season-head', role: 'button', tabindex: '0', 'aria-expanded': String(state.open.has(season.key)),
      onclick: () => toggleOpen(season),
    },
    h('span', { class: 'name' }, season.label),
    h('span', { class: 'muted small' }, `${season.episodes.length} ep.`),
    h('span', { class: 'meta' }, watched, best, h('span', { class: 'caret' }, '▸')));
    const root = h('div', { class: 'season' }, head);
    const v = { root, head, watched, best, list: null };
    view.seasons.set(season.key, v);
    if (state.open.has(season.key)) openList(season, v);
    updateSeasonHead(season);
    return root;
  }

  function openList(season, v) {
    v.list = h('ul', { class: 'episodes' }, season.episodes.map(buildEpisode));
    v.root.appendChild(v.list);
    v.root.classList.add('open');
    v.head.setAttribute('aria-expanded', 'true');
  }

  function closeList(season, v) {
    if (v.list) v.list.parentNode.removeChild(v.list);
    v.list = null;
    v.root.classList.remove('open');
    v.head.setAttribute('aria-expanded', 'false');
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
    }
  }

  function updateSeasonHead(season) {
    const v = view.seasons.get(season.key);
    if (!v) return;
    const seen = season.episodes.filter((e) => watchedPct(e.id) >= 100).length;
    setText(v.watched, seen ? `${seen} watched` : '');
    v.watched.hidden = !seen;
    const best = season.episodes.filter((e) => e.url).reduce((a, e) => (!a || e.height > a.height ? e : a), null);
    v.best.hidden = !best;
    if (best) {
      v.best.className = `q ${qClass(best.height)}`;
      setText(v.best, `up to ${qualityLabel(best.height)}`);
    }
  }

  function playButton(onPlay, label) {
    return h('button', {
      type: 'button', class: 'play-btn', title: 'Watch now', 'aria-label': label,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); onPlay(); },
    }, h('span', null, '▶'));
  }

  function buildEpisode(ep) {
    const meta = h('span', { class: 'dur' });
    const badge = h('span', { class: 'q' });
    const links = h('span', { class: 'ep-links', hidden: true });
    const title = h('span', { class: 'title' }, ep.label);
    const syn = h('span', { class: 'syn', hidden: true });
    const play = playButton(() => watchEpisode(ep, state.show), `Watch ${ep.code || ep.label}`);
    const pos = posBar(ep);
    const li = h('li', { class: 'ep', 'data-id': ep.id, onclick: () => watchEpisode(ep, state.show) },
      h('span', { class: 'thumb' }, ep.image ? thumb(ep.image, '') : null, play, pos),
      h('span', { class: 'code' }, ep.code || '—'),
      h('span', { class: 'title-cell' }, title, syn, links),
      meta,
      badge);
    view.eps.set(ep.id, { li, play, pos, meta, badge, links, title, syn });
    updateEpisodeRow(ep);
    return li;
  }

  function updateEpisodeRow(ep) {
    const v = view.eps.get(ep.id);
    if (!v) return;
    v.li.classList.toggle('blocked', ep.locked);
    let cls = 'q';
    let text = '';
    let title = '';
    if (ep.url) {
      cls = `q ${qClass(ep.height)}`;
      text = qualityLabel(ep.height);
      title = ep.width ? `Best available: ${ep.width}×${ep.height}` : '';
    } else if (ep.locked) {
      cls = 'q bad';
      text = 'Locked';
      title = 'u-tv.ru shows a region block for this episode';
    } else {
      cls = 'q bad';
      text = 'N/A';
      title = "The video couldn't be found when the list was last updated";
    }
    v.badge.className = cls;
    v.badge.title = title;
    setText(v.badge, text);
    const pct = watchedPct(ep.id);
    const p = positions[ep.id];
    v.pos.hidden = !pct;
    v.pos.style.width = `${pct}%`;
    setText(v.meta, [ep.minutes ? `${ep.minutes} min` : '', pct >= 100 ? '✓ watched' : pct && p ? `${fmtClock(p[0])} watched` : '']
      .filter(Boolean).join(' · '));
    renderSummary(ep, v);
    renderLinks(ep, v.links);
  }

  // "1 сезон 3 серия" says nothing the code column doesn't, so such rows lead with who the
  // episode is about (first sentence of the site's own description, full text on hover).
  const PLAIN_LABEL = /^\d+\s*сезон\s*\d+\s*серия$/i;
  function renderSummary(ep, v) {
    const line = ep.summary;
    if (!line) return;
    const full = (descs && descs[ep.id]) || line;
    if (PLAIN_LABEL.test(ep.label)) {
      setText(v.title, line);
      v.title.title = `${ep.label}\n\n${full}`;
    } else {
      setText(v.syn, line);
      v.syn.hidden = false;
      v.syn.title = full;
    }
  }

  function refreshShowView() {
    if (!state.show) return;
    for (const s of state.show.seasons) {
      updateSeasonHead(s);
      for (const ep of s.episodes) updateEpisodeRow(ep);
    }
  }

  // ---------- related shows (e.g. Чадо из ада ↔ Предки ↔ Новые испытания) ----------
  // The links are found when the list is built (by the names in the episode descriptions).

  const family = { ready: false, base: null, shows: new Map(), eps: new Map(), links: new Map(), reverse: new Map() };

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
    $('familyBar').hidden = true;
  }

  function renderFamilyBar(text) {
    const bar = $('familyBar');
    const chips = Array.from(family.shows.values()).map((s) => (state.show && s.slug === state.show.slug
      ? h('span', { class: 'fam-show current' }, spinName(s))
      : h('button', { type: 'button', class: 'fam-show', onclick: () => openShow(s.slug) }, spinName(s))));
    bar.replaceChildren(h('span', { class: 'fam-text' }, text), h('span', { class: 'fam-shows' }, chips));
    bar.hidden = false;
  }

  function setupFamily(show) {
    resetFamily();
    const base = baseTitle(show.title);
    const members = (state.shows || []).filter((s) => baseTitle(s.name) === base);
    if (!members.some((s) => realSlug(s.slug) === show.slug)) members.push({ slug: show.slug, name: show.title });
    const originalMeta = members.find((s) => s.name.trim().toLowerCase() === base);
    if (members.length < 2 || !originalMeta) return;
    const shows = [];
    for (const m of members) {
      const s = realSlug(m.slug) === show.slug ? show : getShow(m.slug);
      if (s && shows.indexOf(s) === -1) shows.push(s);
    }
    const original = shows.find((s) => s.slug === realSlug(originalMeta.slug));
    const spinoffs = shows.filter((s) => s !== original && s.seasons.length);
    if (!original || !original.seasons.some((s) => s.num != null) || !spinoffs.length) return;
    family.base = base;
    for (const s of [original].concat(spinoffs)) {
      family.shows.set(s.slug, s);
      for (const season of s.seasons) for (const ep of season.episodes) family.eps.set(ep.id, { ep, show: s });
    }
    const links = (state.cat && state.cat.links) || {};
    for (const s of spinoffs) {
      for (const season of s.seasons) {
        for (const ep of season.episodes) {
          const list = (links[ep.id] || []).map((l) => ({ originalId: l[0], confidence: l[1] ? 'medium' : 'high' }));
          if (!list.length) continue;
          family.links.set(ep.id, list);
          for (const l of list) {
            if (!family.reverse.has(l.originalId)) family.reverse.set(l.originalId, []);
            family.reverse.get(l.originalId).push(ep.id);
          }
        }
      }
    }
    family.ready = true;
    const n = family.links.size;
    renderFamilyBar(`${n} episode${n === 1 ? '' : 's'} linked to the original «${original.title}» by the people in them.`);
    refreshShowView();
  }

  // Link chips under an episode title.
  function renderLinks(ep, el) {
    const items = [];
    if (family.ready && family.eps.has(ep.id)) {
      for (const l of family.links.get(ep.id) || []) {
        const o = family.eps.get(l.originalId);
        if (o) items.push({ kind: 'from', target: o, probable: l.confidence !== 'high' });
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
    const key = JSON.stringify(items.map((i) => (i.kind === 'from' ? [i.target.ep.id, i.probable] : i.targets.map((t) => t.ep.id))));
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.hidden = !items.length;
    el.replaceChildren.apply(el, items.map((i) => {
      if (i.kind === 'from') {
        const label = `↩ ${i.probable ? 'probably ' : ''}from ${spinName(i.target.show)} ${i.target.ep.code || i.target.ep.label}`;
        return h('span', { class: 'link-item' }, h('button', {
          type: 'button', class: `link-chip${i.probable ? ' probable' : ''}`,
          title: i.probable ? 'Matched by a first name only — worth a quick check' : 'Same family (matched by name)',
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); goTo(i.target.show.slug, i.target.ep.id); },
        }, label, i.probable ? ' ?' : ''));
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

  function goTo(slug, id) {
    if (state.show && state.show.slug === realSlug(slug) && !$('showView').hidden) { focusEpisode(id, true); return; }
    openShow(slug, id);
  }

  function focusEpisode(id, flash) {
    const season = seasonOf(id);
    if (!season) return;
    if (!state.open.has(season.key)) toggleOpen(season);
    const v = view.eps.get(id);
    if (!v) return;
    v.play.focus({ preventScroll: true });
    v.li.scrollIntoView({ block: 'center' });
    if (!flash) return;
    v.li.classList.remove('flash');
    void v.li.offsetWidth; // restart the highlight animation
    v.li.classList.add('flash');
  }

  // "Find a name": searches the episode descriptions of this show (and its related shows).
  let descs = null;
  let descsLoading = null;
  function loadDescs() {
    if (!descsLoading) {
      descsLoading = fetch('descs.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
        .then((d) => { descs = d; refreshShowView(); });
    }
    return descsLoading;
  }

  // The name matcher is the extension's own (match.js); if a browser can't load it, plain text search still works.
  let matchLib = null;
  function loadMatcher() {
    if (!matchLib) {
      try {
        matchLib = new Function('u', 'return import(u)')('./match.js').catch(() => null);
      } catch (e) {
        matchLib = Promise.resolve(null);
      }
    }
    return matchLib;
  }

  let findTimer = null;
  let findSeq = 0;
  async function runFind() {
    const seq = ++findSeq;
    const q = $('findInput').value.trim();
    const list = $('findResults');
    if (q.length < 2 || !state.show) { list.hidden = true; list.replaceChildren(); return; }
    const scope = family.ready && family.shows.has(state.show.slug) ? Array.from(family.shows.values()) : [state.show];
    const eps = flat(scope.map((s) => flat(s.seasons.map((x) => x.episodes.map((ep) => ({ ep, show: s }))))));
    if (!descs) {
      list.replaceChildren(h('li', { class: 'muted small' }, 'Reading episode descriptions…'));
      list.hidden = false;
    }
    const lib = (await Promise.all([loadDescs(), loadMatcher()]))[1];
    if (seq !== findSeq) return;
    const needle = q.toLowerCase().replace(/ё/g, 'е');
    const wanted = lib ? q.split(/\s+/).filter((w) => w.length >= 3).map(lib.stem) : [];
    const hits = eps.filter(({ ep }) => {
      const text = `${ep.label} ${descs[ep.id] || ep.summary || ''}`;
      if (text.toLowerCase().replace(/ё/g, 'е').indexOf(needle) !== -1) return true;
      if (!wanted.length) return false;
      const found = lib.nameStems(text);
      return wanted.every((s) => found.has(s));
    });
    list.replaceChildren.apply(list, hits.length
      ? hits.slice(0, 40).map(({ ep, show }) => h('li', null, h('button', {
        type: 'button', class: 'find-hit', onclick: () => goTo(show.slug, ep.id),
      }, h('span', { class: 'find-show' }, spinName(show)), h('span', { class: 'find-code' }, ep.code || ''), h('span', { class: 'find-label' }, ep.label))))
      : [h('li', { class: 'muted small' }, `No episode mentions “${q}”.`)]);
    list.hidden = false;
  }

  // ---------- ▶ Watch ----------
  // The best variant straight from the video server (fixed 1080p, no adaptive dips). The browser's own
  // HLS support first (TVs, Safari, current Chrome); otherwise hls.js.

  const player = { ep: null, show: null, token: 0, hls: null, lastSave: 0, opener: null, autoFull: false };

  let hlsLoading = null;
  function loadHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!hlsLoading) {
      hlsLoading = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = HLS_JS;
        s.onload = () => resolve(window.Hls || null);
        s.onerror = () => { hlsLoading = null; resolve(null); };
        document.head.appendChild(s);
      });
    }
    return hlsLoading;
  }

  const nativeHls = (v) => !!(v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL'));

  function nextEpisode(ep, show) {
    const season = show.seasons.find((s) => s.episodes.indexOf(ep) !== -1);
    if (!season) return null;
    const i = season.episodes.indexOf(ep);
    return season.episodes.slice(i + 1).find((e) => e.url) || null;
  }

  function stopVideo() {
    const v = $('playerVideo');
    if (player.hls) { try { player.hls.destroy(); } catch (e) { /* gone */ } player.hls = null; }
    v.onerror = null;
    v.pause();
    v.removeAttribute('src');
    v.load();
  }

  function watchEpisode(ep, show) {
    if (!ep.url) {
      toast(ep.locked
        ? 'This episode is region-locked on u-tv.ru (the site shows a region block instead of the video).'
        : "This episode's video couldn't be found when the list was last updated.");
      return;
    }
    const token = ++player.token;
    savePlayerPosition();
    stopVideo();
    player.ep = ep;
    player.show = show;
    const v = $('playerVideo');
    const dlg = $('playerDlg');
    setText($('playerShow'), show.title);
    setText($('playerTitle'), ep.code ? `${ep.code} · ${ep.label}` : ep.label);
    const next = nextEpisode(ep, show);
    $('playerNext').hidden = !next;
    if (next) $('playerNext').title = `Next: ${next.code || next.label}`;
    $('playerCast').hidden = true;
    $('playerRestart').hidden = true;
    if (!dlg.open) {
      // Where to put the selection back on closing. A mouse click leaves nothing focused,
      // and closePlayer then falls back to this episode's ▶.
      const from = document.activeElement;
      player.opener = from && from !== document.body && from.tagName !== 'BODY' ? from : null;
      openDialog(dlg);
      history.pushState({ app: 1, player: 1 }, '', location.href);
      // Straight to the whole screen, which is what a TV is for. ⚙ can turn this off.
      // It has to happen here, while the press that started playback still counts as one.
      if (settings.full === 'on') enterFullscreen(true);
    }
    v.focus();
    const quality = qualityLabel(ep.height);
    const from = resumeAt(ep.id);
    setText($('playerNote'), 'Loading…');
    const started = () => {
      if (token !== player.token) return;
      setText($('playerNote'), from ? `${quality} · continuing at ${fmtClock(from)}` : `${quality} · streaming`);
      $('playerRestart').hidden = !from;
    };
    const failed = (why) => {
      if (token === player.token) setText($('playerNote'), `Couldn't play this episode: ${why}`);
    };
    const withHlsJs = () => loadHlsJs().then((Hls) => {
      if (token !== player.token) return;
      if (!Hls || !Hls.isSupported()) { failed("this browser can't play the stream"); return; }
      const hls = new Hls({ startPosition: from || -1, maxBufferLength: 60 });
      player.hls = hls;
      let recovered = false;
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (!data.fatal || token !== player.token) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { setText($('playerNote'), 'Connection problem, retrying…'); hls.startLoad(); }
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); }
        else failed(data.details || 'playback error');
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { const p = v.play(); if (p && p.catch) p.catch(() => {}); });
      hls.loadSource(ep.url);
      hls.attachMedia(v);
    });
    v.onplaying = started;
    if (nativeHls(v)) {
      v.onerror = () => {
        if (token !== player.token) return;
        v.onerror = null;
        if (window.MediaSource) withHlsJs(); else failed('the stream could not be opened');
      };
      if (from) v.addEventListener('loadedmetadata', function seek() { v.removeEventListener('loadedmetadata', seek); if (token === player.token) v.currentTime = from; });
      v.src = ep.url;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      withHlsJs();
    }
    // Cast button only when the browser sees a Cast device (Chromecast / Google TV) on the network.
    if (v.remote && v.remote.watchAvailability) {
      v.remote.cancelWatchAvailability().catch(() => {});
      v.remote.watchAvailability((available) => { if (token === player.token) $('playerCast').hidden = !available; }).catch(() => {});
    }
  }

  function savePlayerPosition() {
    const v = $('playerVideo');
    if (player.ep && v.currentTime > 0) savePosition(player.ep, v.currentTime, v.duration);
  }

  // Closing goes through history when the player added an entry, so the TV's Back button and ✕ do the same.
  function closePlayerUI() {
    if (history.state && history.state.player) history.back();
    else closePlayer();
  }

  function closePlayer() {
    savePlayerPosition();
    player.token++;
    stopVideo();
    const leaving = exitFullscreen();
    closeDialog($('playerDlg'));
    const back = player.opener;
    player.opener = null;
    const row = player.ep && view.eps.get(player.ep.id);
    const target = back && back.isConnected ? back : row ? row.play : null;
    // Leaving full screen and closing the dialog can both move the focus after we set it,
    // so put the selection back once more when nothing else has taken it.
    const restore = (force) => {
      if (!target || !target.isConnected) return;
      if (!force && document.activeElement && document.activeElement !== document.body) return;
      target.focus({ preventScroll: true });
    };
    restore(true);
    if (leaving && leaving.then) leaving.then(() => restore(false), () => restore(false));
    setTimeout(() => restore(false), 120);
    rebuildNews(); // ✓ watched marks
  }

  function togglePlay() {
    const v = $('playerVideo');
    if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause();
  }

  function seekBy(sec) {
    const v = $('playerVideo');
    if (!(v.duration > 0)) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 1, v.currentTime + sec));
    setText($('playerNote'), `${sec > 0 ? '⏩' : '⏪'} ${fmtClock(v.currentTime)} / ${fmtClock(v.duration)}`);
  }

  // Some TV browsers refuse the fullscreen API. Filling the page is the same thing there,
  // because on a TV the browser already covers the whole screen.
  let pageFull = false;
  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || (pageFull ? $('playerVideo') : null);

  function setPageFull(on) {
    pageFull = on;
    document.body.classList.toggle('page-full', on);
    $('playerDlg').classList.toggle('page-full', on);
  }

  function exitFullscreen() {
    if (pageFull) { setPageFull(false); return null; }
    if (!document.fullscreenElement && !document.webkitFullscreenElement) return null;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return null;
    try {
      const p = exit.call(document);
      if (p && p.catch) p.catch(() => {});
      return p;
    } catch (e) {
      return null;
    }
  }
  // `auto` marks the full screen we entered ourselves on play: Back then leaves the episode in one
  // press instead of first uncovering a panel nobody asked for.
  function enterFullscreen(auto) {
    if (fullscreenElement()) return;
    const v = $('playerVideo');
    const go = v.requestFullscreen || v.webkitRequestFullscreen || v.webkitEnterFullscreen;
    player.autoFull = !!auto;
    if (!go) { setPageFull(true); return; } // no fullscreen API: fill the page instead
    try {
      const p = go.call(v);
      if (p && p.catch) p.catch(() => { if (!fullscreenElement()) setPageFull(true); });
    } catch (e) {
      setPageFull(true);
    }
  }

  function toggleFullscreen() {
    if (fullscreenElement()) exitFullscreen();
    else enterFullscreen(false);
  }

  async function castPlayer() {
    try {
      await $('playerVideo').remote.prompt();
    } catch (e) {
      toast(e && e.name === 'NotFoundError' ? 'No Cast-capable TV found on your network' : `Couldn't cast: ${friendlyError(e)}`);
    }
  }

  // ---------- dialogs (with a fallback for browsers without <dialog>) ----------

  function openDialog(d) {
    if (d.open) return;
    if (typeof d.showModal === 'function') { d.showModal(); return; }
    d.classList.add('no-modal');
    d.setAttribute('open', '');
    if (!$('dlgShade')) document.body.appendChild(h('div', { id: 'dlgShade', onclick: () => backAction() }));
  }

  function closeDialog(d) {
    if (!d.open) return;
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
    const shade = $('dlgShade');
    if (shade && !document.querySelector('dialog[open]')) shade.parentNode.removeChild(shade);
  }

  const openDialogEl = () => document.querySelector('dialog[open]');

  // ---------- settings (⚙): theme, full screen on play ----------

  const SETTINGS = { theme: ['system', 'light', 'dark'], full: ['on', 'off'] };
  const settings = { theme: 'system', full: 'on' };

  function loadSettings() {
    // The theme lives under its own key, because theme.js reads it before the page paints.
    try {
      const t = localStorage.getItem('theme');
      if (SETTINGS.theme.indexOf(t) !== -1) settings.theme = t;
    } catch (e) { /* system theme */ }
    const f = store.get('full', 'on');
    if (SETTINGS.full.indexOf(f) !== -1) settings.full = f;
    applySettings();
  }

  function applySettings() {
    const theme = settings.theme;
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('theme', theme); } catch (e) { /* theme.js falls back to the system */ }
    document.querySelectorAll('[data-set]').forEach((b) => {
      const on = settings[b.dataset.set] === b.dataset.val;
      b.classList.toggle('on', on);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
    });
  }

  function setSetting(key, value) {
    if (!SETTINGS[key] || SETTINGS[key].indexOf(value) === -1) return;
    settings[key] = value;
    if (key === 'full') store.set('full', value);
    applySettings();
  }

  function openSettings() {
    const cat = state.cat;
    if (cat) {
      const eps = Object.keys(cat.details).reduce((n, k) => n + cat.details[k].seasons.reduce((m, s) => m + s.eps.length, 0), 0);
      const when = new Date(cat.generatedAt);
      const mins = Math.round((Date.now() - when.getTime()) / 60000);
      const ago = mins < 60 ? `${Math.max(1, mins)} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : when.toLocaleDateString();
      setText($('catalogNote'), `${cat.shows.length} shows, ${eps} episodes, read from u-tv.ru ${ago}. It's refreshed every few hours; ↻ Refresh picks up the newest.`);
    }
    openDialog($('settingsDlg'));
    const on = document.querySelector('#settingsDlg .seg-btn.on');
    if (on) on.focus();
  }

  // ---------- page address and back button ----------

  function openShow(slug, focusId) {
    history.pushState({ app: 1 }, '', `?show=${encodeURIComponent(realSlug(slug))}`);
    pendingFocus = focusId || null;
    loadShow(slug);
  }

  function goPicker() {
    if (history.state && history.state.app) history.back(); // back to where "All shows" was
    else {
      history.replaceState(null, '', location.pathname);
      openPicker();
    }
  }

  function route() {
    const slug = slugFromInput(new URLSearchParams(location.search).get('show') || '');
    if (slug) {
      if (!state.show || state.show.slug !== realSlug(slug) || $('showView').hidden) loadShow(slug);
    } else if ($('pickerView').hidden) {
      const from = state.show && state.show.slug;
      openPicker();
      if (from) {
        const card = Array.from($('showList').querySelectorAll('.show-card')).find((c) => {
          const v = Array.from(showCardViews.entries()).find((x) => x[1].card === c);
          return v && realSlug(v[0]) === from;
        });
        if (card && (IS_TV || document.body.classList.contains('keys'))) { card.focus({ preventScroll: true }); card.scrollIntoView({ block: 'center' }); }
      }
    }
  }

  window.addEventListener('popstate', () => {
    if ($('playerDlg').open && !(history.state && history.state.player)) closePlayer();
    if (!state.cat) return;
    route();
  });

  // Back / Esc: close what's on top, else leave the show. Returns true when it did something.
  function backAction() {
    if ($('playerDlg').open) {
      // Full screen we opened ourselves is just how the episode plays, so Back leaves the episode.
      // Full screen the viewer asked for goes back to the player panel first.
      if (fullscreenElement() && !player.autoFull) exitFullscreen();
      else closePlayerUI();
      return true;
    }
    if ($('settingsDlg').open) { closeDialog($('settingsDlg')); $('settingsBtn').focus(); return true; }
    if (!$('findResults').hidden && document.activeElement && $('showView').contains(document.activeElement) && $('findInput').value) {
      $('findInput').value = '';
      $('findResults').hidden = true;
      $('findInput').focus();
      return true;
    }
    if (!$('showView').hidden || !$('errorView').hidden) { goPicker(); return true; }
    if (!$('pickerView').hidden && $('searchInput').value) {
      $('searchInput').value = '';
      renderShowList();
      return true;
    }
    return false;
  }

  // ---------- remote control: arrows move between things on screen ----------

  const KEYCODES = {
    37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter', 27: 'Escape', 8: 'Backspace',
    461: 'Back', 10009: 'Back', 415: 'Play', 19: 'Pause', 179: 'PlayPause', 413: 'Stop', 417: 'FastForward', 412: 'Rewind',
  };
  const KEYNAMES = {
    Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Esc: 'Escape', GoBack: 'Back', BrowserBack: 'Back',
    MediaPlayPause: 'PlayPause', MediaPlay: 'Play', MediaPause: 'Pause', MediaStop: 'Stop', MediaFastForward: 'FastForward',
    MediaRewind: 'Rewind', MediaTrackNext: 'FastForward', MediaTrackPrevious: 'Rewind',
  };
  function keyOf(e) {
    if (KEYCODES[e.keyCode] && (!e.key || e.key === 'Unidentified' || e.keyCode > 400)) return KEYCODES[e.keyCode];
    return KEYNAMES[e.key] || e.key;
  }

  const DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const isTyping = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|checkbox|radio)$/i.test(el.type)));

  function focusables(scope) {
    const all = scope.querySelectorAll('button, a[href], input, [tabindex="0"], video');
    const inDialog = scope !== document;
    return Array.prototype.filter.call(all, (el) => {
      if (el.disabled || el.getAttribute('tabindex') === '-1') return false;
      if (!inDialog && el.closest('dialog')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function focusEl(el) {
    el.focus({ preventScroll: true });
    const r = el.getBoundingClientRect();
    const top = $('playerDlg').open || $('settingsDlg').open ? 0 : 70; // the header stays on top
    if (r.top < top || r.bottom > window.innerHeight - 8) el.scrollIntoView({ block: 'center' });
    const side = $('side');
    if (side.contains(el)) {
      const s = side.getBoundingClientRect();
      if (r.top < s.top || r.bottom > s.bottom) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function focusFirst(container) {
    const first = focusables(container)[0];
    if (first) focusEl(first);
  }

  // Picks the nearest thing in that direction: straight ahead first, then the closest line up.
  function moveFocus(dir) {
    const scope = openDialogEl() || document;
    const items = focusables(scope);
    const cur = document.activeElement;
    if (!cur || cur === document.body || items.indexOf(cur) === -1) {
      const visible = items.filter((el) => { const r = el.getBoundingClientRect(); return r.top >= 60 && r.bottom <= window.innerHeight; });
      const pick = visible.find((el) => $('browsePane').contains(el) && !el.closest('.search')) || visible[0] || items[0];
      if (pick) focusEl(pick);
      return;
    }
    const r = cur.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const pick = (strict) => {
      let best = null;
      let bestScore = Infinity;
      for (const el of items) {
        if (el === cur || el.contains(cur) || cur.contains(el)) continue;
        const c = el.getBoundingClientRect();
        const ex = (c.left + c.right) / 2;
        const ey = (c.top + c.bottom) / 2;
        let ahead;
        let side;
        if (dir === 'down') { if (strict ? c.top < r.bottom - 2 : ey <= cy + 1) continue; ahead = Math.max(0, c.top - r.bottom); side = Math.max(0, c.left - r.right, r.left - c.right); }
        else if (dir === 'up') { if (strict ? c.bottom > r.top + 2 : ey >= cy - 1) continue; ahead = Math.max(0, r.top - c.bottom); side = Math.max(0, c.left - r.right, r.left - c.right); }
        else if (dir === 'right') { if (strict ? c.left < r.right - 2 : ex <= cx + 1) continue; ahead = Math.max(0, c.left - r.right); side = Math.max(0, c.top - r.bottom, r.top - c.bottom); }
        else { if (strict ? c.right > r.left + 2 : ex >= cx - 1) continue; ahead = Math.max(0, r.left - c.right); side = Math.max(0, c.top - r.bottom, r.top - c.bottom); }
        // How far off the current line it is (0 if it's within the selected thing's width/height);
        // ties go to the left / top one, so leaving a wide search box lands on the first card.
        const drift = dir === 'up' || dir === 'down'
          ? Math.max(0, r.left - ex, ex - r.right) + c.left * 0.001
          : Math.max(0, r.top - ey, ey - r.bottom) + c.top * 0.001;
        const score = ahead + side * 3 + drift * 0.15;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      return best;
    };
    const next = pick(true) || pick(false);
    if (next) focusEl(next);
  }

  function onKey(e) {
    const key = keyOf(e);
    const el = document.activeElement;
    const typing = isTyping(el);
    if (DIRS[key]) document.body.classList.add('keys');

    // Player: OK pauses, ◀ ▶ skip, media keys work.
    if ($('playerDlg').open) {
      const onVideo = el === $('playerVideo') || el === document.body || el === $('playerDlg');
      const map = {
        Play: () => togglePlay(), Pause: () => $('playerVideo').pause(), PlayPause: togglePlay, Stop: closePlayerUI,
        FastForward: () => seekBy(30), Rewind: () => seekBy(-30), f: toggleFullscreen, F: toggleFullscreen,
      };
      if (onVideo) {
        map.Enter = togglePlay;
        map[' '] = togglePlay;
        map.ArrowLeft = () => seekBy(-10);
        map.ArrowRight = () => seekBy(10);
      }
      if (fullscreenElement()) { map.ArrowUp = () => seekBy(60); map.ArrowDown = () => seekBy(-60); }
      if (map[key]) {
        // The page runs first (capture), so the video's own controls don't also jump on the same key.
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.add('keys');
        map[key]();
        return;
      }
    }

    if (key === 'Back' || key === 'Escape' || (key === 'Backspace' && !typing)) {
      if (backAction()) e.preventDefault();
      return;
    }
    if (DIRS[key]) {
      if (typing && (key === 'ArrowLeft' || key === 'ArrowRight')) return; // move the cursor in the text
      e.preventDefault();
      moveFocus(DIRS[key]);
      return;
    }
    // OK presses whatever is selected. Done here rather than left to the browser: some TV browsers
    // send only the key, without turning it into a click.
    const pressable = el && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button');
    if (pressable && (key === 'Enter' || (key === ' ' && el.tagName !== 'BUTTON' && el.tagName !== 'A'))) {
      e.preventDefault();
      el.click();
    }
  }

  // ---------- wiring ----------

  function updateTitle() {
    const title = state.show ? `${state.show.title} — U-TV Downloader` : 'U-TV Downloader';
    if (document.title !== title) document.title = title;
  }

  async function start() {
    setView('loading', 'Loading shows…');
    try {
      applyCatalog(await fetchCatalog());
    } catch (e) {
      showError(`Couldn't load the show list: ${friendlyError(e)}`, start);
      return;
    }
    rebuildNews();
    if (history.state && history.state.player) history.replaceState({ app: 1 }, '', location.href); // reloaded with the player open
    route();
    clearTimeout(newsTimer);
    newsTimer = setTimeout(refreshNews, 20 * 60e3);
  }

  function init() {
    $('searchInput').addEventListener('input', renderShowList);
    $('searchInput').addEventListener('keydown', (e) => {
      if (keyOf(e) !== 'Enter') return;
      const first = $('showList').querySelector('.show-card');
      if (first) first.click();
    });
    $('findInput').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 250); });
    $('backBtn').addEventListener('click', goPicker);
    $('errorBackBtn').addEventListener('click', goPicker);
    $('retryBtn').addEventListener('click', () => retryAction && retryAction());
    $('favBtn').addEventListener('click', () => state.show && toggleFavorite(state.show.slug));

    // Player
    const v = $('playerVideo');
    $('playerClose').addEventListener('click', closePlayerUI);
    $('playerDlg').addEventListener('cancel', (e) => { e.preventDefault(); backAction(); }); // Esc
    $('playerDlg').addEventListener('click', (e) => { if (e.target === $('playerDlg')) closePlayerUI(); });
    $('playerCast').addEventListener('click', castPlayer);
    $('playerFull').addEventListener('click', toggleFullscreen);
    $('playerRestart').addEventListener('click', () => { v.currentTime = 0; $('playerRestart').hidden = true; v.focus(); });
    $('playerNext').addEventListener('click', () => {
      const next = player.ep && nextEpisode(player.ep, player.show);
      if (next) watchEpisode(next, player.show);
    });
    v.addEventListener('dblclick', toggleFullscreen);
    v.addEventListener('timeupdate', () => {
      if (Date.now() - player.lastSave < 5000) return;
      player.lastSave = Date.now();
      savePlayerPosition();
    });
    v.addEventListener('pause', savePlayerPosition);
    v.addEventListener('ended', () => {
      if (!player.ep) return;
      savePosition(player.ep, v.duration, v.duration);
      const next = nextEpisode(player.ep, player.show);
      if (next) { toast(`Next: ${next.code || next.label}`); watchEpisode(next, player.show); }
    });

    // Settings
    $('settingsBtn').addEventListener('click', openSettings);
    $('settingsDlg').addEventListener('submit', (e) => { e.preventDefault(); closeDialog($('settingsDlg')); $('settingsBtn').focus(); });
    $('settingsDlg').addEventListener('click', (e) => { if (e.target === $('settingsDlg')) closeDialog($('settingsDlg')); });
    $('settingsDlg').addEventListener('cancel', (e) => { e.preventDefault(); backAction(); });
    document.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => setSetting(b.dataset.set, b.dataset.val)));
    loadSettings();
    // Leaving full screen any other way (the video's own button, the TV's) makes Back behave normally again.
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.addEventListener(ev, () => { if (!fullscreenElement()) player.autoFull = false; });
    }

    // What's new
    document.querySelectorAll('[data-news]').forEach((b) => b.addEventListener('click', () => {
      news.tab = b.dataset.news;
      renderNews();
    }));
    $('newsRefresh').addEventListener('click', refreshNews);
    $('newsSeen').addEventListener('click', markAllSeen);

    // Keyboard and TV remote
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', () => document.body.classList.remove('keys'));
    // "/" jumps to the search box that's on screen
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement) || openDialogEl()) return;
      const box = !$('pickerView').hidden ? $('searchInput') : !$('showView').hidden ? $('findInput') : null;
      if (box) { e.preventDefault(); box.focus(); box.select(); }
    });
    if (IS_TV) document.body.classList.add('keys');

    start();
  }

  init();
}());
