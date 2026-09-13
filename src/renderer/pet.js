(() => {
  'use strict'
  const api = window.pet
  const pet = document.getElementById('pet')
  const wrap = document.getElementById('pet-wrap')
  const bubbleEl = document.getElementById('bubble') // v2.1 起无气泡元素，保留 null 安全
  const stage = document.getElementById('stage')
  const BASE_H = 240, FOOT_INSET = 10
  // GIF 素材：a = Clawd 小螃蟹，b = Calico 小猫。状态 → 文件名（不含扩展名）。
  const IMAGES = {
    idle: o => 'idle-' + o, idle2: o => 'idle2-' + o,
    wave: o => 'wave-' + o, sleep: o => 'sleep-' + o, cheer: o => 'cheer-' + o,
    clap: o => 'clap-' + o, sit: o => 'sit-' + o, typing: o => 'typing-' + o,
    shy: o => 'shy-' + o, pout: o => 'pout-' + o, land: o => 'idle-' + o,
    error: o => 'error-' + o, sweep: o => 'sweep-' + o, groove: o => 'groove-' + o
  }
  // 被动模式：不打招呼、不闲聊、不提示。气泡只用于用户主动操作后的结果反馈。
  const LINES = {}
  let settings, manifest, motion, state = 'idle', stateUntil = Infinity
  let lastInteraction = performance.now()
  let bubbleUntil = 0, bubblePriority = -1, lastBubble = -Infinity
  let currentImage = '', frame = 0, timer = null, imageTicket = 0
  let pressed = null, pressPending = false, endingPress = false, beforePress = 'idle'
  let pendingAction = null, tossed = false, idleAutoSit = false
  let clickTimer = null, lastClick = -Infinity, lastHit = '', lastHitTime = 0
  let audio = null, lastSound = -Infinity, paused = false
  let lastBody = '', preferredBubbleBottom = 300
  const geometry = window.petGeometry
  const images = new Map()
  const tnow = () => performance.now()
  function touch() { lastInteraction = tnow(); idleAutoSit = false }
  function say(text, duration = 2300, priority = 1) {
    // 无气泡设计：静默丢弃所有台词（含主进程 notice），反馈一律走动画与对话窗口。
    if (!bubbleEl) return
    const t = tnow()
    if ((t < bubbleUntil && priority < bubblePriority) || (t - lastBubble < 350 && priority <= bubblePriority)) return
    lastBubble = t; bubbleUntil = t + duration; bubblePriority = priority
    bubbleEl.textContent = text
    bubbleEl.classList.add('show')
    layoutSpeech()
  }
  function sound(kind) {
    if (!settings?.soundEnabled || settings.quietMode || tnow() - lastSound < 110) return
    lastSound = tnow()
    try {
      // 提前建好 AudioContext 并保持 running，消除首次/恢复播放的延迟
      audio ||= new AudioContext({ latencyHint: 'interactive' })
      if (audio.state === 'suspended') audio.resume().catch(() => {})
      const notes = { pat: [660, 880], click: [520], pick: [620], toss: [820, 420], bounce: [320], land: [220], wake: [390, 490] }[kind] || [520]
      notes.forEach((freq, i) => {
        const oscillator = audio.createOscillator(), gain = audio.createGain(), start = audio.currentTime + i * 0.05
        oscillator.type = 'square'; oscillator.frequency.setValueAtTime(freq, start)
        gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(0.03, start + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14)
        oscillator.connect(gain); gain.connect(audio.destination)
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
        oscillator.start(start); oscillator.stop(start + 0.16)
      })
    } catch {}
  }
  function imageName(st) { return (IMAGES[st] || IMAGES.idle)(settings.outfit) }
  function layout(name = currentImage) {
    const meta = manifest[name], canon = manifest['idle-' + settings.outfit]
    if (!meta || !canon) return
    const wanted = BASE_H * settings.scale * meta.rawH / canon.rawH
    const ratio = meta.w / meta.h
    const h = Math.min(wanted, innerHeight - 40, (innerWidth - 24) / ratio)
    pet.style.height = Math.max(30, h) + 'px'
    pet.style.width = Math.max(20, h * ratio) + 'px'
    pet.style.imageRendering = 'pixelated'
    wrap.style.bottom = FOOT_INSET + 'px'
    preferredBubbleBottom = Math.min(innerHeight - 68, h * 1.05 + FOOT_INSET + 14)
    reportBody(); layoutSpeech()
    requestAnimationFrame(reportHit)
  }
  function reportBody() {
    const width = parseFloat(pet.style.width), height = parseFloat(pet.style.height)
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    const rect = geometry.footprint(width, height, innerWidth, innerHeight, state, settings.reducedMotion)
    const key = JSON.stringify(rect)
    if (key !== lastBody) { lastBody = key; api.bodyRect(rect) }
  }
  function layoutSpeech() {
    if (!bubbleEl || !motion?.workArea) return
    let place = geometry.speechPosition(motion, innerWidth, innerHeight, 0, 0, 0)
    bubbleEl.style.maxWidth = place.maxWidth + 'px'
    const width = bubbleEl.offsetWidth, height = bubbleEl.offsetHeight
    place = geometry.speechPosition(motion, innerWidth, innerHeight, width, height, innerHeight - preferredBubbleBottom - height)
    bubbleEl.style.left = place.centerX + 'px'
    bubbleEl.style.bottom = Math.max(6, innerHeight - place.top - height) + 'px'
  }
  function renderImage(st) {
    const name = imageName(st), ticket = ++imageTicket
    if (name === currentImage) { layout(name); return }
    const img = images.get(name)
    const apply = () => {
      if (ticket !== imageTicket) return
      currentImage = name; pet.src = '../assets/pet/' + name + '.gif'; layout(name)
    }
    if (!img || img.complete && img.naturalWidth) apply()
    else img.decode().then(apply).catch(() => { if (ticket === imageTicket) { currentImage = imageName('idle'); pet.src = '../assets/pet/' + currentImage + '.gif'; layout() } })
  }
  function facing() {
    const flip = state === 'fly' && motion?.dir === 1 ? -1 : 1
    wrap.style.transform = `translateX(-50%) scaleX(${flip})`
  }
  function setState(next, duration) {
    if (!settings || !manifest) return
    if (state === next && duration === undefined) return
    state = next
    pet.className = 'st-' + next
    document.body.dataset.state = next
    if (next !== 'fly' && next !== 'drag') renderImage(next)
    else imageTicket++
    const durations = { idle: 6500 + Math.random() * 7000, idle2: 5200,
      wave: 2400, shy: 2300, pout: 2000, cheer: 2000, clap: 2600, typing: 1000, land: 460,
      error: 2600, sweep: 4200, groove: 4200 }
    stateUntil = duration === undefined ? (durations[next] ? tnow() + durations[next] : Infinity) : tnow() + duration
    facing(); reportBody(); reportHit()
  }
  function canReact() { return settings && (motion?.mode === 'ground' || motion?.mode === 'hover') && !pressed && !pressPending && !motion.dragging && !motion.menuOpen && !paused }
  function applyAction(action) {
    touch()
    if (!canReact()) { pendingAction = action; return }
    if (action === 'reset') { setState('idle', 7000); return }
    if (!IMAGES[action]) return
    setState(action, action === 'sit' || action === 'sleep' ? Infinity : undefined)
  }
  // 单击 = 随机动作
  const PLAYFUL = ['wave', 'cheer', 'clap', 'shy', 'pout', 'sweep', 'groove']
  function handleClick() {
    if (!canReact()) return
    touch()
    if (beforePress === 'sleep' || beforePress === 'sit' || state === 'sleep' || state === 'sit') {
      setState('idle'); sound('wake'); return
    }
    applyAction(PLAYFUL[Math.floor(Math.random() * PLAYFUL.length)])
    sound('click')
  }
  function scheduleClick() {
    const t = tnow()
    if (t - lastClick < 290) {
      clearTimeout(clickTimer); clickTimer = null; lastClick = -Infinity
      if (canReact()) {
        // 打开对话是纯功能操作，不播动作，避免与单击随机动作叠加出割裂动画
        touch()
        sound('click')
        api.quickAction('__chat').catch(() => {})
      }
    } else {
      lastClick = t
      clickTimer = setTimeout(() => { clickTimer = null; handleClick() }, 290)
    }
  }
  function reportHit() {
    if (!settings) return
    const r = pet.getBoundingClientRect()
    const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }
    const key = JSON.stringify(rect)
    if (key !== lastHit && rect.width > 0) { lastHit = key; api.hitRect(rect) }
  }
  function stopLoop() { cancelAnimationFrame(frame); clearTimeout(timer); frame = 0; timer = null }
  function scheduleLoop() {
    if (paused) return
    if (['drag', 'fly'].includes(state)) frame = requestAnimationFrame(loop)
    else timer = setTimeout(loop, state === 'sleep' ? 200 : 80)
  }
  function loop() {
    if (paused) return
    const t = tnow()
    if (bubbleEl && t > bubbleUntil) { bubbleEl.classList.remove('show'); bubblePriority = -1 }
    if (t - lastHitTime >= 60) { reportHit(); lastHitTime = t }
    if (canReact()) {
      if (pendingAction) { const action = pendingAction; pendingAction = null; applyAction(action) }
      else if (t - lastInteraction > 600000 && state !== 'sleep') setState('sleep')
      else if (t - lastInteraction > 180000 && ['idle', 'idle2'].includes(state)) {
        setState('sit')
      } else if (t >= stateUntil) {
        if (state === 'idle') {
          const r = Math.random()
          if (r < 0.55) setState('idle2')
          else if (r < 0.8) setState('sweep')
          else setState('groove')
        } else setState('idle')
      }
    }
    facing(); scheduleLoop()
  }
  function acceptMotion(value) {
    if (!settings) { motion = value; return }
    const previous = motion
    motion = value
    const pauseNow = !value.visible || value.suspended
    if (pauseNow !== paused) {
      paused = pauseNow; document.body.classList.toggle('paused', paused)
      stopLoop(); if (!paused) { touch(); scheduleLoop() }
    }
    if (value.moved && value.dragging && state !== 'drag') {
      clearTimeout(clickTimer); lastClick = -Infinity
      setState('drag'); sound('pick')
    } else if (!value.dragging && value.mode === 'air' && state !== 'fly') setState('fly')
    else if (!value.dragging && (value.mode === 'ground' || value.mode === 'hover') && (state === 'fly' || state === 'drag')) setState(value.mode === 'hover' ? 'idle' : 'land')
    if (previous?.revision !== value.revision) layout()
    layoutSpeech(); facing()
  }
  async function endPress(event, cancelled) {
    if ((!pressed && !pressPending) || endingPress) return
    endingPress = true
    const old = pressed
    try {
      const result = await api.pressEnd(cancelled)
      pressed = null; pressPending = false
      if (old) { try { pet.releasePointerCapture(old.id) } catch {} }
      if (result.moved) {
        touch(); tossed = result.tossed
        if (result.tossed) { sound('toss') }
      } else if (!cancelled) scheduleClick()
    } catch (e) { console.error('Release failed', e); pressed = null; pressPending = false }
    finally { endingPress = false }
  }
  pet.addEventListener('pointerdown', async e => {
    if (e.button !== 0 || !settings || pressPending || pressed || endingPress || motion?.menuOpen) return
    e.preventDefault(); touch(); beforePress = state
    try { audio ||= new AudioContext({ latencyHint: 'interactive' }); if (audio.state === 'suspended') audio.resume().catch(() => {}) } catch {}
    pressed = { id: e.pointerId }; pressPending = true
    try { pet.setPointerCapture(e.pointerId) } catch {}
    try {
      const accepted = await api.pressStart()
      if (!accepted) { pressed = null; try { pet.releasePointerCapture(e.pointerId) } catch {} }
    } catch (error) { console.error('Press failed', error); pressed = null }
    finally { pressPending = false }
  })
  pet.addEventListener('pointerup', e => { if (e.button === 0) endPress(e, false) })
  pet.addEventListener('pointercancel', () => endPress(null, true))
  pet.addEventListener('lostpointercapture', () => { if (!endingPress && pressed) endPress(null, true) })
  window.addEventListener('blur', () => { if (pressed) endPress(null, true) })
  pet.addEventListener('contextmenu', e => { e.preventDefault(); clearTimeout(clickTimer); api.openMenu() })
  window.addEventListener('resize', () => { if (manifest) layout() })
  api.on('motion-state', acceptMotion)
  api.on('motion-event', event => {
    if (!settings) return
    if (event.type === 'land') { if (!motion?.dragging) setState('land'); if (tossed) sound('land'); tossed = false }
    if (event.type === 'bounce') sound('bounce')
    if (event.type === 'release' && event.cancelled) { pressed = null; pressPending = false; touch() }
  })
  api.on('do-action', action => { if (!settings) pendingAction = action; else applyAction(action) })
  api.on('menu-closed', () => touch())
  api.on('notice', text => say(text, 4000, 4))
  api.on('apply-settings', next => {
    if (!settings) { settings = next; return }
    const visualChanged = next.outfit !== settings.outfit || next.scale !== settings.scale
    settings = next
    document.body.classList.toggle('reduced-motion', settings.reducedMotion)
    if ((settings.quietMode || !settings.listenKeys) && state === 'typing') setState('idle')
    if (visualChanged && state !== 'drag' && state !== 'fly') renderImage(state)
    reportBody()
    if (!settings.soundEnabled && audio) audio.suspend().catch(() => {})
  })
  api.on('hook-key', () => {
    if (!canReact() || !settings.listenKeys || settings.quietMode) return
    if (!['idle', 'idle2', 'typing'].includes(state)) return
    touch()
    if (state === 'typing') stateUntil = tnow() + 1000
    else setState('typing')
  })
  async function init() {
    const data = await api.getInit()
    settings = data.settings; manifest = data.manifest
    for (const name of Object.keys(manifest)) {
      const img = new Image(); img.src = '../assets/pet/' + name + '.gif'; images.set(name, img)
    }
    document.body.classList.toggle('reduced-motion', settings.reducedMotion)
    state = ''; setState('idle')
    acceptMotion(data.motion)
    pet.alt = 'Clawd 桌面助手，单击随机动作，双击 AI 对话，右键菜单'
    await Promise.allSettled([...images.values()].map(img => img.decode()))
    document.body.dataset.ready = 'true'
    reportHit(); stopLoop(); scheduleLoop()
    if (!paused) sound('wake')
  }
  init().catch(e => console.error('Desktop pet initialization failed', e))
})()
