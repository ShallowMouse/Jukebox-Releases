/* Jukebox — renderer */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const sortKey = (s) => String(s || '').replace(/^(the|a|an)\s+/i, '').trim().toLowerCase();
const letterOf = (s) => { const c = sortKey(s).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
const initials = (s) => String(s || '?').replace(/^(the)\s+/i, '').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const TAB_NAMES = { server: 'Server', local: 'Local', youtube: 'YouTube Music' };

const S = {
  cfg: null,
  tab: 'server',
  view: { server: 'strips', local: 'strips' },
  artistFilter: { server: null, local: null },
  albums: { server: null, local: null },
  loading: { server: false, local: false },
  results: { server: null, local: null, youtube: null },
  query: { server: '', local: '', youtube: '' },
  queue: [],
  current: null,
  kind: null,            // 'audio' | 'yt'
  playing: false,
  pos: 0, dur: 0,
  ytAd: false,
  ytLastProgressAt: 0,
  lastYtId: null,
  advancing: false,
  lastTouch: Date.now(),
  albumOpen: null,
  update: { state: 'idle', kind: 'dev' },
};

const audio = new Audio();
audio.preload = 'auto';

/* ====================================================== sources */
const SRC = {
  server: {
    ready: () => S.cfg.jellyfin.connected,
    albums: () => jb.jf.albums(), tracks: (id) => jb.jf.albumTracks(id),
    search: (q) => jb.jf.search(q), random: (n) => jb.jf.random(n),
    setupMsg: 'Connect your Jellyfin server in Settings to browse your music library.',
  },
  local: {
    ready: () => S.cfg.localFolders.length > 0,
    albums: () => jb.local.albums(), tracks: (id) => jb.local.albumTracks(id),
    search: (q) => jb.local.search(q), random: (n) => jb.local.random(n),
    setupMsg: 'Add a music folder in Settings — a local drive, USB stick or mapped network share.',
  },
  youtube: {
    ready: () => S.cfg.youtube.enabled,
    search: (q) => jb.yt.search(q),
    setupMsg: 'YouTube Music is turned off in Settings.',
  },
};

/* ====================================================== toasts */
function toast(msg, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

/* ====================================================== header / tabs */
function renderTabs() {
  $$('#tabs button').forEach(b => {
    b.classList.toggle('on', b.dataset.tab === S.tab);
    b.classList.toggle('off', !SRC[b.dataset.tab].ready());
  });
  $('#searchBtn').lastChild.textContent = S.tab === 'youtube' ? 'Search YouTube Music' : `Search ${TAB_NAMES[S.tab]}`;
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  setTab(b.dataset.tab);
});
function setTab(t) {
  S.tab = t;
  renderTabs();
  renderBrowse();
  if ((t === 'server' || t === 'local') && SRC[t].ready() && !S.albums[t]) loadAlbums(t);
  if (t === 'youtube' && SRC.youtube.ready() && !S.results.youtube) openSearch();
}

function tickClock() {
  const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('#clock').textContent = t; $('#idleClock').textContent = t;
}
setInterval(tickClock, 5000);

/* ====================================================== browse */
async function loadAlbums(src, force) {
  if (S.loading[src] || (S.albums[src] && !force)) return;
  S.loading[src] = true; renderBrowse();
  try {
    const list = await SRC[src].albums();
    list.sort((a, b) => sortKey(a.artist).localeCompare(sortKey(b.artist)) || String(a.year).localeCompare(String(b.year)) || sortKey(a.title).localeCompare(sortKey(b.title)));
    const per = {};
    for (const a of list) { const L = letterOf(a.artist); per[L] = (per[L] || 0) + 1; a.code = L + per[L]; }
    S.albums[src] = list;
  } catch (e) {
    S.albums[src] = null;
    toast(`Couldn't load ${TAB_NAMES[src]} library: ${e.message || e}`, true);
  }
  S.loading[src] = false;
  if (S.tab === src) renderBrowse();
}

function artHTML(url, label) {
  return url ? `<img loading="lazy" src="${esc(url)}" alt="" data-ph="${esc(initials(label))}">` : `<div class="ph">${esc(initials(label))}</div>`;
}
// swap broken images for a placeholder
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || img.dataset.failed) return;
  img.dataset.failed = 1;
  if (img.closest('.art')) { const d = document.createElement('div'); d.className = 'ph'; d.textContent = img.dataset.ph || '♪'; img.replaceWith(d); }
  else img.style.visibility = 'hidden';
}, true);

function emptyState(big, msg, btn) {
  return `<div class="empty"><div class="big">${esc(big)}</div><p>${esc(msg)}</p>${btn || ''}</div>`;
}

function trackRow(t, i) {
  const q = isQueued(t) ? ' queued' : '';
  return `<button class="row${q}" data-track="${i}">
    ${t.art ? `<img loading="lazy" src="${esc(t.art)}" alt="">` : '<div class="ph">♪</div>'}
    <div class="meta"><div class="t1">${esc(t.title)}</div><div class="t2">${esc([t.artist, t.album].filter(Boolean).join(' · '))}</div></div>
    <span class="dur">${t.duration ? fmt(t.duration) : ''}</span>
    <span class="add">${q ? '✓' : '+'}</span></button>`;
}
function albumCard(a, i, letter) {
  return `<button class="card" data-album="${i}" ${letter ? `data-letter="${letter}"` : ''}>
    <div class="art">${artHTML(a.art, a.title)}</div>
    <div class="t1">${esc(a.title)}</div><div class="t2">${esc(a.artist)}${a.year ? ' · ' + esc(a.year) : ''}</div></button>`;
}

const BANDS = ['#b4232b', '#1f4e8c', '#2f6e45', '#262626', '#c0601c', '#6b2d7b', '#1f7a7a', '#8a5a18'];
function bandFor(s) { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return BANDS[h % BANDS.length]; }
function codeFor(a) {
  if (a.code) return a.code;
  const lib = S.albums[a.source]; const m = lib && lib.find(x => x.id === a.id);
  return m ? m.code : '';
}
function stripCard(a, i, letter) {
  const code = codeFor(a);
  return `<button class="strip" data-album="${i}" ${letter ? `data-letter="${letter}"` : ''} style="--band:${bandFor(a.artist)}">
    <div class="s-top">${code ? `<span class="code">${esc(code)}</span>` : ''}<span class="s-title">${esc(a.title)}</span></div>
    <div class="band">${esc(a.artist)}</div>
    <div class="s-bot">${a.year ? 'Released ' + esc(a.year) : 'Long Player'}</div></button>`;
}
let rowTracks = [];   // tracks currently rendered as rows (index -> track)
let gridAlbums = [];  // albums currently rendered as cards
let gridArtists = [];
let gridYArtists = [];

