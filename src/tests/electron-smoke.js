'use strict'
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict')
async function run({ app, win, motion, screen, guard, placeWindow, settings, resetPosition, setSetting }) {
  const output = path.resolve(process.env.DESKTOP_PET_TEST_OUTPUT || path.join(os.tmpdir(), 'desktop-pet-test-results'))
  fs.mkdirSync(output, { recursive: true })
  const errors = [], results = []
  const wc = win.webContents
  wc.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text) })
  const evaluate = source => wc.executeJavaScript(source, true)
  const waitFor = condition => evaluate(`new Promise((resolve,reject) => { const end=performance.now()+10000; function check(){ if(${condition}) return resolve(true); if(performance.now()>end) return reject(new Error('Timed out: '+${JSON.stringify(condition)})); setTimeout(check,20); } check(); })`)
  const send = (channel, value) => wc.send(channel, value)
  const announce = () => send('motion-state', { ...motion.snapshot(), visible: true, suspended: false, menuOpen: false, previewMode: true })
  const record = (name, details) => results.push({ name, passed: true, details })
  let exitCode = 0
  try {
    await waitFor("document.body.dataset.ready === 'true'")
    record('Renderer initialization and all image decoding', await evaluate("({ready:document.body.dataset.ready,image:document.querySelector('#pet').naturalWidth})"))
    const security = await evaluate("({node:typeof require,process:typeof process,rawMove:typeof window.pet.moveWindow})")
    assert.deepEqual(security, { node: 'undefined', process: 'undefined', rawMove: 'undefined' })
    record('Sandbox, context isolation and removal of raw-coordinate IPC', security)
    const variants = []
    for (const outfit of ['a']) for (const scale of [0.75, 1, 1.3]) {
      setSetting('outfit', outfit); setSetting('scale', scale)
      for (const state of ['idle', 'idle2', 'wave', 'sleep', 'cheer', 'clap', 'sit', 'typing', 'shy', 'pout', 'land']) {
        resetPosition(); announce(); send('do-action', state)
        await waitFor(`document.body.dataset.state === ${JSON.stringify(state)} && document.querySelector('#pet').complete`)
        const metrics = await evaluate(`(() => {
          const pet=document.querySelector('#pet'), frames=[];
          for (const at of [0, .2, .5, .8, .99]) {
            for(const animation of pet.getAnimations()) { animation.pause(); animation.currentTime=Number(animation.effect.getTiming().duration)*at; }
            const r=pet.getBoundingClientRect(); frames.push({x:r.x,y:r.y,right:r.right,bottom:r.bottom});
          }
          // Explicit WAAPI play() can detach a sampled CSS animation from later
          // class changes. Cancel test-controlled effects rather than leaking
          // old land/shy transforms into the subsequent fly regression.
          for(const animation of pet.getAnimations()) animation.cancel();
          return {frames,width:innerWidth,height:innerHeight,src:pet.getAttribute('src'),naturalWidth:pet.naturalWidth};
        })()`)
        assert.ok(metrics.naturalWidth > 0, `${outfit}/${scale}/${state} decoded`)
        for (const r of metrics.frames) {
          assert.ok(r.x >= -1 && r.right <= metrics.width + 1 && r.y >= -1 && r.bottom <= metrics.height - 9, JSON.stringify({ outfit, scale, state, r, metrics }))
        }
        variants.push({ outfit, scale, state, maxBottom: Math.max(...metrics.frames.map(f => f.bottom)) })
      }
      if (scale === 1.3) {
        resetPosition(); announce(); send('do-action', 'wave')
        await waitFor("document.body.dataset.state === 'wave'")
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        const shot = await wc.capturePage()
        assert.ok(!shot.isEmpty())
        fs.writeFileSync(path.join(output, `DesktopPet-outfit-${outfit}.png`), shot.toPNG())
      }
    }
    record('36 outfit / size / pose combinations, 180 sampled motion phases without clipping', variants)
    record('Walking removed: no walk pose in assets or runtime states', {})
    setSetting('listenKeys', true); setSetting('quietMode', false)
    resetPosition(); announce(); send('hook-key', 1)
    await waitFor("document.body.dataset.state === 'typing'")
    setSetting('quietMode', true)
    await waitFor("document.body.dataset.state === 'idle'")
    record('Quiet mode interrupts typing response', {})
    setSetting('quietMode', false)
    resetPosition(); announce(); send('do-action', 'sleep')
    await waitFor("document.body.dataset.state === 'sleep'")
    const click = await evaluate("window.pet.pressStart().then(() => window.pet.pressEnd(false))")
    assert.equal(click.moved, false)
    record('Real preload/main press IPC round trip', click)
    // Force deterministic main-owned trajectory without moving the user's pointer.
    motion.reset(); motion.setWalk(true, 1)
    const ys = new Set(), actualBounds = []
    for (let i = 0; i < 1000; i++) {
      motion.step(1 / 60, .75); placeWindow()
      if (i % 120 === 0) guard()
      const b = win.getBounds(); ys.add(b.y)
      assert.ok(b.y + b.height <= motion.area.y + motion.area.height + 1, JSON.stringify({ i, b, model: motion.snapshot(), actualBounds }))
      if (i % 250 === 0) actualBounds.push(b)
    }
    assert.ok(ys.size <= 2, `Native y drift: ${[...ys]}`)
    record('1000 native window moves with production guard cadence preserve floor under real DPI', { yPositions: [...ys], bounds: actualBounds, displays: screen.getAllDisplays().map(d => ({ id: d.id, scale: d.scaleFactor, bounds: d.bounds, workArea: d.workArea })) })
    motion.mode = 'air'; motion.y -= 60; motion.vy = -600; motion.vx = 0; announce()
    await waitFor("document.body.dataset.state === 'fly'")
    send('do-action', 'wave')
    assert.equal(await evaluate("document.body.dataset.state"), 'fly')
    motion.reset(); announce()
    await waitFor("document.body.dataset.state === 'wave'")
    record('Interaction queues until landing without freezing flight', {})
    // Regression for the former invisible 420x500 movement cage. Move the real
    // native window outside the screen while keeping the sprite at its edges.
    const edges = []
    for (const outfit of ['a']) for (const scale of [0.75, 1, 1.3]) {
    resetPosition(); announce()
    setSetting('scale', scale); setSetting('outfit', outfit)
    resetPosition(); announce(); send('do-action', 'wave')
    await waitFor("document.body.dataset.state === 'wave'")
    motion.mode = 'air'; motion.vx = motion.vy = 0; announce()
    await waitFor("document.body.dataset.state === 'fly'")
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    assert.ok(motion.body && motion.body.x > 40 && motion.body.y > 80)
    for (const side of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      motion.x = side.endsWith('left') ? motion.limits.left : motion.limits.right
      motion.y = side.startsWith('top') ? motion.limits.top : motion.limits.floor
      motion.constrain(); placeWindow(); announce()
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
      const b = win.getBounds(), wa = motion.area
      const rect = await evaluate("(() => { const r=document.querySelector('#pet').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,state:document.body.dataset.state,css:document.querySelector('#pet').className,style:document.querySelector('#pet').style.cssText}; })()")
      const world = { left: b.x + rect.x, top: b.y + rect.y, right: b.x + rect.x + rect.width, bottom: b.y + rect.y + rect.height }
      assert.ok(world.left >= wa.x - 1 && world.right <= wa.x + wa.width + 1 && world.top >= wa.y - 1 && world.bottom <= wa.y + wa.height, JSON.stringify({ outfit, scale, side, b, rect, world, wa, body: motion.body, mode: motion.mode }))
      if (side.endsWith('left')) assert.ok(world.left - wa.x <= 7, JSON.stringify(world))
      else assert.ok(wa.x + wa.width - world.right <= 7, JSON.stringify(world))
      if (side.startsWith('top')) { assert.ok(world.top - wa.y <= 7, JSON.stringify(world)); assert.ok(b.y < wa.y) }
      if (side.endsWith('left')) assert.ok(b.x < wa.x)
      else assert.ok(b.x + b.width > wa.x + wa.width)
      edges.push({ outfit, scale, side, nativeBounds: b, spriteOnScreen: world, workArea: wa })
    }
    }
    record('Both outfits and all three scales reach all four work-area corners (24 combinations)', edges)
    resetPosition(); announce()
    assert.equal(errors.length, 0, errors.join('\n'))
    record('No renderer console errors', {})
  } catch (e) {
    exitCode = 1; errors.push(e.stack || e.message)
    console.error('[smoke failure]', e)
  } finally {
    const report = { passed: exitCode === 0, electron: process.versions.electron, platform: process.platform, testIsolation: app.getPath('userData'), results, errors }
    fs.writeFileSync(path.join(output, 'electron-smoke-results.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ passed: report.passed, checks: results.length, errors }))
    app.exit(exitCode)
  }
}
module.exports = { run }
