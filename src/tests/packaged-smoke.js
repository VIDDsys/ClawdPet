'use strict'
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict')
const { spawn } = require('child_process')
const { setTimeout: delay } = require('timers/promises')
const root = path.resolve(__dirname, '..')
const out = path.resolve(process.env.DESKTOP_PET_TEST_OUTPUT || path.join(os.tmpdir(), 'desktop-pet-test-results'))
const version = require('../package.json').version
const executable = path.resolve(process.env.DESKTOP_PET_EXE || path.join(root, 'dist', 'ClawdPet-' + version + '.exe'))
const profile = path.join(os.tmpdir(), 'desktop-pet-packaged-profile-' + version)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
let child, socket, id = 0
const pending = new Map()
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const token = ++id
    const timeout = setTimeout(() => { pending.delete(token); reject(new Error('CDP timeout: ' + method)) }, 10000)
    pending.set(token, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id: token, method, params }))
  })
}
async function main() {
  const report = { passed: false, executable, isolatedProfile: profile, errors: [] }
  try {
    try { await fetch('http://127.0.0.1:9337/json/version', { signal: AbortSignal.timeout(500) }); throw new Error('Debug port already occupied') }
    catch (e) { if (e.message === 'Debug port already occupied') throw e }
    child = spawn(executable, ['--pet-preview', '--pet-data=' + profile, '--remote-debugging-port=9337', '--remote-debugging-address=127.0.0.1'], { env, stdio: 'ignore' })
    child.on('error', e => report.errors.push(e.message))
    const deadline = Date.now() + 90000
    let targets
    while (Date.now() < deadline) {
      try { targets = await (await fetch('http://127.0.0.1:9337/json/list')).json(); if (targets.some(t => t.type === 'page')) break } catch {}
      await delay(200)
    }
    const page = targets?.find(t => t.type === 'page')
    assert.ok(page?.url.includes('renderer/index.html'), 'Packaged renderer target opened')
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    socket.onmessage = e => {
      const data = JSON.parse(e.data), task = pending.get(data.id)
      if (task) { clearTimeout(task.timeout); pending.delete(data.id); data.error ? task.reject(new Error(data.error.message)) : task.resolve(data.result) }
    }
    let result
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        result = await rpc('Runtime.evaluate', { expression: `(async () => {
      const end=performance.now()+10000;
      while(!document.body || document.body.dataset.ready!=='true') { if(performance.now()>end) throw new Error('Renderer init timeout'); await new Promise(r=>setTimeout(r,50)); }
      const data=await window.pet.getInit();
      return {ready:document.body.dataset.ready, asset:document.querySelector('#pet').naturalWidth, settings:data.settings, motion:data.motion, rawMove:typeof window.pet.moveWindow};
    })()`, awaitPromise: true, returnByValue: true })
        break
      } catch (e) {
        if (!e.message.includes('context was destroyed') || attempt === 4) throw e
        await delay(250)
      }
    }
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    report.runtime = result.result.value
    assert.equal(report.runtime.ready, 'true')
    assert.ok(report.runtime.asset > 0)
    assert.equal(report.runtime.motion.previewMode, true)
    assert.equal(report.runtime.settings.hearts, 0)
    assert.equal(report.runtime.settings.listenKeys, false)
    assert.equal('listenClicks' in require('../lib/settings').DEFAULTS, false)
    assert.equal(report.runtime.settings.autoStart, false)
    assert.equal(report.runtime.rawMove, 'undefined')
    assert.ok(report.runtime.motion.body, 'Packaged renderer publishes sprite collision envelope')
    assert.ok(report.runtime.motion.limits.left < report.runtime.motion.workArea.x, 'Left invisible window wall removed')
    assert.ok(report.runtime.motion.limits.top < report.runtime.motion.workArea.y, 'Top invisible window wall removed')
    assert.ok(report.runtime.motion.limits.right + report.runtime.motion.width > report.runtime.motion.workArea.x + report.runtime.motion.workArea.width, 'Right invisible window wall removed')
    assert.ok(report.runtime.motion.y + report.runtime.motion.height <= report.runtime.motion.workArea.y + report.runtime.motion.workArea.height)
    report.passed = true
    // Electron can close the debugging transport before replying to Browser.close.
    socket.send(JSON.stringify({ id: ++id, method: 'Browser.close' }))
  } catch (e) { report.passed = false; report.errors.push(e.stack || e.message); process.exitCode = 1 }
  finally {
    if (socket) socket.close()
    // Only terminate the exact isolated test process and descendants if it failed to exit.
    if (child && child.exitCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)])
      if (child.exitCode === null) {
        await new Promise(resolve => { const stop = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); stop.once('exit', resolve) })
      }
    }
    fs.writeFileSync(path.join(out, 'packaged-smoke-results.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