function renderBrowse() {
  const src = S.tab, bar = $('#browseBar'), sc = $('#scroller'), az = $('#az');
  rowTracks = []; gridAlbums = []; gridArtists = []; gridYArtists = [];
  az.innerHTML = ''; az.hidden = true;
  const ready = SRC[src].ready();

  if (!ready) {
    bar.innerHTML = `<span class="browse-title">${TAB_NAMES[src]}</span>`;
    sc.innerHTML = emptyState('Not set up yet', SRC[src].setupMsg, '<button class="big-btn primary" data-act="settings">Open Settings</button>');
    return;
  }

  // search results
  const res = S.results[src];
  if (res) {
    bar.innerHTML = `<span class="browse-title">Results</span><button class="chip on" data-act="clear-search">“${esc(S.query[src])}” &nbsp;×</button>
      <button class="chip" data-act="search">New search</button>`;
    let html = '';
    if (res.loading) html = `<div class="empty"><div class="spinner"></div><p>Searching ${TAB_NAMES[src]}…</p></div>`;
    else if (res.error) html = emptyState('Search failed', res.error);
    else {
      if (res.artists && res.artists.length) {
        gridYArtists = res.artists;
        html += `<div class="section-head">Artists</div><div class="artist-row">${res.artists.map((a, i) => `<button class="artist-card" data-yartist="${i}">
          <div class="pic">${a.art ? `<img loading="lazy" src="${esc(a.art)}" alt="">` : ''}</div><div class="t1">${esc(a.name)}</div><div class="t2">${esc(a.subscribers || 'Artist')}</div></button>`).join('')}</div>`;
      }
      if (res.albums && res.albums.length) {
        gridAlbums = res.albums;
        html += `<div class="section-head">Records</div><div class="strips">${res.albums.map((a, i) => stripCard(a, i)).join('')}</div>`;
      }
      if (res.tracks && res.tracks.length) {
        rowTracks = res.tracks;
        html += `<div class="section-head">Songs</div><div class="rows">${res.tracks.map(trackRow).join('')}</div>`;
      }
      if (!html) html = emptyState('No matches', `Nothing on ${TAB_NAMES[src]} matched “${S.query[src]}”. Try fewer words.`, '<button class="big-btn primary" data-act="search">Search again</button>');
    }
    sc.innerHTML = html; sc.scrollTop = 0;
    return;
  }

  if (src === 'youtube') {
    bar.innerHTML = `<span class="browse-title">YouTube Music</span>`;
    const recent = LS.get('recent:youtube', []);
    sc.innerHTML = emptyState('Any song, any artist', 'Search the whole YouTube Music catalogue and add songs to the queue.',
      `<button class="big-btn primary" data-act="search">Search YouTube Music</button>
       ${recent.length ? `<div class="suggest" style="justify-content:center">${recent.map(r => `<button class="chip" data-q="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}`);
    return;
  }

  // library: albums / artists
  if (S.loading[src] || !S.albums[src]) {
    bar.innerHTML = `<span class="browse-title">${TAB_NAMES[src]}</span>`;
    sc.innerHTML = `<div class="empty"><div class="spinner"></div><p>Loading library…</p></div>`;
    return;
  }
  const all = S.albums[src];
  const view = S.view[src], af = S.artistFilter[src];
  bar.innerHTML = af
    ? `<button class="chip" data-act="artist-back">‹ All artists</button><span class="browse-title" style="margin-left:.4rem">${esc(af)}</span>`
    : `<button class="chip ${view === 'strips' ? 'on' : ''}" data-view="strips">Title Strips</button>
       <button class="chip ${view === 'sleeves' ? 'on' : ''}" data-view="sleeves">Sleeves</button>
       <button class="chip ${view === 'artists' ? 'on' : ''}" data-view="artists">Artists</button>
       <button class="chip" data-act="shuffle">⤮ Surprise me</button>
       <span class="browse-count">${all.length} records</span>`;

  if (!all.length) {
    sc.innerHTML = emptyState('No albums yet', src === 'local' ? 'Your folders have no music in them yet, or need a rescan (Settings → Rescan).' : 'Your Jellyfin server returned no music albums.');
    return;
  }

  let html = '', letters = new Set(), lastLetter = null;
  if (view === 'artists' && !af) {
    const map = new Map();
    for (const a of all) { const k = a.artist; if (!map.has(k)) map.set(k, { name: k, art: a.art, count: 0 }); const m = map.get(k); m.count++; if (!m.art) m.art = a.art; }
    gridArtists = [...map.values()].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
    html = `<div class="strips">${gridArtists.map((a, i) => {
      const L = letterOf(a.name); let attr = ''; if (L !== lastLetter) { attr = `data-letter="${L}"`; lastLetter = L; letters.add(L); }
      return `<button class="strip" data-artist="${i}" ${attr} style="--band:${bandFor(a.name)}"><div class="s-top"><span class="code">${L}</span><span class="s-title">Selections by</span></div>
        <div class="band">${esc(a.name)}</div><div class="s-bot">${a.count} record${a.count > 1 ? 's' : ''}</div></button>`;
    }).join('')}</div>`;
  } else {
    gridAlbums = af ? all.filter(a => a.artist === af) : all;
    const cardFn = view === 'sleeves' ? albumCard : stripCard;
    html = `<div class="${view === 'sleeves' ? 'grid' : 'strips'}">${gridAlbums.map((a, i) => {
      const L = letterOf(a.artist); let attr = null; if (!af && L !== lastLetter) { attr = L; lastLetter = L; letters.add(L); }
      return cardFn(a, i, attr);
    }).join('')}</div>`;
  }
  sc.innerHTML = html;
  sc.scrollTop = 0;
  if (!af) {
    az.hidden = false;
    az.innerHTML = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(L => `<button data-l="${L}" class="${letters.has(L) ? 'has' : ''}">${L}</button>`).join('');
  }
}

$('#browse').addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const src = S.tab;
  if (t.dataset.view) { S.view[src] = t.dataset.view; renderBrowse(); return; }
  if (t.dataset.album !== undefined) { openAlbum(gridAlbums[+t.dataset.album]); return; }
  if (t.dataset.yartist !== undefined) { openArtist(gridYArtists[+t.dataset.yartist]); return; }
  if (t.dataset.artist !== undefined) { S.artistFilter[src] = gridArtists[+t.dataset.artist].name; renderBrowse(); return; }
  if (t.dataset.track !== undefined) { addToQueue(rowTracks[+t.dataset.track]); refreshQueuedMarks(); return; }
  if (t.dataset.q) { runSearch(t.dataset.q); return; }
  switch (t.dataset.act) {
    case 'settings': openSettings(); break;
    case 'search': openSearch(); break;
    case 'clear-search': S.results[src] = null; S.query[src] = ''; renderBrowse(); if (src !== 'youtube' && !S.albums[src]) loadAlbums(src); break;
    case 'artist-back': S.artistFilter[src] = null; renderBrowse(); break;
    case 'shuffle': {
      try { const tr = await SRC[src].random(1); if (tr[0]) addToQueue(tr[0]); } catch (err) { toast('Shuffle failed: ' + err.message, true); }
      break;
    }
  }
});

