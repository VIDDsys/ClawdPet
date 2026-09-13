'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const ALLOWED = new Set(['do-action', 'apply-settings', 'hook-key', 'motion-state', 'motion-event', 'notice', 'menu-closed',
  'chat-chunk', 'chat-done', 'chat-msg', 'chat-aborted', 'chat-tool', 'models-saved'])
contextBridge.exposeInMainWorld('pet', Object.freeze({
  getInit: () => ipcRenderer.invoke('get-init'),
  pressStart: () => ipcRenderer.invoke('press-start'),
  pressEnd: cancelled => ipcRenderer.invoke('press-end', cancelled === true),
  hitRect: rect => ipcRenderer.send('hit-rect', rect),
  bodyRect: rect => ipcRenderer.send('body-rect', rect),
  openMenu: () => ipcRenderer.send('open-menu'),
  addHearts: n => ipcRenderer.send('add-hearts', n),
  resetPosition: () => ipcRenderer.send('reset-position'),
  uiOpen: open => ipcRenderer.send('ui-open', open === true),
  quickAction: name => ipcRenderer.invoke('quick-action', name),
  modelsGet: () => ipcRenderer.invoke('models-get'),
  modelsSave: state => ipcRenderer.send('models-save', state),
  agentsGet: () => ipcRenderer.invoke('agents-get'),
  agentsSave: text => ipcRenderer.invoke('agents-save', text),
  chatSend: text => ipcRenderer.send('chat-send', String(text).slice(0, 30000)),
  chatClear: () => ipcRenderer.send('chat-clear'),
  on: (channel, callback) => {
    if (!ALLOWED.has(channel) || typeof callback !== 'function') return () => {}
    const listener = (_event, data) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}))
contextBridge.exposeInMainWorld('petChatBridge', Object.freeze({
  send: text => ipcRenderer.send('chat-send', String(text).slice(0, 30000)),
  clear: () => ipcRenderer.send('chat-clear'),
  stop: () => ipcRenderer.send('chat-stop')
}))
