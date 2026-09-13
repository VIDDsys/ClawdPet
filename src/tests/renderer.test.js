'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), path = require('path'), vm = require('vm')
function harness() {
  const callbacks = {}, handlers = {}, endCalls = [], startCalls = []
  const elements = new Map()
  function element(id) {
    if (elements.has(id)) return elements.get(id)
    const el = { style: {}, dataset: {}, className: '', classList: { add() {}, remove() {}, toggle() {} },
      getBoundingClientRect: () => ({ x: 100, y: 200, top: 200, left: 100, right: 250, bottom: 490, width: 150, height: 290 }),
      addEventListener: (name, cb) => { handlers[id + ':' + name] = cb }, setPointerCapture() {}, releasePointerCapture() {},
      querySelectorAll: () => [], appendChild() {}, remove() {} }
    elements.set(id, el); return el
  }
  const document = { getElementById: element, body: element('body'), createElement: () => element('heart') }
  const api = { on: (ch, fn) => { callbacks[ch] = fn }, getInit: () => new Promise(() => {}),
    pressStart: () => { startCalls.push(1); return Promise.resolve(true) },
    pressEnd: () => new Promise(resolve => endCalls.push(resolve)), walk() {}, hitRect() {}, bodyRect() {}, addHearts() {}, openMenu() {}, uiOpen() {}, quickAction: async () => ({ ok: true }) }
  const context = vm.createContext({ console, document, window: { pet: api, petGeometry: require('../renderer/geometry'), addEventListener() {} }, performance: { now: () => 1000 },
    innerWidth: 420, innerHeight: 500, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {}, Image: class {}, AudioContext: class {} })
  const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const injection = `window.test = {
    seed() { settings={outfit:'a',scale:1,walkEnabled:true,soundEnabled:false,quietMode:false}; manifest={'idle-a1':{w:306,h:640,rawH:2147},'walk-a':{w:359,h:640,rawH:2155}}; motion={mode:'ground',visible:true,walking:false,dragging:false}; },
    startWalk() { state='walk'; motion.walking=true; },
    inspect() { return {state, pressed:!!pressed, endingPress, pressPending}; }
  };`
  vm.runInContext(code.replace('  init().catch', injection + '\n  init().catch'), context)
  context.window.test.seed()
  return { callbacks, handlers, endCalls, startCalls, probe: context.window.test }
}
const pointer = () => ({ button: 0, pointerId: 1, clientY: 240, preventDefault() {} })
test('old cancelled IPC reply cannot clear a new pointer gesture', async () => {
  const h = harness()
  await h.handlers['pet:pointerdown'](pointer())
  h.handlers['pet:pointercancel']()
  h.callbacks['motion-event']({ type: 'release', cancelled: true })
  assert.equal(h.probe.inspect().endingPress, true)
  await h.handlers['pet:pointerdown'](pointer())
  assert.equal(h.startCalls.length, 1, 'new press blocked until old cleanup ends')
  h.endCalls[0]({ moved: false, cancelled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.probe.inspect().endingPress, false)
  await h.handlers['pet:pointerdown'](pointer())
  assert.equal(h.startCalls.length, 2)
  h.handlers['pet:pointerup'](pointer())
  assert.equal(h.endCalls.length, 2)
  h.endCalls[1]({ moved: false, cancelled: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.probe.inspect().pressed, false)
})