// A–Z rail: tap or drag
function jumpTo(L) {
  const letters = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let target = null;
  for (let i = letters.indexOf(L); i < letters.length && !target; i++) target = $(`#scroller [data-letter="${letters[i]}"]`);
  if (target) { $('#scroller').style.scrollBehavior = 'auto'; $('#scroller').scrollTop = target.offsetTop - $('#scroller').offsetTop - 12; $('#scroller').style.scrollBehavior = ''; }
  $$('#az button').forEach(b => b.classList.toggle('hit', b.dataset.l === L));
}
let azDrag = false;
$('#az').addEventListener('pointerdown', (e) => { azDrag = true; $('#az').setPointerCapture(e.pointerId); const b = e.target.closest('button'); if (b) jumpTo(b.dataset.l); });
$('#az').addEventListener('pointermove', (e) => { if (!azDrag) return; const el = document.elementFromPoint($('#az').getBoundingClientRect().left + 5, e.clientY); const b = el && el.closest('#az button'); if (b) jumpTo(b.dataset.l); });
$('#az').addEventListener('pointerup', () => { azDrag = false; setTimeout(() => $$('#az button').forEach(b => b.classList.remove('hit')), 600); });

/* ====================================================== album sheet */
async function openAlbum(a) {
  S.albumOpen = { album: a, tracks: null };
  $('#albumArt').src = a.art || ''; $('#albumArt').style.visibility = a.art ? '' : 'hidden';
  $('#albumTitle').textContent = a.title;
  $('#albumArtist').textContent = [a.artist, a.year].filter(Boolean).join(' · ');
  $('#albumTracks').innerHTML = `<div class="empty"><div class="spinner"></div></div>`;
  $('#albumOverlay').hidden = false;
  try {
    const tracks = await SRC[a.source].tracks(a.id);
    if (!S.albumOpen || S.albumOpen.album !== a) return;
    S.albumOpen.tracks = tracks;
    renderAlbumTracks();
  } catch (e) { $('#albumTracks').innerHTML = emptyState('Couldn\'t load tracks', e.message || String(e)); }
}
function renderAlbumTracks() {
  const tr = S.albumOpen.tracks;
  const multiDisc = new Set(tr.map(t => t.disc)).size > 1;
  $('#albumTracks').innerHTML = tr.map((t, i) => `<li class="${isQueued(t) ? 'queued' : ''}"><button data-i="${i}">
    <span class="no">${multiDisc ? t.disc + '.' : ''}${t.trackNo || i + 1}</span>
    <span><div class="t1">${esc(t.title)}</div>${t.artist && t.artist !== S.albumOpen.album.artist ? `<div class="t2">${esc(t.artist)}</div>` : ''}</span>
    <span class="dur">${t.duration ? fmt(t.duration) : ''}</span><span class="add">${isQueued(t) ? '✓' : '+'}</span></button></li>`).join('');
}
$('#albumTracks').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b || !S.albumOpen.tracks) return;
  addToQueue(S.albumOpen.tracks[+b.dataset.i]); renderAlbumTracks();
});
$('#albumAddAll').addEventListener('click', () => {
  if (!S.albumOpen || !S.albumOpen.tracks) return;
  const n = addMany(S.albumOpen.tracks);
  renderAlbumTracks();
  if (n) closeOverlay($('#albumOverlay'));
});

/* ====================================================== YouTube Music artist page */
async function openArtist(a) {
  if (!a || !a.id) return;
  S.artistOpen = { id: a.id, songs: null };
  $('#artistBg').style.backgroundImage = a.art ? `url("${a.art}")` : '';
  $('#artistName').textContent = a.name || '';
  $('#artistSub').textContent = a.subscribers || '';
  $('#artistAbout').textContent = '';
  $('#artistTracks').innerHTML = `<div class="empty"><div class="spinner"></div></div>`;
  $('#artistOverlay').hidden = false;
  try {
    const d = await jb.yt.artist(a.id);
    if (!S.artistOpen || S.artistOpen.id !== a.id) return;
    S.artistOpen.songs = d.songs || [];
    if (d.banner || d.photo) $('#artistBg').style.backgroundImage = `url("${d.banner || d.photo}")`;
    if (d.name) $('#artistName').textContent = d.name;
    $('#artistAbout').textContent = d.about || '';
    renderArtistTracks();
  } catch (e) { $('#artistTracks').innerHTML = emptyState('Couldn\'t load this artist', (e && e.message || String(e)).replace(/^Error invoking remote method '[^']+': /, '')); }
}
function renderArtistTracks() {
  const tr = S.artistOpen.songs;
  const el = $('#artistTracks'); el.classList.add('with-art');
  if (!tr.length) { el.innerHTML = '<li class="queue-empty">No songs listed for this artist.</li>'; return; }
  el.innerHTML = tr.map((t, i) => `<li class="${isQueued(t) ? 'queued' : ''}"><button data-i="${i}">
    <span class="no">${i + 1}</span>${t.art ? `<img class="thumb" src="${esc(t.art)}" alt="">` : '<span></span>'}
    <span><div class="t1">${esc(t.title)}</div>${t.album ? `<div class="t2">${esc(t.album)}</div>` : ''}</span>
    <span class="dur">${t.duration ? fmt(t.duration) : ''}</span><span class="add">${isQueued(t) ? '✓' : '+'}</span></button></li>`).join('');
}
$('#artistTracks').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b || !S.artistOpen || !S.artistOpen.songs) return;
  addToQueue(S.artistOpen.songs[+b.dataset.i]); renderArtistTracks();
});
$('#artistAddAll').addEventListener('click', () => {
  if (!S.artistOpen || !S.artistOpen.songs) return;
  const n = addMany(S.artistOpen.songs.slice(0, 10)); renderArtistTracks();
  if (n) closeOverlay($('#artistOverlay'));
});
$('#npArtist').addEventListener('click', () => {
  const t = S.current;
  if (t && t.source === 'youtube' && t.artistId) openArtist({ id: t.artistId, name: (t.artist || '').split(',')[0] });
});

