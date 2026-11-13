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
let volume = 0.8;
let endedFor = null;
let startedAt = 0;

ipcRenderer.on('yt:expect', (_e, id) => { expected = id; wantPlaying = true; endedFor = null; startedAt = Date.now(); });
ipcRenderer.on('yt:cmd', (_e, cmd, arg) => {
  const v = document.querySelector('video');
  switch (cmd) {
    case 'pause': wantPlaying = false; if (v) v.pause(); break;
    case 'play': wantPlaying = true; if (v) v.play().catch(() => {}); break;
    case 'stop': wantPlaying = false; expected = null; if (v) v.pause(); break;
    case 'seek': if (v && isFinite(arg)) v.currentTime = arg; break;
    case 'volume': volume = Math.max(0, Math.min(1, arg)); if (v) v.volume = volume; break;
  }
});

function currentId() {
  try { return new URL(location.href).searchParams.get('v'); } catch { return null; }
}

function tick() {
  const v = document.querySelector('video');
  const id = currentId();
  const ad = !!document.querySelector('.ad-showing, .ad-interrupting');

  // Dismiss "Are you still there?" style prompts so the kiosk never stalls.
  const still = document.querySelector('ytmusic-you-there-renderer button, tp-yt-paper-dialog ytmusic-you-there-renderer #button');
  if (still) still.click();

  if (v) {
    if (Math.abs(v.volume - volume) > 0.02) v.volume = volume;
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
    if (isEnd && endedFor !== expected) {
      endedFor = expected;
      ipcRenderer.send('yt:state', { event: 'ended', videoId: expected });
    }
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
