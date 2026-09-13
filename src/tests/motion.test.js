'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Motion, limits, chooseDisplay, releaseVelocity } = require('../lib/motion')
const area = { x: 0, y: 0, width: 1280, height: 680 }
const size = { width: 420, height: 500 }
function inside(m) {
  const l = m.limits
  assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y))
  assert.ok(m.x >= l.left && m.x <= l.right)
  assert.ok(m.y >= l.top && m.y <= l.floor)
}
test('walking for two simulated hours never integrates vertical position', () => {
  const m = new Motion(area, size)
  m.setWalk(true, 1)
  const floor = m.y
  for (let i = 0; i < 60 * 60 * 2 * 60; i++) { m.step(1 / 60, 0.75); assert.equal(m.y, floor); inside(m) }
})
test('DPI-rounded native height and taskbar changes immediately reanchor floor', () => {
  const m = new Motion(area, size)
  m.setWalk(true, -1)
  for (const height of [500, 501, 499, 502, 500]) {
    for (const heightWA of [680, 650, 720, 680]) {
      m.updateGeometry({ ...area, height: heightWA }, { ...size, height })
      m.step(0.016)
      assert.equal(m.y, heightWA - height - 2)
    }
  }
})
test('taskbars on all four edges and negative monitor origins', () => {
  for (const wa of [{ x: 48, y: 0, width: 1232, height: 720 }, { x: 0, y: 48, width: 1280, height: 672 },
    { x: 0, y: 0, width: 1232, height: 720 }, { x: -1920, y: -180, width: 1920, height: 1028 }]) {
    const m = new Motion(wa, size, { x: 100000, y: -100000 })
    assert.equal(m.y + size.height + 2, wa.y + wa.height)
    m.setWalk(true, -1)
    for (let i = 0; i < 10000; i++) { m.step(0.05, 1.3); inside(m) }
  }
})
test('actual fractional-size display geometry remains finite', () => {
  const m = new Motion({ x: -853, y: 0, width: 853, height: 682 }, { width: 421, height: 501 })
  assert.equal(m.limits.floor, 179)
  for (let i = 0; i < 1000; i++) { m.setWalk(true, 1); m.step(0.016); inside(m) }
})
test('tiny desktop has ordered bounds, never oscillates between inverted constraints', () => {
  const m = new Motion({ x: -20, y: 15, width: 300, height: 200 }, size)
  assert.equal(m.limits.left, m.limits.right)
  assert.equal(m.limits.top, m.limits.floor)
  m.setWalk(true); m.step(0.05); inside(m)
})
test('drag uses cursor displacement from original window, not local feedback', () => {
  const m = new Motion(area, size, { x: 300 })
  m.beginDrag({ x: 500, y: 600 }, 0)
  m.dragTo({ x: 502, y: 602 }, 16)
  assert.equal(m.drag.moved, false)
  m.dragTo({ x: 550, y: 500 }, 32)
  assert.equal(m.x, 350)
  assert.equal(m.y, 78)
  m.dragTo({ x: 560, y: 490 }, 48)
  assert.equal(m.x, 360)
  assert.equal(m.y, 68)
})
test('holding pointer still after movement does not reuse stale toss velocity', () => {
  assert.deepEqual(releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 20, x: 100, y: 200 }], 600), { x: 0, y: 0 })
  const m = new Motion(area, size)
  m.beginDrag({ x: 300, y: 600 }, 0)
  m.dragTo({ x: 450, y: 500 }, 30)
  m.dragTo({ x: 450, y: 500 }, 1000)
  const r = m.endDrag(1010)
  assert.equal(r.tossed, false)
  assert.equal(m.vx, 0)
})
test('released drag hovers in place with no gravity, near-floor drops to ground', () => {
  const m = new Motion(area, size)
  m.step(1 / 60) // 让初始 y 固定到 floor
  const floor = m.limits.floor
  // 空中松手：原地悬停，不坠落
  m.beginDrag({ x: 400, y: 600 }, 0)
  m.dragTo({ x: 400, y: 550 }, 30)
  const r = m.endDrag(40)
  assert.equal(r.tossed, false); assert.equal(m.mode, 'hover'); assert.equal(m.y, floor - 50)
  for (let i = 0; i < 600; i++) m.step(1 / 60)
  assert.equal(m.mode, 'hover'); assert.equal(m.y, floor - 50)
  // 贴地松手：正常落地
  m.beginDrag({ x: 400, y: 600 }, 0)
  m.dragTo({ x: 400, y: 700 }, 30)
  m.endDrag(40)
  assert.equal(m.mode, 'ground'); assert.equal(m.y, m.limits.floor)
})
test('cancelled unmoved airborne press discards old upward and lateral velocity', () => {
  const m = new Motion(area, size)
  m.mode = 'air'; m.y = 80; m.vx = 1200; m.vy = -900
  m.beginDrag({ x: 400, y: 300 }, 0)
  m.endDrag(20, true)
  assert.equal(m.vx, 0); assert.equal(m.vy, 0)
  const x = m.x, y = m.y
  m.step(1 / 60)
  assert.equal(m.x, x); assert.ok(m.y > y)
})
test('all launch directions settle and stay inside at low or high frame rates', () => {
  for (const dt of [1 / 240, 1 / 60, 1 / 20]) for (const vx of [-1800, -400, 0, 400, 1800]) for (const vy of [-1800, 0, 1800]) {
    const m = new Motion(area, size)
    m.mode = 'air'; m.y -= 100; m.vx = vx; m.vy = vy
    for (let i = 0; i < Math.ceil(12 / dt); i++) { m.step(dt); inside(m) }
    assert.equal(m.mode, 'ground', `${dt}/${vx}/${vy}`)
  }
})
test('display switch during flight clamps current geometry and still settles', () => {
  const m = new Motion(area, size)
  m.mode = 'air'; m.vy = -1000
  m.step(0.05)
  m.updateGeometry({ x: -1600, y: -200, width: 1600, height: 1000 }, { width: 421, height: 501 })
  for (let i = 0; i < 1000; i++) { m.step(0.016); inside(m) }
  assert.equal(m.mode, 'ground')
})
test('turning walk off takes effect immediately', () => {
  const m = new Motion(area, size)
  m.setWalk(true); m.step(.03)
  m.setWalk(false); const x = m.x
  for (let i = 0; i < 100; i++) m.step(.03)
  assert.equal(m.x, x)
})
test('double begin/release, non-drag click, cancel and reset are idempotent', () => {
  const m = new Motion(area, size)
  assert.equal(m.beginDrag({ x: 400, y: 600 }, 0), true)
  assert.equal(m.beginDrag({ x: 900, y: 300 }, 1), false)
  assert.equal(m.endDrag(10).moved, false)
  assert.equal(m.endDrag(11).moved, false)
  m.reset(); m.reset(); assert.equal(m.mode, 'ground')
})
test('velocity clamp rejects excessive tosses, dt rejects invalid inputs', () => {
  const velocity = releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 1, x: 1e7, y: -1e7 }], 1)
  assert.deepEqual(velocity, { x: 1800, y: -1800 })
  const m = new Motion(area, size, { x: NaN })
  m.step(NaN); m.step(Infinity); inside(m)
})
test('monitor choice uses nearest cursor display and supports removed displays', () => {
  const ds = [{ id: 1, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } }, { id: 2, bounds: { x: 0, y: 0, width: 1280, height: 720 } }]
  assert.equal(chooseDisplay(ds, { x: -800, y: 500 }).id, 1)
  assert.equal(chooseDisplay(ds, { x: 500, y: 500 }).id, 2)
  assert.equal(chooseDisplay([ds[1]], { x: -800, y: 500 }).id, 2)
  assert.equal(limits(area, size).floor, 178)
})