// Artist photo behind the turntable and on the idle screen while a YouTube song plays
let shownPhoto = '';
function setArtistPhoto(url) {
  if (url === shownPhoto) return;
  shownPhoto = url;
  const els = [$('#npPhoto'), $('#idlePhoto')];
  if (!url) { els.forEach(e => e.classList.remove('on')); return; }
  const img = new Image();
  img.onload = () => { if (shownPhoto !== url) return; els.forEach(e => { e.style.backgroundImage = `url("${url}")`; e.classList.add('on'); }); };
  img.onerror = () => { if (shownPhoto === url) els.forEach(e => e.classList.remove('on')); };
  img.src = url;
}
function updateArtistPhoto() {
  const t = S.current;
  $('#npArtist').classList.toggle('link', !!(t && t.source === 'youtube' && t.artistId));
  if (!t || t.source !== 'youtube' || !t.artistId) { setArtistPhoto(''); return; }
  const id = t.artistId;
  jb.yt.artist(id).then(d => { if (S.current && S.current.artistId === id) setArtistPhoto(d.banner || d.photo || ''); }).catch(() => setArtistPhoto(''));
}

/* ====================================================== overlays */
function closeOverlay(ov) {
  ov.hidden = true;
  if (ov.id === 'albumOverlay') { S.albumOpen = null; refreshQueuedMarks(); }
  if (ov.id === 'artistOverlay') { S.artistOpen = null; refreshQueuedMarks(); }
  if (ov.id === 'searchOverlay' || ov.id === 'settingsOverlay') OSK.hide();
}
document.addEventListener('click', (e) => {
  const x = e.target.closest('[data-close]');
  if (x) { closeOverlay(x.closest('.overlay')); return; }
  if (e.target.classList && e.target.classList.contains('overlay') && e.target.id !== 'pinOverlay') closeOverlay(e.target);
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

/* ====================================================== search */
let suggestTimer = null;
function openSearch() {
  if (!SRC[S.tab].ready()) { openSettings(); return; }
  $('#searchSrc').textContent = TAB_NAMES[S.tab];
  const inp = $('#searchInput');
  inp.value = S.query[S.tab] || '';
  $('#searchOverlay').hidden = false;
  renderSuggest([]);
  inp.focus();
  inp.select();
  OSK.show(inp, { action: 'Search', onEnter: () => runSearch(inp.value) });
}
function renderSuggest(list) {
  const recent = LS.get('recent:' + S.tab, []);
  const items = list.length ? list : recent;
  $('#suggest').innerHTML = items.map(s => `<button data-q="${esc(s)}">${list.length ? '' : '↺ '}${esc(s)}</button>`).join('');
}
$('#suggest').addEventListener('click', (e) => { const b = e.target.closest('button[data-q]'); if (b) runSearch(b.dataset.q); });
$('#searchInput').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('#searchInput').value.trim();
  if (!q) { renderSuggest([]); return; }
  if (S.tab === 'youtube') suggestTimer = setTimeout(async () => { const s = await jb.yt.suggest(q); if ($('#searchInput').value.trim() === q) renderSuggest(s); }, 300);
});
$('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(e.target.value); if (e.key === 'Escape') closeOverlay($('#searchOverlay')); });
$('#searchBtn').addEventListener('click', openSearch);

async function runSearch(q) {
  q = String(q || '').trim(); if (!q) return;
  const src = S.tab;
  closeOverlay($('#searchOverlay'));
  const recent = [q, ...LS.get('recent:' + src, []).filter(r => r.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  LS.set('recent:' + src, recent);
  S.query[src] = q;
  S.results[src] = { loading: true };
  renderBrowse();
  try {
    const r = await SRC[src].search(q);
    if (S.query[src] !== q) return;
    S.results[src] = r;
  } catch (e) {
    S.results[src] = { error: (e && e.message || String(e)).replace(/^Error invoking remote method '[^']+': /, '') };
  }
  if (S.tab === src) renderBrowse();
}

/* ====================================================== queue */
const keyOf = (t) => t.source + ':' + t.id;
function isQueued(t) { const k = keyOf(t); return S.queue.some(q => !q.auto && keyOf(q) === k) || (S.current && keyOf(S.current) === k); }
let qidSeq = 1;

function insertPos() { const i = S.queue.findIndex(q => q.auto); return i === -1 ? S.queue.length : i; }
function addToQueue(t, quiet) {
  if (!t) return false;
  const userCount = S.queue.filter(q => !q.auto).length;
  if (S.cfg.maxQueue && userCount >= S.cfg.maxQueue) { if (!quiet) toast(`The queue is full (${S.cfg.maxQueue} songs)`, true); return false; }
  if (S.cfg.noDuplicates && isQueued(t)) { if (!quiet) toast(`“${t.title}” is already in the queue`); return false; }
  const pos = insertPos();
  S.queue.splice(pos, 0, { ...t, qid: qidSeq++, auto: false });
  // drop autoplay fillers once real requests exist
  S.queue = S.queue.filter(q => !q.auto);
  if (!quiet) toast(S.current ? `Added “${t.title}” · #${pos + 1} in line` : `Playing “${t.title}”`);
  renderQueue(); saveState();
  if (!S.current) next();
  return true;
}
function addMany(tracks) {
  let n = 0;
  for (const t of tracks) if (addToQueue(t, true)) n++;
  toast(n ? `Added ${n} song${n > 1 ? 's' : ''} to the queue` : 'Those songs are already queued');
  return n;
}
function renderQueue() {
  const list = $('#queueList');
  $('#queueCount').textContent = S.queue.filter(q => !q.auto).length;
  if (!S.queue.length) {
    list.innerHTML = `<li class="queue-empty" style="display:block">${S.current ? 'No more selections after this record.' : 'No selections yet.'} Tap any title strip to choose a song.</li>`;
    return;
  }
  list.innerHTML = S.queue.map((t, i) => `<li class="${t.auto ? 'auto' : ''}" data-qid="${t.qid}">
    ${t.art ? `<img src="${esc(t.art)}" alt="">` : '<div class="ph">♪</div>'}
    <div style="min-width:0"><div class="t1">${esc(t.title)}</div><div class="t2">${t.auto ? 'Autoplay · ' : ''}${esc(t.artist)}</div></div>
    <div class="q-acts">${i > 0 && !t.auto ? '<button data-qa="up" aria-label="Move up">▲</button>' : ''}<button data-qa="rm" aria-label="Remove">×</button></div></li>`).join('');
}
$('#queueList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-qa]'); if (!b) return;
  const qid = +b.closest('li').dataset.qid;
  const i = S.queue.findIndex(q => q.qid === qid); if (i < 0) return;
  if (b.dataset.qa === 'rm') S.queue.splice(i, 1);
  if (b.dataset.qa === 'up' && i > 0) { const [x] = S.queue.splice(i, 1); S.queue.splice(i - 1, 0, x); }
  renderQueue(); saveState(); refreshQueuedMarks();
});
function refreshQueuedMarks() {
  $$('#scroller .row[data-track]').forEach(r => { const t = rowTracks[+r.dataset.track]; const q = isQueued(t); r.classList.toggle('queued', q); $('.add', r).textContent = q ? '✓' : '+'; });
}

async function autofill() {
  const mode = S.cfg.autoplay;
  if (mode === 'off') return;
  try {
    let tracks = [];
    if (mode === 'server' && SRC.server.ready()) tracks = await jb.jf.random(3);
    else if (mode === 'local' && SRC.local.ready()) tracks = await jb.local.random(3);
    else if (mode === 'youtube' && SRC.youtube.ready()) {
      const seed = S.lastYtId;
      if (seed) tracks = await jb.yt.radio(seed, 3);
      else if (SRC.server.ready()) tracks = await jb.jf.random(3);
      else if (SRC.local.ready()) tracks = await jb.local.random(3);
    }
    for (const t of tracks) S.queue.push({ ...t, qid: qidSeq++, auto: true });
  } catch (e) { console.warn('autofill', e); }
}

/* ====================================================== player */
async function next() {
  if (S.advancing) return;
  S.advancing = true;
  try {
    if (S.current && S.current.source === 'server' && S.pos > 30) jb.jf.reportPlay(S.current.id);
    if (!S.queue.length) await autofill();
    const t = S.queue.shift();
    if (!t) { stopAll(); return; }
    startTrack(t);
  } finally { S.advancing = false; renderQueue(); saveState(); }
}
function stopAll() {
  audio.pause(); audio.removeAttribute('src'); audio.load();
  if (S.kind === 'yt') jb.yt.stop();
  S.current = null; S.kind = null; S.playing = false; S.pos = 0; S.dur = 0;
  renderNP(); renderQueue(); saveState();
}
function startTrack(t) {
  S.current = t; S.pos = 0; S.dur = t.duration || 0; S.ytAd = false;
  if (t.source === 'youtube') {
    audio.pause(); audio.removeAttribute('src'); audio.load();
    S.kind = 'yt'; S.lastYtId = t.id; S.ytLastProgressAt = Date.now();
    jb.yt.cmd('volume', S.cfg.volume);
    jb.yt.play(t.id);
    S.playing = true;
  } else {
    if (S.kind === 'yt') jb.yt.stop();
    S.kind = 'audio';
    audio.src = t.url;
    audio.volume = S.cfg.volume;
    audio.play().then(() => { S.playing = true; renderPlayIcon(); }).catch((e) => console.warn(e));
  }
  renderNP();
}
audio.addEventListener('ended', () => { if (S.kind === 'audio') next(); });
audio.addEventListener('error', () => {
  if (S.kind !== 'audio' || !S.current || !audio.getAttribute('src')) return;
  toast(`Couldn't play “${S.current.title}” — skipping`, true);
  setTimeout(next, 800);
});
audio.addEventListener('play', () => { S.playing = true; renderPlayIcon(); });
audio.addEventListener('pause', () => { if (S.kind === 'audio') { S.playing = false; renderPlayIcon(); } });
audio.addEventListener('timeupdate', () => { if (S.kind === 'audio') { S.pos = audio.currentTime; S.dur = audio.duration || S.dur; } });

jb.yt.onState((s) => {
  if (S.kind !== 'yt' || !S.current) return;
  if (s.event === 'ended' && s.videoId === S.current.id) { next(); return; }
  if (s.event !== 'tick' || s.videoId !== S.current.id) return;
  if (s.ad !== S.ytAd) { S.ytAd = s.ad; renderNP(); }
  if (!s.ad) {
    if (s.currentTime > 0 && Math.abs(s.currentTime - S.pos) > 0.05) S.ytLastProgressAt = Date.now();
    S.pos = s.currentTime; S.dur = s.duration || S.dur;
  } else S.ytLastProgressAt = Date.now();
  const playing = !s.paused;
  if (playing !== S.playing) { S.playing = playing; renderPlayIcon(); }
});
jb.yt.onLoginClosed(() => {
  toast('YouTube Music sign-in closed');
  // signing in stops the YouTube player, so restart the song it was on
  if (S.kind === 'yt' && S.current) setTimeout(() => { S.ytLastProgressAt = Date.now(); jb.yt.play(S.current.id); }, 2500);
});
// watchdog: YouTube track never started
setInterval(() => {
  if (S.kind === 'yt' && S.playing && S.current && Date.now() - S.ytLastProgressAt > 30000) {
    toast(`YouTube didn't play “${S.current.title}” — skipping`, true);
    S.ytLastProgressAt = Date.now();
    next();
  }
}, 3000);

function togglePlay() {
  if (!S.current) { next(); return; }
  if (S.kind === 'audio') { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); }
  else if (S.kind === 'yt') { S.playing = !S.playing; jb.yt.cmd(S.playing ? 'play' : 'pause'); if (S.playing) S.ytLastProgressAt = Date.now(); renderPlayIcon(); }
}
$('#playBtn').addEventListener('click', togglePlay);
$('#skipBtn').addEventListener('click', () => { if (S.current || S.queue.length) next(); });

function renderPlayIcon() {
  $('#playIco').textContent = S.playing ? '❚❚' : '▶';
  $('#playLbl').textContent = S.playing ? 'Pause' : 'Play';
  document.body.classList.toggle('is-playing', !!(S.playing && S.current));
}
const SRC_LABEL = { server: 'Jellyfin', local: 'Local', youtube: 'YouTube' };
function renderNP() {
  const t = S.current;
  $('#npTitle').textContent = t ? t.title : 'Nothing playing';
  $('#npArtist').textContent = t ? (S.ytAd ? 'Advertisement — your song starts shortly' : [t.artist, t.album].filter(Boolean).join(' · ')) : 'Make your selection';
  $('#npSrc').textContent = t ? SRC_LABEL[t.source] : '';
  const img = $('#npArt');
  if (t && t.art) { img.style.visibility = ''; img.dataset.failed = ''; img.src = t.art; $('#npArtEmpty').hidden = true; }
  else { img.removeAttribute('src'); img.style.visibility = 'hidden'; $('#npArtEmpty').hidden = false; }
  renderPlayIcon();
  renderIdle();
  updateArtistPhoto();
}
function renderProgress() {
  const f = S.dur > 0 ? Math.min(1, S.pos / S.dur) : 0;
  $('#progressFill').style.width = f * 100 + '%';
  $('#progressKnob').style.left = f * 100 + '%';
  $('#tCur').textContent = fmt(S.pos); $('#tDur').textContent = fmt(S.dur);
}
setInterval(renderProgress, 250);

function seekFromEvent(e) {
  if (!S.current || !S.dur || S.ytAd) return;
  const r = $('#progress').getBoundingClientRect();
  const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.dur;
  if (S.kind === 'audio') audio.currentTime = t; else jb.yt.cmd('seek', t);
  S.pos = t; renderProgress();
}
$('#progress').addEventListener('pointerdown', seekFromEvent);

// volume
function renderVol() { $('#volFill').style.width = S.cfg.volume * 100 + '%'; }
let volSave = null, volDrag = false;
function setVolFromEvent(e) {
  const r = $('#volTrack').getBoundingClientRect();
  const v = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100) / 100;
  S.cfg.volume = v; audio.volume = v; jb.yt.cmd('volume', v); renderVol();
  clearTimeout(volSave); volSave = setTimeout(() => jb.config.set({ volume: v }), 600);
}
$('#volTrack').addEventListener('pointerdown', (e) => { volDrag = true; $('#volTrack').setPointerCapture(e.pointerId); setVolFromEvent(e); });
$('#volTrack').addEventListener('pointermove', (e) => { if (volDrag) setVolFromEvent(e); });
$('#volTrack').addEventListener('pointerup', () => { volDrag = false; });

