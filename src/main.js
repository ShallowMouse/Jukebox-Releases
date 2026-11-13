// Jukebox — main process
// Sources: Jellyfin server, local folders, YouTube Music (via a hidden player window).
const { app, BrowserWindow, ipcMain, dialog, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-pinch');
app.commandLine.appendSwitch('overscroll-history-navigation', '0');

const USER = () => app.getPath('userData');
const CONFIG_PATH = () => path.join(USER(), 'config.json');
const LOCAL_LIB_PATH = () => path.join(USER(), 'local-library.json');
const ART_DIR = () => path.join(USER(), 'art');

const DEFAULTS = {
  jellyfin: { url: '', username: '', token: '', userId: '', serverName: '' },
  localFolders: [],
  youtube: { enabled: true },
  autoplay: 'server',          // 'server' | 'local' | 'youtube' | 'off'
  idleMinutes: 3,
  fullscreen: true,
  kiosk: false,
  hideCursor: false,
  adminPin: '',
  maxQueue: 50,
  noDuplicates: true,
  volume: 0.8,
  onScreenKeyboard: true,
  startTab: 'server',
  autoUpdate: true,            // install downloaded updates automatically when the jukebox is quiet
  deviceId: crypto.randomUUID(),
};

let config = loadConfig();
let mainWin = null;
let ytWin = null;

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    return { ...DEFAULTS, ...raw, jellyfin: { ...DEFAULTS.jellyfin, ...(raw.jellyfin || {}) }, youtube: { ...DEFAULTS.youtube, ...(raw.youtube || {}) } };
  } catch { return { ...DEFAULTS }; }
}
function saveConfig() {
  fs.mkdirSync(USER(), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
}
function publicConfig() {
  const c = JSON.parse(JSON.stringify(config));
  c.jellyfin.connected = !!(c.jellyfin.token && c.jellyfin.userId);
  delete c.jellyfin.token;
  return c;
}
function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- window
function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWin = new BrowserWindow({
    width, height,
    fullscreen: !!config.fullscreen,
    kiosk: !!config.kiosk,
    backgroundColor: '#0d0907',
    autoHideMenuBar: true,
    title: 'Jukebox',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWin.setMenu(null);
  mainWin.webContents.on('did-finish-load', () => mainWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {}));
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Keyboard escape hatches for the operator
  mainWin.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { mainWin.setFullScreen(!mainWin.isFullScreen()); e.preventDefault(); }
    if (input.key === 'F12' && input.control) mainWin.webContents.toggleDevTools();
    if (input.key === 'q' && input.control && input.shift) app.quit();
  });
  mainWin.on('close', () => {
    // Closing the jukebox window quits everything, including the hidden YouTube player.
    app.isQuitting = true;
    if (ytWin && !ytWin.isDestroyed()) { ytWin.webContents.setAudioMuted(true); ytWin.destroy(); }
  });
  mainWin.on('closed', () => {
    mainWin = null;
    app.quit();
    setTimeout(() => app.exit(0), 3000); // never linger in the background
  });
}

// ---------------------------------------------------------------- Jellyfin
function jfAuthHeader(token) {
  const v = app.getVersion();
  let h = `MediaBrowser Client="Jukebox", Device="${require('os').hostname()}", DeviceId="${config.deviceId}", Version="${v}"`;
  if (token) h += `, Token="${token}"`;
  return h;
}
function jfBase() { return (config.jellyfin.url || '').replace(/\/+$/, ''); }

