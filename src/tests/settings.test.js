'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { sanitize, load, persist } = require('../lib/settings')
test('old settings preserve love, outfit, size, position and every switch', () => {
  const previous = { outfit: 'a', scale: 0.75, walkEnabled: true, listenKeys: true, listenClicks: true,
    soundEnabled: true, autoStart: true, hearts: 524, lastPos: { x: 1118, y: 559 } }
  const s = sanitize(previous)
  for (const [k, v] of Object.entries(previous)) assert.deepEqual(s[k], v)
  assert.equal(s.quietMode, false); assert.equal(s.reducedMotion, false)
})
test('invalid persisted values cannot inject NaN, invalid scales or negative love', () => {
  const s = sanitize({ outfit: 'bad', scale: 1e99, hearts: -1, lastPos: { x: NaN, y: 5 }, walkEnabled: 'false' })
  assert.equal(s.outfit, 'a'); assert.equal(s.scale, 1); assert.equal(s.hearts, 0)
  assert.equal(s.lastPos, null); assert.equal(s.walkEnabled, true)
  assert.equal(sanitize(null).hearts, 0); assert.equal(sanitize([]).hearts, 0)
})
test('unknown forward-compatible settings survive normalization', () => {
  assert.equal(sanitize({ futurePreference: 'retained', hearts: 990 }).futurePreference, 'retained')
})
test('atomic save, last-known-good backup and corrupt-primary recovery', () => {
  // Test-owned temporary files only; no user settings file is accessed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-test-'))
  const file = path.join(dir, 'settings.json')
  persist(file, { hearts: 524, scale: .75 })
  persist(file, { hearts: 525, scale: .75 })
  assert.equal(load(file).settings.hearts, 525)
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak')).hearts, 524)
  fs.writeFileSync(file, '{broken')
  const recovered = load(file)
  assert.equal(recovered.settings.hearts, 524)
  assert.equal(recovered.source, file + '.bak')
  persist(file, recovered.settings)
  assert.equal(load(file).settings.hearts, 524)
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak')).hearts, 524)
  assert.equal(fs.existsSync(file + '.tmp'), false)
  for (const f of [file, file + '.bak']) fs.unlinkSync(f)
  fs.rmdirSync(dir)
})
