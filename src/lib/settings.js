'use strict'
const fs = require('fs')
const path = require('path')
const DEFAULTS = Object.freeze({ outfit: 'a', scale: 1, walkEnabled: true, listenKeys: true,
  soundEnabled: true, autoStart: false, hearts: 0, lastPos: null,
  reducedMotion: false, quietMode: false })
function sanitize(input) {
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const s = { ...obj, ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[k] === 'boolean' && typeof obj[k] === 'boolean') s[k] = obj[k]
  }
  s.outfit = 'a' // 只有 Clawd 一套皮肤
  s.scale = [0.75, 1, 1.3].includes(obj.scale) ? obj.scale : 1
  s.hearts = Number.isFinite(obj.hearts) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(obj.hearts))) : 0
  if (obj.lastPos && Number.isFinite(obj.lastPos.x) && Number.isFinite(obj.lastPos.y)) {
    s.lastPos = { x: Math.round(obj.lastPos.x), y: Math.round(obj.lastPos.y) }
  }
  return s
}
function load(file) {
  for (const p of [file, file + '.bak']) {
    try {
      const value = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid settings')
      return { settings: sanitize(value), source: p }
    } catch (e) { if (e.code !== 'ENOENT') console.warn('[settings]', p, e.message) }
  }
  return { settings: sanitize(null), source: null }
}
function persist(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(sanitize(settings), null, 2), { encoding: 'utf8', mode: 0o600 })
  // A corrupt original must not overwrite the last known-good backup.
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data && !Array.isArray(data) && typeof data === 'object') fs.copyFileSync(file, file + '.bak')
    } catch (e) { console.warn('[settings] Keeping recovery backup:', e.message) }
  }
  fs.renameSync(tmp, file)
}
module.exports = { DEFAULTS, sanitize, load, persist }
