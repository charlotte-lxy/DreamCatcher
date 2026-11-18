'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  authStatus: () => ipcRenderer.invoke('auth:status'),
  openLogin: () => ipcRenderer.invoke('auth:open'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  clearTasks: () => ipcRenderer.invoke('tasks:clear'),
  listFiles: (filter) => ipcRenderer.invoke('files:list', filter),
  trashFile: (p) => ipcRenderer.invoke('files:trash', p),
  pickDir: () => ipcRenderer.invoke('dialog:pick-dir'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  getUpdateState: () => ipcRenderer.invoke('update:get'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  updateEngine: () => ipcRenderer.invoke('engine:update'),
  testProxy: () => ipcRenderer.invoke('proxy:test'),
  probe: (url) => ipcRenderer.invoke('video:probe', url),
  listUp: (url) => ipcRenderer.invoke('up:list', url),
  download: (payload) => ipcRenderer.invoke('video:download', payload),
  cancel: (id) => ipcRenderer.invoke('video:cancel', id),
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  revealPath: (p) => ipcRenderer.invoke('shell:reveal', p),
  copyText: (t) => ipcRenderer.invoke('clipboard:write', t),
  onTask: (cb) => ipcRenderer.on('task:progress', (_e, ev) => cb(ev)),
  onUpProgress: (cb) => ipcRenderer.on('up:progress', (_e, p) => cb(p)),
  onUpdateChecked: (cb) => ipcRenderer.on('update:checked', (_e, st) => cb(st)),
  onLog: (cb) => ipcRenderer.on('app:log', (_e, line) => cb(line))
})