function saveState() {
  const strip = ({ qid, ...t }) => t;
  LS.set('state', { current: S.current ? strip(S.current) : null, queue: S.queue.filter(q => !q.auto).map(strip), lastYtId: S.lastYtId });
}

/* ====================================================== idle / attract */
function renderIdle() {
  const t = S.current;
  $('#idleTitle').textContent = t ? t.title : 'The music is waiting';
  $('#idleArtist').textContent = t ? t.artist : '';
  const has = !!(t && t.art);
  $('#idleArt').hidden = !has; $('#idleArtEmpty').hidden = has;
  if (has) { $('#idleArt').dataset.failed = ''; $('#idleArt').style.visibility = ''; $('#idleArt').src = t.art; }
  const nx = S.queue[0];
  $('#idleNext').textContent = nx ? `Up next: ${nx.title} — ${nx.artist}` : '';
}
let swallowClick = false;
document.addEventListener('pointerdown', (e) => {
  S.lastTouch = Date.now();
  if (!$('#idle').hidden) { $('#idle').hidden = true; swallowClick = true; e.stopPropagation(); e.preventDefault(); }
}, true);
document.addEventListener('click', (e) => { if (swallowClick) { swallowClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
setInterval(() => {
  const mins = S.cfg && S.cfg.idleMinutes;
  if (!mins || !$('#idle').hidden) return;
  if (!$('#settingsOverlay').hidden || !$('#pinOverlay').hidden) return;
  if (Date.now() - S.lastTouch > mins * 60000) {
    $$('.overlay').forEach(o => { if (!o.hidden) closeOverlay(o); });
    OSK.hide();
    for (const k of Object.keys(S.artistFilter)) S.artistFilter[k] = null;
    renderIdle();
    $('#idle').hidden = false;
  }
}, 5000);

/* ====================================================== on-screen keyboard */
const OSK = (() => {
  const el = $('#osk');
  let target = null, opts = {}, shift = false, sym = false;
  const ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
    ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'],
  ];
  const SYM = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['@', '#', '&', '!', '?', '(', ')', '+', '=', '%'],
    ['-', '_', '/', ':', ';', ',', '"', '*', '~', '$'],
    ['⇧', '.', ':', '/', '-', '_', '@', '⌫'],
  ];
  function render() {
    const rows = (sym ? SYM : ROWS).map(r => `<div class="osk-row">${r.map(k => {
      if (k === '⇧') return `<button class="wide ${shift ? 'on' : ''}" data-k="shift">⇧ Shift</button>`;
      if (k === '⌫') return `<button class="wide" data-k="bksp">⌫</button>`;
      const c = shift ? k.toUpperCase() : k;
      return `<button data-k="${esc(c)}">${esc(c)}</button>`;
    }).join('')}</div>`).join('');
    el.innerHTML = rows + `<div class="osk-row">
      <button class="wide" data-k="sym">${sym ? 'ABC' : '?123'}</button>
      <button class="wide" data-k="clear">Clear</button>
      <button class="space" data-k=" ">space</button>
      <button data-k=".">.</button>
      <button class="wide" data-k="hide">Hide ⌄</button>
      <button class="go" data-k="enter">${esc(opts.action || 'Done')}</button></div>`;
  }
  el.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]'); if (!b || !target) return;
    const k = b.dataset.k;
    if (k === 'shift') { shift = !shift; render(); return; }
    if (k === 'sym') { sym = !sym; render(); return; }
    if (k === 'hide') { hide(); target.blur(); return; }
    if (k === 'clear') { target.value = ''; }
    else if (k === 'bksp') {
      const s = target.selectionStart ?? target.value.length, en = target.selectionEnd ?? s;
      if (s !== en) target.setRangeText('', s, en, 'end');
      else if (s > 0) target.setRangeText('', s - 1, s, 'end');
    } else if (k === 'enter') {
      const fn = opts.onEnter; hide(); if (fn) fn(); else target.blur(); return;
    } else {
      try { target.setRangeText(k, target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length, 'end'); }
      catch { target.value += k; }
      if (shift) { shift = false; render(); }
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
  });
  function show(input, o = {}) {
    if (!S.cfg || !S.cfg.onScreenKeyboard) return;
    target = input; opts = o; shift = false;
    sym = input.type === 'number' || input.inputMode === 'numeric';
    render(); el.hidden = false; document.body.classList.add('osk-open');
    setTimeout(() => input.scrollIntoView({ block: 'center' }), 50);
  }
  function hide() { el.hidden = true; target = null; document.body.classList.remove('osk-open'); }
  // any text field in settings gets the keyboard automatically
  document.addEventListener('focusin', (e) => {
    const i = e.target;
    if (i.tagName === 'INPUT' && i.id !== 'searchInput' && i.closest('.settings-sheet')) show(i, { action: 'Done' });
  });
  return { show, hide };
})();

