'use strict'
// 悬停位置持久化专项（PET-01）：悬停状态保存/恢复、落地只取 x、姿态标记进出 sanitize。
const test = require('node:test')
const assert = require('node:assert/strict')
const { Motion } = require('../lib/motion')
const { sanitize } = require('../lib/settings')

const area = { x: 0, y: 0, width: 1707, height: 1019 }, size = { width: 421, height: 500 }

test('released mid-air drag hovers and constructor restores hover position + mode', () => {
  const m = new Motion(area, size)
  const floor = m.limits.floor
  m.beginDrag({ x: 800, y: floor - 300 }, 0)
  m.dragTo({ x: 800, y: floor - 340 }, 50) // 向上拖离地面，松手即悬停
  const r = m.endDrag(100, false)
  assert.equal(r.moved, true); assert.equal(m.mode, 'hover')
  assert.ok(m.y < floor, '悬停必须离开地面')
  const saved = { x: Math.round(m.x), y: Math.round(m.y), mode: 'hover' }
  // 重建（模拟重启恢复）：位置与姿态都要回来
  const m2 = new Motion(area, size, saved)
  assert.equal(m2.mode, 'hover', '重启后应恢复悬停姿态')
  assert.equal(m2.x, saved.x)
  assert.equal(m2.y, saved.y, '悬停高度不得被拉回地面')
})

test('ground restore keeps x and re-floors y (taskbar/resolution changes)', () => {
  const m = new Motion(area, size, { x: 500, y: 123, mode: 'ground' })
  assert.equal(m.mode, 'ground')
  assert.equal(m.x, 500)
  assert.equal(m.y, m.limits.floor, '落地态 y 交给 constrain 贴地')
})

test('legacy lastPos without mode still restores as ground', () => {
  const m = new Motion(area, size, { x: 900, y: 400 })
  assert.equal(m.mode, 'ground')
  assert.equal(m.x, 900)
})

test('settings sanitize keeps only hover/ground mode markers', () => {
  const s = sanitize({ lastPos: { x: 10, y: 20, mode: 'hover' } })
  assert.equal(s.lastPos.mode, 'hover')
  const g = sanitize({ lastPos: { x: 10, y: 20, mode: 'ground' } })
  assert.equal(g.lastPos.mode, 'ground')
  const junk = sanitize({ lastPos: { x: 10, y: 20, mode: 'air' } })
  assert.equal(junk.lastPos.mode, undefined, '非法姿态标记不落盘')
  const none = sanitize({ lastPos: { x: 10, y: 20 } })
  assert.equal(none.lastPos.mode, undefined)
})