async function jf(pathAndQuery, opts = {}) {
  const res = await fetch(jfBase() + pathAndQuery, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: jfAuthHeader(config.jellyfin.token), ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Jellyfin ${res.status} ${res.statusText}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function jfTrack(it) {
  const base = jfBase();
  const albumId = it.AlbumId || it.ParentId;
  const imgId = it.AlbumPrimaryImageTag ? albumId : (it.ImageTags && it.ImageTags.Primary ? it.Id : albumId);
  return {
    source: 'server',
    id: it.Id,
    title: it.Name,
    artist: (it.Artists && it.Artists.join(', ')) || it.AlbumArtist || '',
    album: it.Album || '',
    albumId,
    trackNo: it.IndexNumber || 0,
    disc: it.ParentIndexNumber || 1,
    duration: it.RunTimeTicks ? it.RunTimeTicks / 1e7 : 0,
    art: imgId ? `${base}/Items/${imgId}/Images/Primary?maxHeight=600&quality=90` : '',
    url: `${base}/Audio/${it.Id}/stream?static=true&api_key=${config.jellyfin.token}`,
  };
}
function jfAlbum(it) {
  const base = jfBase();
  return {
    source: 'server',
    id: it.Id,
    title: it.Name,
    artist: it.AlbumArtist || (it.Artists && it.Artists[0]) || 'Unknown Artist',
    year: it.ProductionYear || '',
    art: it.ImageTags && it.ImageTags.Primary ? `${base}/Items/${it.Id}/Images/Primary?maxHeight=500&quality=88` : '',
  };
}

// Inject the Jellyfin auth header on media requests from the renderer (audio element / images)
function installJellyfinHeaderHook() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    const base = jfBase();
    if (base && config.jellyfin.token && details.url.startsWith(base)) {
      details.requestHeaders['Authorization'] = jfAuthHeader(config.jellyfin.token);
    }
    cb({ requestHeaders: details.requestHeaders });
  });
}

ipcMain.handle('jf:connect', async (_e, { url, username, password }) => {
  config.jellyfin.url = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(config.jellyfin.url)) config.jellyfin.url = 'http://' + config.jellyfin.url;
  config.jellyfin.token = '';
  let r;
  try {
    r = await jf('/Users/AuthenticateByName', { method: 'POST', body: JSON.stringify({ Username: username, Pw: password }) });
  } catch (e) {
    if (/401/.test(e.message)) throw new Error('Wrong username or password');
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(e.message + (e.cause ? e.cause.code : ''))) throw new Error(`Can't reach ${config.jellyfin.url} — check the address and port`);
    throw e;
  }
  config.jellyfin.token = r.AccessToken;
  config.jellyfin.userId = r.User.Id;
  config.jellyfin.username = username;
  try { const info = await jf('/System/Info/Public'); config.jellyfin.serverName = info.ServerName || ''; } catch {}
  saveConfig();
  return publicConfig();
});
ipcMain.handle('jf:disconnect', async () => {
  config.jellyfin = { ...DEFAULTS.jellyfin, url: config.jellyfin.url, username: config.jellyfin.username };
  saveConfig();
  return publicConfig();
});
ipcMain.handle('jf:albums', async () => {
  const u = config.jellyfin.userId;
  const r = await jf(`/Users/${u}/Items?IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=AlbumArtist,SortName&SortOrder=Ascending&Fields=PrimaryImageAspectRatio&EnableImageTypes=Primary&ImageTypeLimit=1`);
  return (r.Items || []).map(jfAlbum);
});
ipcMain.handle('jf:albumTracks', async (_e, albumId) => {
  const u = config.jellyfin.userId;
  const r = await jf(`/Users/${u}/Items?ParentId=${albumId}&IncludeItemTypes=Audio&Recursive=true&SortBy=ParentIndexNumber,IndexNumber,SortName`);
  return (r.Items || []).map(jfTrack);
});
ipcMain.handle('jf:search', async (_e, q) => {
  const u = config.jellyfin.userId;
  const enc = encodeURIComponent(q);
  const [tracks, albums] = await Promise.all([
    jf(`/Users/${u}/Items?searchTerm=${enc}&IncludeItemTypes=Audio&Recursive=true&Limit=60`),
    jf(`/Users/${u}/Items?searchTerm=${enc}&IncludeItemTypes=MusicAlbum&Recursive=true&Limit=30`),
  ]);
  return { tracks: (tracks.Items || []).map(jfTrack), albums: (albums.Items || []).map(jfAlbum) };
});
ipcMain.handle('jf:random', async (_e, n = 10) => {
  const u = config.jellyfin.userId;
  const r = await jf(`/Users/${u}/Items?IncludeItemTypes=Audio&Recursive=true&SortBy=Random&Limit=${n}`);
  return (r.Items || []).map(jfTrack);
});
ipcMain.handle('jf:reportPlay', async (_e, id) => {
  try { await jf(`/Users/${config.jellyfin.userId}/PlayedItems/${id}`, { method: 'POST' }); } catch {}
});

// ---------------------------------------------------------------- Local folders
const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.webm']);
let localLib = { albums: [], tracks: [] };
try { localLib = JSON.parse(fs.readFileSync(LOCAL_LIB_PATH(), 'utf8')); } catch {}

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}
function findFolderArt(dir) {
  for (const n of ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png', 'Cover.jpg', 'Folder.jpg', 'AlbumArt.jpg']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return pathToFileURL(p).href;
  }
  return '';
}