/* ====================================================== PIN gate */
function askPin() {
  return new Promise((resolve) => {
    let entered = '';
    const dots = $('#pinDots');
    const draw = () => { dots.innerHTML = '<i></i>'.repeat(entered.length); };
    $('#pinPad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '✕', '0', '⌫'].map(k => `<button data-p="${k}">${k}</button>`).join('');
    draw();
    $('#pinOverlay').hidden = false;
    $('#pinPad').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const k = b.dataset.p;
      if (k === '✕') { $('#pinOverlay').hidden = true; resolve(false); return; }
      if (k === '⌫') entered = entered.slice(0, -1); else entered += k;
      draw();
      if (entered.length >= S.cfg.adminPin.length) {
        if (entered === S.cfg.adminPin) { $('#pinOverlay').hidden = true; resolve(true); }
        else { dots.classList.add('bad'); setTimeout(() => { dots.classList.remove('bad'); entered = ''; draw(); }, 400); }
      }
    };
  });
}

/* ====================================================== settings */
async function openSettings() {
  if (S.cfg.adminPin && !(await askPin())) return;
  renderSettings();
  $('#settingsOverlay').hidden = false;
}
$('#settingsBtn').addEventListener('click', openSettings);

const seg = (key, opts, val) => `<div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${esc(JSON.stringify(v))}" class="${JSON.stringify(v) === JSON.stringify(val) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
const tog = (key, val) => `<button class="toggle ${val ? 'on' : ''}" data-tog="${key}" aria-label="${key}"></button>`;

let scanStatus = '';
async function renderSettings() {
  const c = S.cfg, j = c.jellyfin;
  const ver = await jb.app.version();
  $('#settingsSheet').innerHTML = `
    <button class="close-x" data-close>×</button>
    <h2>Settings</h2>

    <h3>Jellyfin server</h3>
    ${j.connected ? `
      <div class="set-row"><div class="lbl">${esc(j.serverName || j.url)}<span class="sub">${esc(j.url)} · signed in as ${esc(j.username)}</span></div>
        <span class="status ok">● Connected</span><button class="small-btn" data-act="jf-refresh">Reload library</button><button class="small-btn" data-act="jf-disconnect">Disconnect</button></div>` : `
      <div class="set-row"><label for="jfUrl">Server address<span class="sub">e.g. http://192.168.30.26:8096</span></label><input type="text" id="jfUrl" value="${esc(j.url)}" placeholder="http://server:8096"></div>
      <div class="set-row"><label for="jfUser">Username</label><input type="text" id="jfUser" value="${esc(j.username)}"></div>
      <div class="set-row"><label for="jfPass">Password</label><input type="password" id="jfPass"></div>
      <div class="set-row"><span class="status" id="jfStatus"></span><span style="flex:1"></span><button class="big-btn primary" data-act="jf-connect">Connect</button></div>`}

    <h3>Local music folders</h3>
    ${c.localFolders.map(f => `<div class="folder"><span>${esc(f)}</span><button class="small-btn" data-rmfolder="${esc(f)}">Remove</button></div>`).join('') || '<div class="folder"><span>No folders added</span></div>'}
    <div class="set-row"><span class="status" id="scanStatus">${esc(scanStatus)}</span><span style="flex:1"></span>
      <button class="small-btn" data-act="add-folder">+ Add folder</button><button class="small-btn" data-act="rescan" ${c.localFolders.length ? '' : 'disabled'}>Rescan library</button></div>

    <h3>YouTube Music</h3>
    <div class="set-row"><div class="lbl">Enable YouTube Music<span class="sub">Searches the full YouTube Music catalogue. Sign in with a Premium account to remove ads.</span></div>${tog('youtube', c.youtube.enabled)}</div>
    <div class="set-row"><div class="lbl">Account<span class="sub">Opens a Google sign-in window in front of the jukebox. Close it once you're signed in.</span></div><button class="small-btn" data-act="yt-login">Sign in / account…</button></div>

    <h3>Playback</h3>
    <div class="set-row"><div class="lbl">When the queue runs out<span class="sub">Keeps music going with random picks until someone chooses a song</span></div>
      ${seg('autoplay', [['off', 'Stop'], ['server', 'Random from server'], ['local', 'Random local'], ['youtube', 'YouTube radio']], c.autoplay)}</div>
    <div class="set-row"><div class="lbl">Block duplicate requests</div>${tog('noDuplicates', c.noDuplicates)}</div>
    <div class="set-row"><div class="lbl">Max songs in queue</div>${seg('maxQueue', [[10, '10'], [25, '25'], [50, '50'], [100, '100'], [0, 'No limit']], c.maxQueue)}</div>

    <h3>Screen</h3>
    <div class="set-row"><div class="lbl">Now-playing screen after</div>${seg('idleMinutes', [[0, 'Never'], [1, '1 min'], [3, '3 min'], [5, '5 min'], [10, '10 min']], c.idleMinutes)}</div>
    <div class="set-row"><div class="lbl">Start on tab</div>${seg('startTab', [['server', 'Server'], ['local', 'Local'], ['youtube', 'YouTube']], c.startTab)}</div>
    <div class="set-row"><div class="lbl">Fullscreen</div>${tog('fullscreen', c.fullscreen)}</div>
    <div class="set-row"><div class="lbl">Kiosk mode<span class="sub">Locks the window so it can't be closed or switched away from. Ctrl+Shift+Q quits.</span></div>${tog('kiosk', c.kiosk)}</div>
    <div class="set-row"><div class="lbl">Hide mouse cursor</div>${tog('hideCursor', c.hideCursor)}</div>
    <div class="set-row"><div class="lbl">On-screen keyboard</div>${tog('onScreenKeyboard', c.onScreenKeyboard)}</div>

    <h3>Updates</h3>
    <div class="set-row"><div class="lbl">Jukebox v${esc(ver)}<span class="sub" id="updStatus">${esc(updText(S.update))}</span></div>
      <button class="small-btn" data-act="upd-check" ${['nsis', 'appimage', 'deb'].includes(S.update.kind) ? '' : 'disabled'}>Check now</button>
      ${S.update.state === 'ready' ? '<button class="small-btn" data-act="upd-install">Install now</button>' : ''}</div>
    <div class="set-row"><div class="lbl">Install updates automatically<span class="sub">Restarts to update when nothing is playing, or between 3 and 5 am. The queue carries on afterwards.</span></div>${tog('autoUpdate', c.autoUpdate)}</div>

    <h3>Operator lock</h3>
    <div class="set-row"><label for="pinIn">Settings PIN<span class="sub">Guests need this to open Settings. Leave blank for no lock.</span></label>
      <input type="number" inputmode="numeric" id="pinIn" value="${esc(c.adminPin)}" placeholder="none" style="width:12rem"><button class="small-btn" data-act="save-pin">Save PIN</button></div>

    <div class="set-row" style="border:0;margin-top:1.4rem"><span class="status">Jukebox v${esc(ver)}</span><span style="flex:1"></span>
      <button class="big-btn" data-act="clear-queue">Clear queue</button><button class="big-btn danger" data-act="quit">Quit Jukebox</button></div>`;
}

$('#settingsSheet').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const set = async (patch) => { S.cfg = await jb.config.set(patch); applyCfg(); renderSettings(); };
  if (b.closest('[data-seg]')) { const key = b.closest('[data-seg]').dataset.seg; await set({ [key]: JSON.parse(b.dataset.v) }); return; }
  if (b.dataset.tog) {
    const k = b.dataset.tog;
    if (k === 'youtube') await set({ youtube: { enabled: !S.cfg.youtube.enabled } });
    else await set({ [k]: !S.cfg[k] });
    return;
  }
  if (b.dataset.rmfolder) { S.cfg = await jb.local.removeFolder(b.dataset.rmfolder); renderSettings(); renderTabs(); return; }
  switch (b.dataset.act) {
    case 'jf-connect': {
      const st = $('#jfStatus'); st.className = 'status'; st.textContent = 'Connecting…';
      try {
        S.cfg = await jb.jf.connect({ url: $('#jfUrl').value, username: $('#jfUser').value, password: $('#jfPass').value });
        OSK.hide(); S.albums.server = null; renderSettings(); renderTabs(); if (S.tab === 'server') { renderBrowse(); loadAlbums('server'); }
        toast('Connected to Jellyfin');
      } catch (err) { st.className = 'status err'; st.textContent = (err.message || String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
      break;
    }
    case 'jf-disconnect': S.cfg = await jb.jf.disconnect(); S.albums.server = null; renderSettings(); renderTabs(); if (S.tab === 'server') renderBrowse(); break;
    case 'jf-refresh': S.albums.server = null; loadAlbums('server', true); toast('Reloading server library…'); break;
    case 'add-folder': S.cfg = await jb.local.addFolder(); renderSettings(); renderTabs(); if (S.cfg.localFolders.length) startScan(); break;
    case 'rescan': startScan(); break;
    case 'yt-login': jb.yt.showLogin(); break;
    case 'save-pin': { const v = $('#pinIn').value.replace(/\D/g, '').slice(0, 8); OSK.hide(); await set({ adminPin: v }); toast(v ? 'PIN saved' : 'PIN removed'); break; }
    case 'clear-queue': S.queue = []; renderQueue(); saveState(); toast('Queue cleared'); break;
    case 'quit': jb.app.quit(); break;
    case 'upd-check': { const el = $('#updStatus'); if (el) el.textContent = 'Checking…'; S.update = await jb.update.check(); renderSettings(); break; }
    case 'upd-install': installUpdate(); break;
  }
});
async function startScan() {
  scanStatus = 'Scanning…'; const el = $('#scanStatus'); if (el) el.textContent = scanStatus;
  try {
    const r = await jb.local.scan();
    scanStatus = `${r.tracks} songs in ${r.albums} albums`;
    S.albums.local = null; if (S.tab === 'local') loadAlbums('local');
  } catch (e) { scanStatus = 'Scan failed: ' + e.message; }
  const el2 = $('#scanStatus'); if (el2) el2.textContent = scanStatus;
}
jb.local.onProgress((p) => { { scanStatus = p.finished ? `${p.total} songs scanned` : `Scanning… ${p.done} / ${p.total}`; const el = $('#scanStatus'); if (el) el.textContent = scanStatus; } });

function applyCfg() {
  document.body.classList.toggle('hide-cursor', !!S.cfg.hideCursor);
  renderTabs(); renderVol();
}

/* ====================================================== updates */
function updText(u) {
  switch (u.kind) {
    case 'dev': return 'Updates are off when running from source.';
    case 'portable': return 'Portable version: it can\'t update itself. Use the installer to get automatic updates.';
    case 'unsupported': return 'Automatic updates aren\'t available on this system.';
  }
  switch (u.state) {
    case 'checking': return 'Checking for updates…';
    case 'current': return 'Up to date.';
    case 'downloading': return `Downloading version ${u.version}… ${u.progress || 0}%`;
    case 'ready': return `Version ${u.version} is ready to install.` + (u.kind === 'deb' ? ' Installing needs the admin password.' : '');
    case 'error': return 'Couldn\'t check for updates: ' + (u.error || 'unknown error');
    default: return 'Not checked yet.';
  }
}
function installUpdate() {
  saveState();
  toast(`Updating the jukebox to version ${S.update.version}. Back in a moment…`);
  setTimeout(() => jb.update.install(), 1500);
}
jb.update.onState((u) => {
  S.update = u;
  const el = $('#updStatus'); if (el) el.textContent = updText(u);
  if (u.state === 'ready' && !$('#settingsOverlay').hidden && !$('[data-act="upd-install"]')) renderSettings();
});
// Install a downloaded update automatically when nobody will notice.
setInterval(() => {
  const u = S.update;
  if (!S.cfg || !S.cfg.autoUpdate || u.state !== 'ready' || u.kind === 'deb') return;
  if (!$('#settingsOverlay').hidden || !$('#pinOverlay').hidden) return;
  const idleFor = Date.now() - S.lastTouch;
  const h = new Date().getHours();
  const quiet = (!S.current || !S.playing) && idleFor > 2 * 60000;
  const smallHours = h >= 3 && h < 5 && idleFor > 2 * 60000;
  if (quiet || smallHours) installUpdate();
}, 30000);

/* ====================================================== boot */
(async function boot() {
  S.cfg = await jb.config.get();
  S.update = await jb.update.get();
  applyCfg();
  tickClock();
  const order = [S.cfg.startTab, 'server', 'local', 'youtube'];
  S.tab = order.find(t => SRC[t] && SRC[t].ready()) || S.cfg.startTab || 'server';
  renderTabs(); renderBrowse(); renderNP(); renderQueue();
  if ((S.tab === 'server' || S.tab === 'local') && SRC[S.tab].ready()) loadAlbums(S.tab);

  // restore the queue after a restart / power cut and carry on playing
  const st = LS.get('state', null);
  if (st) {
    S.lastYtId = st.lastYtId || null;
    S.queue = (st.queue || []).map(t => ({ ...t, qid: qidSeq++, auto: false }));
    if (st.current) S.queue.unshift({ ...st.current, qid: qidSeq++, auto: false });
    renderQueue();
    if (S.queue.length) setTimeout(next, S.queue[0].source === 'youtube' ? 2500 : 300);
  }
})();
