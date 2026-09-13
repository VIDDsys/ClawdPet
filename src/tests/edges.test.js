'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { Motion } = require('../lib/motion')
const { footprint, speechPosition } = require('../renderer/geometry')
const area = { x: 0, y: 0, width: 1707, height: 1019 }, size = { width: 421, height: 500 }
const body = { x: 160, y: 290, width: 100, height: 200 }
function inside(m) {
  const b = m.body, a = m.area
  assert.ok(m.x + b.x >= a.x + 1.99)
  assert.ok(m.x + b.x + b.width <= a.x + a.width - 1.99)
  assert.ok(m.y + b.y >= a.y + 1.99)
  assert.ok(m.y + b.y + b.height <= a.y + a.height - 1.99)
}
test('body reaches left/top/right edges while transparent window leaves screen', () => {
  const m = new Motion(area, size); m.setBody(body); m.mode = 'drag'
  m.x = -10000; m.y = -10000; m.constrain()
  assert.equal(m.x, -158); assert.equal(m.y, -288)
  assert.equal(m.x + body.x, 2); assert.equal(m.y + body.y, 2); inside(m)
  m.x = 10000; m.constrain()
  assert.equal(m.x + body.x + body.width, 1705)
  assert.ok(m.x + size.width > area.width); inside(m)
})
test('grounded footer clearance is unchanged by per-pose body height', () => {
  const m = new Motion(area, size), y = m.y
  for (const h of [100, 200, 350]) { m.setBody({ ...body, y: 490 - h, height: h }); assert.equal(m.y, y); inside(m) }
})
test('two-hour walking with sprite bounds never falls or gains vertical drift', () => {
  const m = new Motion(area, size); m.setBody(body); m.setWalk(true, -1)
  const y = m.y; let lo = m.x, hi = m.x
  for (let i = 0; i < 432000; i++) { m.step(1 / 60); assert.equal(m.y, y); inside(m); lo = Math.min(lo, m.x); hi = Math.max(hi, m.x) }
  assert.equal(lo, m.limits.left); assert.equal(hi, m.limits.right)
})
test('negative desktop origin keeps visible body, not window origin, in bounds', () => {
  const m = new Motion({ x: -1920, y: -300, width: 1920, height: 1000 }, size)
  m.setBody(body); m.mode = 'drag'; m.x = -10000; m.y = -10000; m.constrain(); inside(m)
  assert.equal(m.x + body.x, -1918); assert.equal(m.y + body.y, -298)
})
test('pose change at a wall reclamps once and repeated envelopes never drift', () => {
  const m = new Motion(area, size); m.setBody(body); m.x = m.limits.left
  m.setBody({ ...body, x: 100, width: 220 }); inside(m)
  const x = m.x, rev = m.revision
  for (let i = 0; i < 10000; i++) assert.equal(m.setBody({ ...body, x: 100, width: 220 }), false)
  assert.equal(m.x, x); assert.equal(m.revision, rev)
})
test('envelope change during drag rebases origin and does not snap next sample', () => {
  const m = new Motion(area, size); m.setBody(body); m.x = m.limits.left
  m.beginDrag({ x: 30, y: 800 }, 0); m.dragTo({ x: 30, y: 780 }, 30)
  m.setBody({ ...body, x: 100, width: 220 })
  const x = m.x, y = m.y; m.dragTo({ x: 30, y: 780 }, 60)
  assert.equal(m.x, x); assert.equal(m.y, y); inside(m)
})
test('airborne bounces at visible body wall and settles above taskbar', () => {
  for (const vx of [-1800, 1800]) {
    const m = new Motion(area, size); m.setBody(body); m.mode = 'air'; m.y = m.limits.top; m.vx = vx; m.vy = -1800
    for (let i = 0; i < 1800; i++) { m.step(1 / 60); inside(m) }
    assert.equal(m.mode, 'ground'); assert.equal(m.y, area.height - size.height - 2)
  }
})
test('sprite envelope is foot anchored and independent of animation time', () => {
  for (const state of ['idle', 'idle2', 'walk', 'drag', 'fly', 'sleep', 'sit', 'wave', 'cheer', 'clap', 'typing', 'shy', 'pout', 'land']) {
    const r = footprint(150, 270, 421, 500, state)
    assert.ok(Math.abs(r.y + r.height - 490) < 0.00001)
    assert.ok(r.x <= (421 - 150) / 2); assert.ok(r.height >= 270)
  }
  assert.deepEqual(footprint(150, 270, 421, 500, 'fly'), { x: 135.5, y: 220, width: 150, height: 270 })
})
test('speech bubbles remain within visible screen intersection at top corners', () => {
  for (const x of [-150, 1450]) {
    const m = { x, y: -250, workArea: area }
    const room = speechPosition(m, 421, 500, 0, 0, 0)
    const w = Math.min(230, room.maxWidth), h = 60
    const p = speechPosition(m, 421, 500, w, h, 120)
    assert.ok(m.x + p.centerX - w / 2 >= 5.99)
    assert.ok(m.x + p.centerX + w / 2 <= area.width - 5.99)
    assert.ok(m.y + p.top >= 5.99)
    assert.ok(m.y + p.top + h <= area.height - 5.99)
  }
})
test('invalid body reports do not corrupt physical bounds', () => {
  const m = new Motion(area, size); m.setBody(body)
  assert.equal(m.setBody({ ...body, y: NaN }), false)
  assert.equal(m.setBody({ ...body, width: -100 }), false)
  assert.deepEqual(m.body, body)
})
test('completeStream exposes abort() that rejects with err.aborted (offline, no real API)', async () => {
  const ai = require('../lib/ai')
  // 配置指向本机不可达端口，abort 在连接建立前生效——不依赖网络与真实密钥
  const p = ai.completeStream({ baseUrl: 'https://127.0.0.1:9', model: 'test', apiKey: 'test' }, [{ role: 'user', content: 'hi' }], () => {})
  assert.equal(typeof p.abort, 'function')
  p.abort()
  await assert.rejects(p, e => e.aborted === true)
})
test('completeStream rejects cleanly when unconfigured', async () => {
  const ai = require('../lib/ai')
  await assert.rejects(ai.completeStream({}, [{ role: 'user', content: 'hi' }], () => {}), /未配置模型/)
  await assert.rejects(ai.completeStream({ baseUrl: 'https://x.example', model: '', apiKey: 'k' }, [], () => {}), /未配置模型/)
})
test('parseEndpoint tolerates host-only, /v1 and full endpoint URLs', () => {
  const { parseEndpoint } = require('../lib/ai')
  assert.deepEqual(parseEndpoint('https://api.deepseek.com'), { secure: true, host: 'api.deepseek.com', prefix: '' })
  assert.deepEqual(parseEndpoint('https://api.deepseek.com/v1/'), { secure: true, host: 'api.deepseek.com', prefix: '/v1' })
  assert.deepEqual(parseEndpoint('http://127.0.0.1:11434/v1/chat/completions'), { secure: false, host: '127.0.0.1:11434', prefix: '/v1' })
  assert.equal(parseEndpoint('not a url'), null)
})
test('models.sanitize generates ids, repairs active and filters garbage', () => {
  const { sanitize } = require('../lib/models')
  const s = sanitize({ active: 'gone', models: [{ name: 'A', baseUrl: ' https://a/v1 ', model: 'm1', apiKey: 'k1' }, null, { name: 'B', baseUrl: 'https://b', model: 'm2', apiKey: 'k2' }] })
  assert.equal(s.models.length, 2)
  assert.ok(s.models[0].id && s.models[1].id)
  assert.equal(s.models[0].baseUrl, 'https://a/v1')
  assert.equal(s.active, s.models[0].id) // 失效的 active 回落到第一个
  const empty = sanitize(null)
  assert.deepEqual(empty, { active: null, models: [] })
})