async function scanLocal() {
  const mm = await import('music-metadata');
  fs.mkdirSync(ART_DIR(), { recursive: true });
  const files = [];
  for (const f of config.localFolders) walk(f, files);
  const tracks = [];
  const albums = new Map();
  let i = 0;
  for (const file of files) {
    i++;
    if (i % 25 === 0) send('local:progress', { done: i, total: files.length });
    let common = {}, format = {};
    try {
      const meta = await mm.parseFile(file, { duration: false, skipCovers: false });
      common = meta.common || {}; format = meta.format || {};
    } catch {}
    const dir = path.dirname(file);
    const artist = common.albumartist || common.artist || path.basename(path.dirname(dir)) || 'Unknown Artist';
    const albumName = common.album || path.basename(dir);
    const albumKey = crypto.createHash('md5').update(artist.toLowerCase() + '|' + albumName.toLowerCase()).digest('hex');
    let album = albums.get(albumKey);
    if (!album) {
      album = { source: 'local', id: albumKey, title: albumName, artist, year: common.year || '', art: findFolderArt(dir) };
      albums.set(albumKey, album);
    }
    if (!album.art && common.picture && common.picture[0]) {
      const pic = common.picture[0];
      const ext = /png/i.test(pic.format) ? '.png' : '.jpg';
      const artPath = path.join(ART_DIR(), albumKey + ext);
      try { fs.writeFileSync(artPath, pic.data); album.art = pathToFileURL(artPath).href; } catch {}
    }
    tracks.push({
      source: 'local',
      id: crypto.createHash('md5').update(file).digest('hex'),
      title: common.title || path.basename(file, path.extname(file)).replace(/^\d+[\s.\-_]+/, ''),
      artist: common.artist || artist,
      album: albumName,
      albumId: albumKey,
      trackNo: (common.track && common.track.no) || 0,
      disc: (common.disk && common.disk.no) || 1,
      duration: format.duration || 0,
      url: pathToFileURL(file).href,
    });
  }
  for (const t of tracks) t.art = albums.get(t.albumId).art;
  localLib = {
    albums: [...albums.values()].sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title)),
    tracks,
  };
  fs.writeFileSync(LOCAL_LIB_PATH(), JSON.stringify(localLib));
  send('local:progress', { done: files.length, total: files.length, finished: true });
  return { albums: localLib.albums.length, tracks: localLib.tracks.length };
}

ipcMain.handle('local:addFolder', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled) return publicConfig();
  for (const p of r.filePaths) if (!config.localFolders.includes(p)) config.localFolders.push(p);
  saveConfig();
  return publicConfig();
});
ipcMain.handle('local:removeFolder', async (_e, p) => {
  config.localFolders = config.localFolders.filter(f => f !== p);
  saveConfig();
  return publicConfig();
});
ipcMain.handle('local:scan', () => scanLocal());
ipcMain.handle('local:albums', () => localLib.albums);
ipcMain.handle('local:albumTracks', (_e, id) =>
  localLib.tracks.filter(t => t.albumId === id).sort((a, b) => a.disc - b.disc || a.trackNo - b.trackNo || a.title.localeCompare(b.title)));
