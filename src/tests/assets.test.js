'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const petDir = path.join(root, 'assets', 'pet')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'manifest.json'), 'utf8'))
// GIF 素材：Clawd 单皮肤（land 复用 idle，walk 已随满画幅素材一并移除）。
const required = [
  'idle-a', 'idle2-a', 'wave-a', 'sleep-a', 'cheer-a', 'clap-a', 'sit-a',
  'typing-a', 'shy-a', 'pout-a', 'error-a', 'sweep-a', 'groove-a'
].sort()
const bases = dir => fs.readdirSync(dir).filter(name => name.endsWith('.gif')).map(name => path.basename(name, '.gif')).sort()

test('runtime GIF assets and manifest contain exactly the supported 13 poses', () => {
  assert.deepEqual(bases(petDir), required)
  assert.deepEqual(Object.keys(manifest).sort(), required)
})

test('every runtime GIF is a valid GIF and matches its manifest dimensions', () => {
  for (const name of bases(petDir)) {
    const data = fs.readFileSync(path.join(petDir, name + '.gif'))
    assert.equal(data.slice(0, 3).toString(), 'GIF', name + ' is not a GIF')
    const w = data.readUInt16LE(6), h = data.readUInt16LE(8)
    const meta = manifest[name]
    assert.ok(meta, name + ' missing from manifest')
    assert.equal(w, meta.w, name + ' width')
    assert.equal(h, meta.h, name + ' height')
    for (const key of ['w', 'h', 'rawW', 'rawH']) {
      assert.ok(Number.isInteger(meta[key]) && meta[key] > 0, `${name}.${key}`)
    }
  }
})

test('all runtime assets required by packaging exist', () => {
  for (const name of ['icon.ico', 'icon.png', 'tray.png', 'manifest.json']) {
    const file = path.join(root, 'assets', name)
    assert.ok(fs.statSync(file).size > 0, name)
  }
})

test('chat window assets exist', () => {
  for (const name of ['chat.html', 'chat.css', 'chat.js']) {
    assert.ok(fs.statSync(path.join(root, 'renderer', name)).size > 0, name)
  }
  assert.ok(fs.statSync(path.join(root, 'lib', 'ai.js')).size > 0, 'lib/ai.js')
})
