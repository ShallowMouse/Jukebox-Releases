const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('jb', {
  config: { get: inv('config:get'), set: inv('config:set') },
  jf: {
    connect: inv('jf:connect'), disconnect: inv('jf:disconnect'),
    albums: inv('jf:albums'), albumTracks: inv('jf:albumTracks'),
    search: inv('jf:search'), random: inv('jf:random'), reportPlay: inv('jf:reportPlay'),
  },
  local: {
    addFolder: inv('local:addFolder'), removeFolder: inv('local:removeFolder'), scan: inv('local:scan'),
    albums: inv('local:albums'), albumTracks: inv('local:albumTracks'),
    search: inv('local:search'), random: inv('local:random'),
    onProgress: (fn) => ipcRenderer.on('local:progress', (_e, p) => fn(p)),
  },
  yt: {
    search: inv('yt:search'), suggest: inv('yt:suggest'), radio: inv('yt:radio'),
    play: inv('yt:play'), cmd: inv('yt:cmd'), stop: inv('yt:stop'),
    showLogin: inv('yt:showLogin'), hideLogin: inv('yt:hideLogin'),
    onState: (fn) => ipcRenderer.on('yt:state', (_e, s) => fn(s)),
  },
  app: { quit: inv('app:quit'), version: inv('app:version') },
  update: {
    get: inv('update:get'), check: inv('update:check'), install: inv('update:install'),
    onState: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s)),
  },
});