ipcMain.handle('local:search', (_e, q) => {
  const s = q.toLowerCase();
  const tracks = localLib.tracks.filter(t => (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(s)).slice(0, 80);
  const albums = localLib.albums.filter(a => (a.title + ' ' + a.artist).toLowerCase().includes(s)).slice(0, 40);
  return { tracks, albums };
});
ipcMain.handle('local:random', (_e, n = 10) => {
  const t = localLib.tracks;
  if (!t.length) return [];
  return Array.from({ length: Math.min(n, t.length) }, () => t[Math.floor(Math.random() * t.length)]);
});

// ---------------------------------------------------------------- YouTube Music
let yt = null;
async function getYT() {
  if (yt) return yt;
  const { Innertube } = await import('youtubei.js');
  yt = await Innertube.create({ retrieve_player: false, lang: 'en', location: 'NZ' });
  return yt;
}
function bestThumb(thumbs, square = true) {
  if (thumbs && !Array.isArray(thumbs) && thumbs.contents) thumbs = thumbs.contents;
  if (!thumbs || !thumbs.length) return '';
  const t = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  // Ask Google's image server for a bigger square version when possible
  return square ? (t.url || '').replace(/=w\d+-h\d+/, '=w600-h600') : (t.url || '');
}
const firstArtistId = (list) => { for (const a of list || []) if (a && a.channel_id) return a.channel_id; return ''; };
function ytTrackFromItem(it) {
  const id = it.id || it.video_id;
  if (!id) return null;
  const artists = (it.artists || []).map(a => a.name).filter(Boolean);
  let thumbs = [];
  try { thumbs = it.thumbnails || it.thumbnail || []; } catch {}
  if (!Array.isArray(thumbs) && thumbs.contents) thumbs = thumbs.contents;
  const title = typeof it.title === 'string' ? it.title : (it.title && it.title.toString()) || '';
  return {
    source: 'youtube',
    id,
    title,
    artist: artists.join(', ') || it.author || '',
    artistId: firstArtistId(it.artists) || firstArtistId(it.authors),
    album: (it.album && it.album.name) || '',
    duration: (it.duration && it.duration.seconds) || 0,
    art: bestThumb(thumbs),
  };
}
ipcMain.handle('yt:search', async (_e, q) => {
  const y = await getYT();
  const [songs, artistRes] = await Promise.all([
    y.music.search(q, { type: 'song' }),
    y.music.search(q, { type: 'artist' }).catch(() => null),
  ]);
  const items = [];
  for (const shelf of songs.contents || []) for (const it of shelf.contents || []) {
    if (it.type === 'MusicResponsiveListItem' && (it.item_type === 'song' || it.item_type === 'video' || it.item_type === 'non_music_track')) {
      const t = ytTrackFromItem(it); if (t) items.push(t);
    }
  }
  const artists = [];
  for (const shelf of (artistRes && artistRes.contents) || []) for (const it of shelf.contents || []) {
    if (it.type === 'MusicResponsiveListItem' && it.item_type === 'artist' && it.id && artists.length < 6) {
      const name = it.name || (it.title && it.title.toString()) || '';
      artists.push({ id: it.id, name, art: bestThumb(it.thumbnails), subscribers: it.subscribers || '' });
    }
  }
  return { tracks: items, albums: [], artists };
});

// Artist pages: banner photo + top songs. Cached, since now-playing asks for the same artists a lot.
const artistCache = new Map();
async function ytArtist(id) {
  if (!id) return null;
  if (artistCache.has(id)) return artistCache.get(id);
  const p = (async () => {
    const y = await getYT();
    const a = await y.music.getArtist(id);
    const h = a.header || {};
    const name = h.title ? h.title.toString() : '';
    const banner = bestThumb(h.thumbnail, false) || bestThumb(h.foreground_thumbnail, false);
    const photo = bestThumb(h.foreground_thumbnail) || bestThumb(h.thumbnail);
    let about = '';
    try { about = h.description ? h.description.toString() : ''; } catch {}
    const songs = [];
    for (const sec of a.sections || []) {
      if (sec.type !== 'MusicShelf') continue;
      for (const it of sec.contents || []) {
        const t = it.type === 'MusicResponsiveListItem' ? ytTrackFromItem(it) : null;
        if (t) { if (!t.artist) t.artist = name; if (!t.artistId) t.artistId = id; songs.push(t); }
      }
      if (songs.length) break;
    }
    return { id, name, banner, photo, about: about.slice(0, 400), songs };
  })();
  artistCache.set(id, p);
  p.catch(() => artistCache.delete(id));
  return p;
}
ipcMain.handle('yt:artist', (_e, id) => ytArtist(id));
ipcMain.handle('yt:suggest', async (_e, q) => {
  try {
    const y = await getYT();
    const sections = await y.music.getSearchSuggestions(q);
    const out = [];
    for (const s of sections || []) for (const c of s.contents || []) {
      const txt = c.suggestion ? c.suggestion.toString() : null;
      if (txt) out.push(txt);
    }
    return out.slice(0, 6);
  } catch { return []; }
});
ipcMain.handle('yt:radio', async (_e, videoId, n = 10) => {
  const y = await getYT();
  const panel = await y.music.getUpNext(videoId, true);
  const out = [];
  for (const it of panel.contents || []) {
    const v = it.type === 'PlaylistPanelVideoWrapper' ? it.primary : it;
    if (!v || !v.video_id || v.video_id === videoId) continue;
    out.push({
      source: 'youtube', id: v.video_id, title: v.title ? v.title.toString() : '',
      artist: (v.artists || []).map(a => a.name).join(', ') || v.author || '',
      artistId: firstArtistId(v.artists),
      album: (v.album && v.album.name) || '', duration: (v.duration && v.duration.seconds) || 0,
      art: bestThumb(v.thumbnail),
    });
    if (out.length >= n) break;
  }
  return out;
});

// Hidden player window: music.youtube.com does the actual playback (so a signed-in
// Premium account gets no ads), we drive the <video> element from yt-preload.js.
// Google refuses sign-in from embedded Chromium ("This browser or app may not be secure").
// It accepts Firefox, so the YouTube window presents itself as Firefox ESR everywhere:
// the User-Agent header, navigator.userAgent, and no Chromium client-hint headers.
const FIREFOX_UA = `Mozilla/5.0 (${process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'}; rv:140.0) Gecko/20100101 Firefox/140.0`;
let ytSessionReady = false;
function setupYtSession() {
  if (ytSessionReady) return;
  ytSessionReady = true;
  const ses = session.fromPartition('persist:youtube');
  ses.setUserAgent(FIREFOX_UA, 'en-NZ,en;q=0.9');
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
    h['User-Agent'] = FIREFOX_UA;
    cb({ requestHeaders: h });
  });
}
function ensureYtWin() {
  if (ytWin && !ytWin.isDestroyed()) return ytWin;
  setupYtSession();
  ytWin = new BrowserWindow({
    width: 1100, height: 800, show: false, title: 'YouTube Music — Jukebox',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'yt-preload.js'),
      partition: 'persist:youtube',
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  ytWin.webContents.setUserAgent(FIREFOX_UA);
  ytWin.webContents.setAudioMuted(false);
  // YouTube's page asks "leave site?" while playing; never let that block a new song or quitting.
  ytWin.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  ytWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    ytWin.setAlwaysOnTop(false);
    ytWin.hide();
    ytWin.loadURL('https://music.youtube.com/');
    send('yt:loginClosed');
  });
  ytWin.loadURL('https://music.youtube.com/');
  return ytWin;
}
ipcMain.handle('yt:play', (_e, videoId) => {
  const w = ensureYtWin();
  w.webContents.send('yt:expect', videoId);
  w.loadURL(`https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
});
let ytVolume = typeof config.volume === 'number' ? config.volume : 0.8;
ipcMain.on('yt:getVolume', (e) => { e.returnValue = ytVolume; });
ipcMain.handle('yt:cmd', (_e, cmd, arg) => {
  if (cmd === 'volume' && typeof arg === 'number') ytVolume = arg;
  if (!ytWin || ytWin.isDestroyed()) return;
  ytWin.webContents.send('yt:cmd', cmd, arg);
});
ipcMain.handle('yt:stop', () => {
  if (!ytWin || ytWin.isDestroyed()) return;
  ytWin.webContents.send('yt:cmd', 'stop');
});
ipcMain.handle('yt:showLogin', () => {
  const w = ensureYtWin();
  w.webContents.send('yt:cmd', 'stop');
  w.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F');
  w.setAlwaysOnTop(true, 'screen-saver');
  w.show(); w.focus();
});
ipcMain.handle('yt:hideLogin', () => { if (ytWin && !ytWin.isDestroyed()) ytWin.hide(); });
ipcMain.on('yt:state', (_e, st) => send('yt:state', st));



// ---------------------------------------------------------------- play stats (most played artists)
const STATS_PATH = () => path.join(USER(), 'stats.json');
let stats = { artists: {} };
try { stats = JSON.parse(fs.readFileSync(STATS_PATH(), 'utf8')); if (!stats.artists) stats.artists = {}; } catch {}
let statsTimer = null;
function saveStats() { clearTimeout(statsTimer); statsTimer = setTimeout(() => { try { fs.writeFileSync(STATS_PATH(), JSON.stringify(stats)); } catch {} }, 1000); }
const firstName = (s) => String(s || '').split(/,\s*|\s+&\s+|\s+feat\.?\s+/i)[0].trim();
ipcMain.handle('stats:played', (_e, t) => {
  if (!t || !t.source) return;
  const name = firstName(t.artist);
  if (!name) return;
  const key = t.source + ':' + (t.source === 'youtube' && t.artistId ? t.artistId : name.toLowerCase());
  const a = stats.artists[key] || (stats.artists[key] = { source: t.source, name, artistId: t.artistId || '', count: 0, art: '', photo: '' });
  a.count++; a.last = Date.now(); a.name = name;
  if (t.art) a.art = t.art;
  if (t.artistId) a.artistId = t.artistId;
  saveStats();
});
ipcMain.handle('stats:topArtists', async (_e, source, n = 10) => {
  const list = Object.values(stats.artists).filter(a => !source || a.source === source)
    .sort((a, b) => b.count - a.count || (b.last || 0) - (a.last || 0)).slice(0, n);
  // YouTube artists: use their real photo (fetched once, then remembered)
  await Promise.all(list.filter(a => a.source === 'youtube' && a.artistId && !a.photo).map(async (a) => {
    try { const d = await ytArtist(a.artistId); a.photo = d.photo || d.banner || ''; if (d.name) a.name = d.name; saveStats(); } catch {}
  }));
  return list.map(a => ({ ...a, image: a.photo || a.art }));
});

// ---------------------------------------------------------------- auto-update (GitHub releases)
// Updates come from github.com/ShallowMouse/jukebox-releases (see "publish" in package.json).
// Windows installer + Linux AppImage update silently; the .deb needs an admin password,
// and the portable .exe can't update itself.
let updater = null;
const upd = { state: 'idle', version: null, progress: 0, error: '', kind: 'unsupported', checkedAt: 0 };
function updKind() {
  if (!app.isPackaged) return 'dev';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  if (process.platform === 'win32') return 'nsis';
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'appimage' : 'deb';
  return 'unsupported';
}
function updSend() { send('update:state', { ...upd, current: app.getVersion() }); }
function initUpdater() {
  upd.kind = updKind();
  if (!['nsis', 'appimage', 'deb'].includes(upd.kind)) { updSend(); return; }
  try { updater = require('electron-updater').autoUpdater; } catch (e) { upd.kind = 'unsupported'; return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.logger = { info() {}, warn: console.warn, error: console.error, debug() {} };
  updater.on('checking-for-update', () => { upd.state = 'checking'; upd.error = ''; updSend(); });
  updater.on('update-not-available', () => { upd.state = 'current'; upd.checkedAt = Date.now(); updSend(); });
  updater.on('update-available', (i) => { upd.state = 'downloading'; upd.version = i.version; upd.progress = 0; updSend(); });
  updater.on('download-progress', (p) => { upd.progress = Math.round(p.percent || 0); updSend(); });
  updater.on('update-downloaded', (i) => { upd.state = 'ready'; upd.version = i.version; upd.checkedAt = Date.now(); updSend(); });
  updater.on('error', (e) => { upd.state = 'error'; upd.error = String((e && e.message) || e).split('\n')[0].slice(0, 200); updSend(); });
  const check = () => { if (upd.state !== 'downloading' && upd.state !== 'ready') updater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 30 * 1000);
  setInterval(check, 4 * 60 * 60 * 1000);
}
ipcMain.handle('update:get', () => ({ ...upd, current: app.getVersion() }));
ipcMain.handle('update:check', async () => {
  if (!updater) return { ...upd, current: app.getVersion() };
  try { await updater.checkForUpdates(); } catch {}
  return { ...upd, current: app.getVersion() };
});
ipcMain.handle('update:install', () => {
  if (!updater || upd.state !== 'ready') return false;
  app.isQuitting = true;
  setImmediate(() => updater.quitAndInstall(true, true)); // silent, relaunch afterwards
  return true;
});

// ---------------------------------------------------------------- config / app
ipcMain.handle('config:get', () => publicConfig());
ipcMain.handle('config:set', (_e, patch) => {
  const before = { fullscreen: config.fullscreen, kiosk: config.kiosk };
  for (const k of Object.keys(patch)) if (k !== 'jellyfin' && k in DEFAULTS) config[k] = patch[k];
  saveConfig();
  if (mainWin) {
    if (before.kiosk !== config.kiosk) mainWin.setKiosk(!!config.kiosk);
    if (before.fullscreen !== config.fullscreen) mainWin.setFullScreen(!!config.fullscreen);
  }
  return publicConfig();
});
ipcMain.handle('app:quit', () => app.quit());
ipcMain.handle('app:version', () => app.getVersion());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });
app.on('before-quit', () => { app.isQuitting = true; });
app.whenReady().then(() => {
  installJellyfinHeaderHook();
  createMainWindow();
  if (config.youtube.enabled) setTimeout(ensureYtWin, 1500); // warm up player
  initUpdater();
});
app.on('window-all-closed', () => app.quit());
