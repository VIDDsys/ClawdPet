/* Stable, unanimated sprite envelopes shared by renderer and regression tests. */
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.petGeometry = api
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict'
  function footprint(width, height, viewportWidth, viewportHeight, state, reduced = false) {
    // Largest transforms used by each pose. Do not sample getBoundingClientRect
    // each frame for collision: animation would move the physical walls.
    const shapes = {
      idle: [1.008, 1.012, 0, 0], idle2: [1.012, 1, 1, 0], walk: [1.012, 1.01, 3, 0],
      drag: [1, 1.018, 0, 0], fly: [1, 1, 0, 0], sleep: [1.015, 1.025, 0, 0],
      sit: [1.008, 1.012, 0, 0], wave: [1.018, 1.005, 2, 0], cheer: [1.035, 1.025, 19, 0],
      clap: [1.012, 1, 2, 0], typing: [1.012, 1, 2, 0], shy: [1, 1.008, 0, 0],
      pout: [1, 1, 0, 2], land: [1.07, 1.025, 0, 0],
      error: [1, 1, 0, 0], sweep: [1, 1, 0, 0], groove: [1, 1, 0, 0]
    }
    const [sx, sy, rise, sway] = reduced ? [1, 1, 0, 0] : (shapes[state] || shapes.idle)
    const w = width * sx + 2 * sway
    const h = height * sy + rise
    return { x: (viewportWidth - w) / 2, y: viewportHeight - 10 - h, width: w, height: h }
  }
  function speechPosition(motion, viewportWidth, viewportHeight, width, height, preferredTop) {
    const clamp = (v, a, b) => Math.max(a, Math.min(v, Math.max(a, b)))
    const wa = motion.workArea
    const left = Math.max(0, wa.x - motion.x) + 6
    const right = Math.min(viewportWidth, wa.x + wa.width - motion.x) - 6
    const top = Math.max(0, wa.y - motion.y) + 6
    const bottom = Math.min(viewportHeight, wa.y + wa.height - motion.y) - 6
    return {
      maxWidth: Math.max(24, right - left),
      centerX: clamp(viewportWidth / 2, left + width / 2, right - width / 2),
      top: clamp(preferredTop, top, bottom - height)
    }
  }
  return { footprint, speechPosition }
})
