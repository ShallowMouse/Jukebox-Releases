// Runs inside the hidden music.youtube.com window. Drives the page's <video> element
// and reports playback state back to the jukebox.
const { ipcRenderer, contextBridge } = require('electron');

// Look like Firefox to Google's scripts too: Firefox has no navigator.userAgentData.
try {
  contextBridge.executeInMainWorld({
    func: () => {
      try { Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true }); } catch {}
      try { delete window.chrome; } catch {}
    },
  });
} catch {}

let expected = null;      // videoId the jukebox asked for
let wantPlaying = false;  // jukebox wants audio running
let volume = (() => { try { return ipcRenderer.sendSync('yt:getVolume'); } catch { return 0.8; } })();

// The jukebox volume is applied *after* YouTube's player (Web Audio gain), so we never fight
// YouTube over video.volume. YouTube keeps doing its own loudness levelling underneath.
let ctx = null, gain = null;
const routed = new WeakSet();
function route(v) {
  if (routed.has(v)) return;
  try {
    if (!ctx) { ctx = new AudioContext(); gain = ctx.createGain(); gain.gain.value = volume; gain.connect(ctx.destination); }
    ctx.createMediaElementSource(v).connect(gain);
    routed.add(v);
  } catch (e) { routed.add(v); }
}
function applyVolume() { if (gain && ctx) gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.04); }
function ytPlayerFull() {
  // Keep YouTube's own volume slider at 100% and unmuted; our gain does the rest.
  try {
    contextBridge.executeInMainWorld({ func: () => {
      const p = document.getElementById('movie_player');
      if (p && p.getVolume && (p.getVolume() !== 100 || (p.isMuted && p.isMuted()))) { p.setVolume(100); if (p.unMute) p.unMute(); }
    } });
  } catch {}
}
setInterval(ytPlayerFull, 2000);
let endedFor = null;
let startedAt = 0;

ipcRenderer.on('yt:expect', (_e, id) => { expected = id; wantPlaying = true; endedFor = null; startedAt = Date.now(); seen = { id: null, time: 0, dur: 0 }; });
ipcRenderer.on('yt:cmd', (_e, cmd, arg) => {
  const v = document.querySelector('video');
  switch (cmd) {
    case 'pause': wantPlaying = false; if (v) v.pause(); break;
    case 'play': wantPlaying = true; if (v) v.play().catch(() => {}); break;
    case 'stop': wantPlaying = false; expected = null; if (v) v.pause(); break;
    case 'seek': if (v && isFinite(arg)) v.currentTime = arg; break;
    case 'volume': volume = Math.max(0, Math.min(1, arg)); applyVolume(); break;
  }
});

function currentId() {
  try { return new URL(location.href).searchParams.get('v'); } catch { return null; }
}

// Report the end of the song the jukebox asked for, exactly once.
function songEnded() {
  if (!expected || endedFor === expected) return;
  endedFor = expected;
  ipcRenderer.send('yt:state', { event: 'ended', videoId: expected });
}
// What we last saw of the requested song actually playing.
let seen = { id: null, time: 0, dur: 0 };
const hooked = new WeakSet();
function hook(v) {
  if (hooked.has(v)) return;
  hooked.add(v);
  // the moment the media element finishes, before YouTube's autoplay moves on
  v.addEventListener('ended', () => {
    if (currentId() === expected && !document.querySelector('.ad-showing, .ad-interrupting')) songEnded();
  });
}

function tick() {
  const v = document.querySelector('video');
  const id = currentId();
  const ad = !!document.querySelector('.ad-showing, .ad-interrupting');

  // Dismiss "Are you still there?" style prompts so the kiosk never stalls.
  const still = document.querySelector('ytmusic-you-there-renderer button, tp-yt-paper-dialog ytmusic-you-there-renderer #button');
  if (still) still.click();

  if (v) {
    hook(v);
    route(v);
    if (expected && id === expected && !ad && v.duration > 0) seen = { id, time: v.currentTime, dur: v.duration };
    // YouTube Music's autoplay jumped to another song after ours: ours has finished.
    if (expected && id && id !== expected && !ad && seen.id === expected && endedFor !== expected) {
      if (!v.paused) v.pause();
      songEnded();
    }
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    v.muted = false;

    // YouTube Music's own autoplay moved on to something we didn't ask for — hold it.
    if (expected && id && id !== expected && !ad) {
      if (!v.paused) v.pause();
    } else if (expected && wantPlaying && v.paused && !v.ended && Date.now() - startedAt > 1200) {
      v.play().catch(() => {});
    }

    const dur = v.duration || 0;
    const isEnd = !ad && expected && id === expected && dur > 0 &&
      (v.ended || (v.currentTime >= dur - 0.35 && v.paused));
    if (isEnd) songEnded();
    ipcRenderer.send('yt:state', {
      event: 'tick', videoId: id, expected, ad,
      paused: v.paused, currentTime: v.currentTime || 0, duration: dur,
      ready: v.readyState >= 2,
    });
  } else {
    ipcRenderer.send('yt:state', { event: 'tick', videoId: id, expected, ad, paused: true, currentTime: 0, duration: 0, ready: false });
  }
}
setInterval(tick, 400);
