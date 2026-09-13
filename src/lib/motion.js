'use strict'

// All values are Electron screen DIPs. This model, owned by main, is the only
// writer of window position. Renderer screenX/Y never enter this coordinate space.
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback
const clamp = (n, lo, hi) => Math.max(lo, Math.min(finite(n, lo), Math.max(lo, hi)))
const GAP = 2
function limits(area, size, body) {
  // The transparent window may extend past the display. Only the visible
  // sprite (plus its small, stable pose envelope) must remain in the work area.
  const b = body || { x: 0, y: 0, width: size.width, height: size.height }
  const left = area.x + GAP - b.x
  const top = area.y + GAP - b.y
  return {
    left,
    right: Math.max(left, area.x + area.width - b.x - b.width - GAP),
    top,
    // Keep the existing footer/shadow clearance above the taskbar. Transparent
    // top/side padding is not a wall, but the footer remains a deliberate gap.
    floor: Math.max(top, area.y + area.height - Math.max(b.y + b.height, size.height) - GAP)
  }
}
function chooseDisplay(displays, point) {
  return displays.reduce((best, d) => {
    const r = d.bounds || d.workArea
    const dx = point.x - clamp(point.x, r.x, r.x + r.width)
    const dy = point.y - clamp(point.y, r.y, r.y + r.height)
    const distance = dx * dx + dy * dy
    return !best || distance < best.distance ? { d, distance } : best
  }, null)?.d
}
function releaseVelocity(samples, now) {
  const recent = samples.filter(s => now - s.t <= 120 && now >= s.t)
  if (recent.length < 2 || now - recent[recent.length - 1].t > 65) return { x: 0, y: 0 }
  const a = recent[0], b = recent[recent.length - 1]
  const dt = Math.max(16, b.t - a.t) / 1000
  return { x: clamp((b.x - a.x) / dt, -1800, 1800), y: clamp((b.y - a.y) / dt, -1800, 1800) }
}
class Motion {
  constructor(area, size, position = {}) {
    this.area = { ...area }
    this.size = { ...size }
    this.body = null
    this.x = finite(position.x, area.x + (area.width - size.width) / 2)
    this.y = 0
    this.vx = 0
    this.vy = 0
    this.mode = 'ground'
    this.dir = -1
    this.walking = false
    this.drag = null
    this.revision = 0
    this.constrain()
  }
  get limits() { return limits(this.area, this.size, this.body) }
  setBody(rect) {
    if (!rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k])) || rect.width <= 0 || rect.height <= 0) return false
    if (this.body && ['x', 'y', 'width', 'height'].every(k => Math.abs(this.body[k] - rect[k]) < 0.01)) return false
    const before = { x: this.x, y: this.y }
    this.body = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    this.constrain()
    // A resize or pose change must not make the next drag sample jump back to
    // the old origin. Ordinary cursor motion retains the original drag anchor.
    if (this.drag) {
      this.drag.origin.x += this.x - before.x
      this.drag.origin.y += this.y - before.y
    }
    this.revision++
    return true
  }
  constrain() {
    const l = this.limits
    this.x = clamp(this.x, l.left, l.right)
    this.y = this.mode === 'ground' ? l.floor : clamp(this.y, l.top, l.floor)
  }
  updateGeometry(area, size) {
    this.area = { ...area }
    this.size = { ...size }
    this.constrain()
    this.revision++
  }
  setWalk(enabled, direction) {
    this.walking = !!enabled && this.mode === 'ground'
    if (direction === 1 || direction === -1) this.dir = direction
  }
  beginDrag(cursor, time) {
    if (this.drag) return false
    this.drag = { cursor: { ...cursor }, origin: { x: this.x, y: this.y },
      moved: false, previousMode: this.mode, samples: [{ ...cursor, t: time }] }
    this.walking = false
    return true
  }
  dragTo(cursor, time) {
    if (!this.drag) return
    const d = this.drag
    const dx = cursor.x - d.cursor.x, dy = cursor.y - d.cursor.y
    d.samples.push({ ...cursor, t: time })
    d.samples = d.samples.filter(s => time - s.t <= 150).slice(-24)
    if (!d.moved && Math.hypot(dx, dy) < 6) return
    d.moved = true
    this.mode = 'drag'
    this.x = d.origin.x + dx
    this.y = d.origin.y + dy
    this.vx = this.vy = 0
    this.constrain()
  }
  endDrag(time, cancelled = false) {
    if (!this.drag) return { moved: false, cancelled }
    const d = this.drag
    this.drag = null
    if (!d.moved) {
      this.mode = d.previousMode
      if (cancelled && this.mode === 'air') this.vx = this.vy = 0
      return { moved: false, cancelled }
    }
    // 悬停模式：松手即停在原地，无抛飞、无重力。贴近地面则正常落地。
    this.vx = this.vy = 0
    if (this.y >= this.limits.floor) this.ground()
    else this.mode = 'hover'
    return { moved: true, cancelled, tossed: false }
  }
  ground() {
    this.mode = 'ground'
    this.vx = this.vy = 0
    this.constrain()
  }
  reset() {
    this.drag = null
    this.walking = false
    this.ground()
  }
  step(dt, scale = 1) {
    dt = clamp(dt, 0, 0.05)
    if (this.drag) return { landed: false, bounced: false }
    const l = this.limits
    let bounced = false, landed = false
    if (this.mode === 'ground') {
      // Never integrate y while walking, even after DPI/taskbar/workArea changes.
      this.y = l.floor
      if (this.walking) {
        this.x += this.dir * 62 * scale * dt
        if (this.x <= l.left) { this.x = l.left; this.dir = 1 }
        if (this.x >= l.right) { this.x = l.right; this.dir = -1 }
      }
    } else if (this.mode === 'hover') {
      // 悬停：位置保持不变，仅随屏幕几何变化重新约束。
      this.constrain()
    } else if (this.mode === 'air') {
      // Small substeps make bounces converge at both low and high frame rates.
      let remaining = dt
      while (remaining > 0 && this.mode === 'air') {
        const h = Math.min(remaining, 1 / 120)
        remaining -= h
        this.vy += 2400 * h
        this.x += this.vx * h
        this.y += this.vy * h
        if (this.x <= l.left && this.vx < 0) { this.x = l.left; this.vx *= -0.45; bounced = true }
        if (this.x >= l.right && this.vx > 0) { this.x = l.right; this.vx *= -0.45; bounced = true }
        if (this.y <= l.top && this.vy < 0) { this.y = l.top; this.vy *= -0.3 }
        if (this.y >= l.floor && this.vy >= 0) {
          this.y = l.floor
          if (this.vy > 240 && l.floor > l.top) {
            this.vy *= -0.36
            this.vx *= 0.66
            bounced = true
          } else { this.ground(); landed = true }
        }
        this.constrain()
      }
    }
    this.constrain()
    return { landed, bounced }
  }
  snapshot() {
    return { x: this.x, y: this.y, width: this.size.width, height: this.size.height,
      mode: this.mode, dir: this.dir, vx: this.vx, vy: this.vy, walking: this.walking,
      floor: this.limits.floor, workArea: { ...this.area }, body: this.body ? { ...this.body } : null,
      limits: this.limits, revision: this.revision,
      dragging: !!this.drag, moved: !!this.drag?.moved }
  }
}
module.exports = { Motion, limits, chooseDisplay, releaseVelocity, clamp, finite }
