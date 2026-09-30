'use strict'
const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, powerMonitor, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const readline = require('readline')
const { performance } = require('perf_hooks')
const { Motion, chooseDisplay } = require('./lib/motion')
const store = require('./lib/settings')
const ai = require('./lib/ai')
const models = require('./lib/models')
const { AGENT_TOOLS, validateToolCall, toolCallSummary, execToolCall } = require('./lib/agent-tools')

const WIN_W = 500, WIN_H = 400
const testMode = process.argv.includes('--pet-test')
const previewMode = process.argv.includes('--pet-preview') || testMode
const isolatedPath = process.argv.find(a => a.startsWith('--pet-data='))?.slice(11)
if (isolatedPath && path.isAbsolute(isolatedPath)) app.setPath('userData', isolatedPath)
else if (previewMode) app.setPath('userData', path.join(app.getPath('appData'), 'desktop-pet-preview'))
else app.setPath('userData', path.join(app.getPath('appData'), 'desktop-pet'))

let win, tray, motion, displayId, hookProc, settings, saveTimer, tickTimer, guardTimer
let chatWin = null, chatHistory = [], chatBusy = false
let suspended = false, closing = false, hookStarting = false, hookWanted = false
let menuOpen = false, uiOpen = false, hitRect = null, ignoreMouse = true, pressTime = 0
let lastNative = null, lastSnapshot = '', lastFrame = performance.now(), lastSavePos = null
let geometrySignature = '', lastEmitAt = 0
const file = () => path.join(app.getPath('userData'), 'settings.json')
const validWindow = () => win && !win.isDestroyed()
function send(channel, data) { if (validWindow() && !win.webContents.isDestroyed()) win.webContents.send(channel, data) }
function persist() { if (!settings) return; try { store.persist(file(), settings) } catch (e) { console.error('[save]', e.message) } }
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; persist() }, 1500) }
// 位置保存与物理模式解耦（PET-01）：地面与悬停都是稳定可见状态，都保存；
// drag 中途保存视为悬停；air（下落过渡态）不保存，等落到稳定状态后由
// 2s 一轮的 guard 兜底保存。
function savePosition() {
  if (!motion || !motion.drag) {
    const mode = motion.mode
    if (mode !== 'ground' && mode !== 'hover') return
    savePosSnapshot(mode)
  } else savePosSnapshot('hover')
}
function savePosSnapshot(mode) {
  const pos = { x: Math.round(motion.x), y: Math.round(motion.y), mode }
  if (JSON.stringify(pos) === lastSavePos) return
  lastSavePos = JSON.stringify(pos)
  settings.lastPos = pos
  saveSoon()
}
function selectedDisplay() {
  return screen.getAllDisplays().find(d => d.id === displayId) ||
    chooseDisplay(screen.getAllDisplays(), motion ? {
      x: motion.x + (motion.body ? motion.body.x + motion.body.width / 2 : motion.size.width / 2),
      y: motion.y + (motion.body ? motion.body.y + motion.body.height / 2 : motion.size.height / 2)
    } : screen.getCursorScreenPoint()) || screen.getPrimaryDisplay()
}
function syncGeometry(force = false) {
  if (!validWindow() || !motion) return
  let d = selectedDisplay()
  if (motion.drag?.moved) d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  displayId = d.id
  let b = win.getBounds()
  const target = { width: Math.min(WIN_W, Math.max(100, d.workArea.width - 4)), height: Math.min(WIN_H, Math.max(100, d.workArea.height - 4)) }
  if (Math.abs(b.width - target.width) > 4 || Math.abs(b.height - target.height) > 4) {
    win.setSize(target.width, target.height)
    b = win.getBounds()
  }
  // Use actual native dimensions: e.g. Windows can round 500 DIP to 501.
  const signature = JSON.stringify([d.id, d.workArea, d.scaleFactor, b.width, b.height])
  if (force || signature !== geometrySignature) {
    geometrySignature = signature
    motion.updateGeometry(d.workArea, { width: b.width, height: b.height })
    lastNative = null
    emitSnapshot(true)
  }
}
function placeWindow() {
  if (!motion || !validWindow()) return
  const p = { x: Math.round(motion.x), y: Math.round(motion.y) }
  if (!lastNative || p.x !== lastNative.x || p.y !== lastNative.y) {
    // Electron/Windows 150% DPI setPosition repeatedly round-trips native size:
    // the window can gain ~1 DIP on every move. Always pin the requested size.
    const area = motion.area
    win.setBounds({ ...p, width: Math.min(WIN_W, Math.max(100, area.width - 4)),
      height: Math.min(WIN_H, Math.max(100, area.height - 4)) }, false)
    lastNative = p
  }
}
function snapshot() {
  return { ...motion.snapshot(), visible: testMode || win.isVisible(), suspended, menuOpen,
    previewMode, displayId }
}
function emitSnapshot(force = false) {
  if (!motion || !validWindow()) return
  const s = snapshot(), key = JSON.stringify(s), t = performance.now()
  if (force || (key !== lastSnapshot && t - lastEmitAt >= 30)) {
    lastSnapshot = key; lastEmitAt = t; send('motion-state', s)
  }
}
function setIgnore(value) {
  if (!validWindow() || ignoreMouse === value) return
  ignoreMouse = value
  win.setIgnoreMouseEvents(value, { forward: true })
}
function cursorOverPet() {
  if (!hitRect || !validWindow()) return false
  const cursor = screen.getCursorScreenPoint(), b = win.getBounds()
  return cursor.x >= b.x + hitRect.x - 5 && cursor.x <= b.x + hitRect.x + hitRect.width + 5 &&
    cursor.y >= b.y + hitRect.y - 5 && cursor.y <= b.y + hitRect.y + hitRect.height + 5
}
function tick() {
  const t = performance.now(), dt = Math.min((t - lastFrame) / 1000, 0.05)
  lastFrame = t
  if (!validWindow() || !motion || suspended || !win.isVisible()) return
  if (motion.drag) {
    syncGeometry()
    motion.dragTo(screen.getCursorScreenPoint(), t)
    if (t - pressTime > 60000) endPress(true)
  }
  if (!menuOpen) {
    const events = motion.step(dt, settings.scale)
    if (events.landed) send('motion-event', { type: 'land' })
    else if (events.bounced) send('motion-event', { type: 'bounce' })
  }
  placeWindow()
  setIgnore(!(motion.drag || menuOpen || cursorOverPet()))
  emitSnapshot()
}
function guard() {
  if (!validWindow()) return
  syncGeometry()
  // If the OS moved the window, reapply the model rather than feeding rounded
  // native coordinates back into the integrator (which causes cumulative drift).
  lastNative = null
  placeWindow()
  win.setAlwaysOnTop(true, 'screen-saver')
  savePosition()
  emitSnapshot()
}
function endPress(cancelled = false) {
  if (!motion?.drag) return { moved: false, cancelled }
  motion.dragTo(screen.getCursorScreenPoint(), performance.now())
  const result = motion.endDrag(performance.now(), cancelled)
  send('motion-event', { type: 'release', ...result })
  syncGeometry(); placeWindow(); emitSnapshot(true)
  return result
}
function resetPosition(targetDisplay) {
  endPress(true)
  if (targetDisplay) displayId = targetDisplay.id
  syncGeometry(true)
  motion.reset()
  if (targetDisplay) motion.x = targetDisplay.workArea.x + (targetDisplay.workArea.width - motion.size.width) / 2
  motion.constrain(); placeWindow(); savePosition(); emitSnapshot(true)
  send('do-action', 'reset')
}
function setVisible(show) {
  if (!validWindow()) return
  endPress(true)
  if (show) { guard(); win.showInactive() } else { motion.setWalk(false); win.hide() }
  emitSnapshot(true); refreshTray(); updateHooker()
}
function createWindow() {
  const d = settings.lastPos ? chooseDisplay(screen.getAllDisplays(), { x: settings.lastPos.x + WIN_W / 2, y: settings.lastPos.y + WIN_H / 2 }) : screen.getPrimaryDisplay()
  displayId = d.id
  win = new BrowserWindow({ width: Math.min(WIN_W, d.workArea.width - 4), height: Math.min(WIN_H, d.workArea.height - 4),
    x: Math.round(d.workArea.x + (d.workArea.width - WIN_W) / 2), y: d.workArea.y,
    frame: false, transparent: true, resizable: false, thickFrame: false, backgroundColor: '#00000000',
    maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.on('console-message', (e, level, message) => { if (level >= 2) console.error('[renderer]', message) })
  win.webContents.on('render-process-gone', () => { endPress(true); motion.reset(); setIgnore(true) })
  const b = win.getBounds()
  motion = new Motion(d.workArea, { width: b.width, height: b.height }, settings.lastPos || {})
  syncGeometry(true); placeWindow()
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => { if (!testMode) win.showInactive(); guard(); refreshTray(); updateHooker() })
  win.on('blur', () => { if (motion?.drag) endPress(true) })
  win.on('closed', () => { win = null; if (!closing) app.quit() })
  tickTimer = setInterval(tick, 1000 / 60)
  guardTimer = setInterval(guard, 2000)
}
function setSetting(key, value) {
  settings = store.sanitize({ ...settings, [key]: value })
  motion.setWalk(false)
  persist(); send('apply-settings', settings); refreshTray(); updateHooker()
}
async function setAutoStart(on) {
  if (previewMode || !app.isPackaged) return
  try {
    const portable = process.env.PORTABLE_EXECUTABLE_FILE
    if (portable) {
      const args = on ? ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'DesktopPet', '/t', 'REG_SZ', '/d', '"' + portable + '"', '/f'] : ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'DesktopPet', '/f']
      await new Promise((resolve, reject) => execFile('reg.exe', args, { windowsHide: true }, e => e ? reject(e) : resolve()))
    } else app.setLoginItemSettings({ openAtLogin: on })
    setSetting('autoStart', on)
  } catch (e) { console.error('[autostart]', e.message); send('notice', '自启动设置未成功，原设置已保留。') }
}
// ---------- AI 聊天窗口（微型 agent：读文件 / 写文件 / 执行命令） ----------
// 身份/性格等用户可改的设定在 EXE 同目录 AGENTS.md（每轮实时并入）；这里只留工具与环境的硬规则
const CHAT_SYSTEM = '用户让你操作文件或跑命令时直接调用工具执行，无需再次征求确认，执行完简要汇报结果。输出表格时必须直接用 Markdown 管道语法（| 分隔），严禁把表格包进代码块或用空格对齐。\n\n执行环境（已确定的事实，直接依赖，不要试探）：\n- Windows 11，命令通过 Windows PowerShell 5.1 执行（powershell -NoProfile -NonInteractive）。严禁 bash/sh 语法；严禁 PS7 专有语法（?? 、?. 、三元运算符）；wmic 已移除，用 Get-CimInstance。\n- 文件工具一律 UTF-8 编码；路径优先绝对路径，相对路径会按程序工作目录自动解析。run_command 已预置 Get-Content/Set-Content/Out-File/Add-Content 编码为 UTF8，中文文件读写不乱码。write_file 支持 bom 和 lineEnding:crlf 参数——写含中文的 .ps1/.bat 用 bom:true，.bat/.reg/.ini 用 lineEnding:crlf。\n- run_command 结果末尾恒附 [exit N]（超时附已收集的部分输出）；输出超 30KB 截断（附显示/总字符统计），read_file 超 64KB 截断、二进制文件会明确提示不可读；命令默认 60 秒超时（timeout_ms 可调，上限 600000）。\n- 不确定某命令是否存在时先 Get-Command 确认，不要连续盲试。已知坑：字符串里的中文变量名要用 ${} 包裹（"第$_行"会被解析成 $行 吞字）；Start-Process 别名（notepad 等 WindowsApps）配 -PassThru 会抛异常，用绝对路径或 [Diagnostics.Process]::Start。\n工具：read_file（读文件）、write_file（写文件，父目录自动创建）、run_command（执行 PowerShell，$ 与引号原样直达，输出按 UTF-8 解码）。'
const MAX_TOOL_ROUNDS = 100
function chatSend(channel, data) { if (chatWin && !chatWin.isDestroyed() && !chatWin.webContents.isDestroyed()) chatWin.webContents.send(channel, data) }
// Alt+C 开关聊天窗：关闭用 hide（不销毁 DOM），再开原样恢复——绝不清空对话。
// 只有窗口还不存在时才创建；标题栏 × 关闭走 closed 销毁，与这里互不影响。
function toggleChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) {
    if (chatWin.isVisible()) chatWin.hide()
    else { chatWin.show(); chatWin.focus() }
  } else createChatWindow()
}
function createChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.show(); chatWin.focus(); return chatWin }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  // 尺寸按目标显示器工作区夹紧，避免初始越界/底部被任务栏裁切
  const width = Math.min(460, d.workArea.width - 40)
  const height = Math.min(620, d.workArea.height - 80)
  const x = Math.min(d.workArea.x + Math.round(d.workArea.width * 0.7), d.workArea.x + d.workArea.width - width - 12)
  const y = d.workArea.y + Math.max(64, Math.min(140, Math.round(d.workArea.height * 0.1)))
  chatWin = new BrowserWindow({ width, height, x, y,
    resizable: true, backgroundColor: '#fbf9f4', title: 'Clawd AI', show: false, icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  // 聊天内容含模型输出的 Markdown：窗口本身绝不允许导航或开新窗（外链走 open-link 白名单进系统浏览器）
  chatWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  chatWin.webContents.on('will-navigate', e => e.preventDefault())
  chatWin.loadFile(path.join(__dirname, 'renderer', 'chat.html'))
  // 等 DOM/CSS/图片就绪且可绘制后再显示（消除首帧 FOUC）；两个事件到达顺序不定，都满足才显示
  const state = { loaded: false, ready: false, shown: false }
  const tryShow = () => {
    if (state.shown || chatWin.isDestroyed()) return
    if (!state.loaded || !state.ready) return
    state.shown = true
    chatWin.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
      .catch(() => {})
      .then(() => { if (!chatWin.isDestroyed()) chatWin.show() })
  }
  chatWin.once('ready-to-show', () => { state.ready = true; tryShow() })
  chatWin.webContents.on('did-finish-load', () => {
    state.loaded = true
    // 窗口被 × 销毁后重建：回放主进程对话历史，页面与记忆保持一致（工具过程不持久化，只回放最终消息）
    for (const m of chatHistory) chatSend('chat-msg', { role: m.role, text: m.content })
    tryShow()
  })
  setTimeout(() => { if (chatWin && !chatWin.isDestroyed() && !chatWin.isVisible()) chatWin.show() }, 2000)
  chatWin.on('closed', () => { chatWin = null })
  return chatWin
}
let streamEpoch = 0, currentStream = null, streamPartial = ''
let convId = 0 // 会话世代：清空对话时 +1，所有聊天事件携带，渲染层据此丢弃旧会话的迟到事件
let activeController = null // 当前请求的工具批次 AbortController：停止/清空/退出时真正终止命令与写入
// 用户自定义指令：AGENTS.md 与 EXE 同目录，每轮实时重读（改完即生效，上限 16KB）
function readUserPrompt() {
  for (const m of models.candidates(app)) {
    try {
      const t = fs.readFileSync(path.join(path.dirname(m), 'AGENTS.md'), 'utf8')
      if (t.trim()) return '\n\n【用户自定义指令（来自 AGENTS.md，在不与工具规则冲突时优先遵守）】\n' + t.trim().slice(0, 16000)
    } catch {}
  }
  return ''
}
// 模型配置每次使用都从磁盘实际读取，不缓存（用户要求：每一步都真读，杜绝旧状态）
function readModelState() {
  return models.resolveForRead(app)?.state || models.sanitize(null)
}
function activeModel() {
  const s = readModelState()
  return s.models.find(m => m.id === s.active) || null
}
// 上下文预算：多轮工具输出（单条最大 64KB）全量堆进 messages 会撑爆 DeepSeek 128K token
// 上下文窗口（约 40 万字节就要开始折叠）；超预算时把最早的工具输出折叠为占位符
// （保留开头，模型仍可按需重读文件），且只折叠中间的工具结果，system+对话前缀不动以保住缓存命中
function shrinkToolOutputs(messages) {
  while (JSON.stringify(messages).length > 400000) {
    const m = messages.find(x => x.role === 'tool' && x.content.length > 400)
    if (!m) break
    m.content = '(此工具输出过长已折叠，如需完整内容请重新调用工具读取)' + m.content.slice(0, 400) + '…'
  }
}
async function runChatStream(epoch) {
  if (chatBusy) return
  chatBusy = true
  streamPartial = ''
  const controller = new AbortController()
  activeController = controller
  try {
    const cfg = activeModel()
    if (!cfg) {
      chatSend('chat-msg', { role: 'assistant', text: '还没有配置模型。点右上角设置按钮，添加一条配置（API 地址、模型名、API Key）并保存即可开始对话。配置文件 models.json 与本程序放在同一目录。', tag: 'system', convId })
      chatSend('chat-done', { ok: true, convId })
      return
    }
    const messages = [{ role: 'system', content: CHAT_SYSTEM }, ...chatHistory]
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      messages[0] = { role: 'system', content: CHAT_SYSTEM + readUserPrompt() } // 每轮实时并入 AGENTS.md
      shrinkToolOutputs(messages)
      currentStream = ai.completeStream(cfg, messages,
        delta => { streamPartial += delta; chatSend('chat-chunk', { delta, convId }) }, { tools: AGENT_TOOLS })
      const { content, toolCalls, finishReason } = await currentStream
      currentStream = null
      if (epoch !== streamEpoch) return // 被打断（插话/停止/清空），收尾已由 interruptChatStream 完成
      if (!toolCalls.length || round === MAX_TOOL_ROUNDS) {
        // finish_reason=length：正文被 token 上限硬切——明确告知而不是装作正常结束
        let finalText = content || streamPartial
        if (finishReason === 'length' && !toolCalls.length) {
          finalText += '\n\n（输出达到长度上限被截断，可让我继续）'
          chatSend('chat-chunk', { delta: '\n\n（输出达到长度上限被截断，可让我继续）', convId })
        }
        chatHistory.push({ role: 'assistant', content: finalText })
        if (round === MAX_TOOL_ROUNDS && toolCalls.length) chatSend('chat-msg', { role: 'assistant', text: '（已达工具调用轮数上限，本轮到此为止）', tag: 'agent', convId })
        chatSend('chat-done', { ok: true, convId })
        send('do-action', 'cheer')
        return
      }
      messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) })
      const seenIds = new Set()
      for (const call of toolCalls) {
        // 执行前统一校验（AGT-02）：截断/未知工具/坏参数/重复 id 不进执行器，结构化错误回给模型重发
        const invalid = validateToolCall(call) || (seenIds.has(call.id) ? `重复的工具调用 id（${call.id}），请为每次调用使用唯一 id` : null)
        seenIds.add(call.id)
        const result = invalid
          ? { status: 'failed', output: '错误：' + invalid }
          : await execToolCall(call, { baseDir: path.dirname(models.resolveForWrite(app)), signal: controller.signal })
        if (epoch !== streamEpoch) return
        chatSend('chat-tool', { name: call.name, input: toolCallSummary(call), output: result.output, status: result.status, convId })
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result.output) })
      }
    }
  } catch (e) {
    // 中断的流由 interruptChatStream() 同步收尾；只有当前世代的真错误才上报
    if (epoch === streamEpoch) {
      currentStream = null
      chatSend('chat-done', { ok: false, error: e.message, convId })
      send('do-action', 'error')
    }
  } finally {
    if (epoch === streamEpoch) { chatBusy = false; activeController = null }
  }
}
// 中断进行中的流：interrupt = 用户插话（保留已生成部分为一条 assistant 记录）；
// discard = 清空对话（丢弃部分输出）。除了作废回调世代，还要真正终止已启动的
// 工具副作用：run_command 杀整棵进程树、write_file 丢弃半截临时文件（AGT-01）。
function interruptChatStream(keepPartial) {
  if (!chatBusy) return
  streamEpoch++
  if (currentStream) currentStream.abort()
  currentStream = null
  if (activeController) activeController.abort()
  chatBusy = false
  if (keepPartial && streamPartial.trim()) {
    chatHistory.push({ role: 'assistant', content: streamPartial })
    chatSend('chat-aborted', { partial: true, convId })
  } else chatSend('chat-aborted', { partial: false, convId })
  streamPartial = ''
}
function chatUserMessage(text) {
  createChatWindow()
  if (chatBusy) interruptChatStream(true) // 插话：立即打断当前回复，接着发新消息
  const epoch = ++streamEpoch // 世代由发送方递增，用户回显与随后的流共用同一世代号
  chatSend('chat-msg', { role: 'user', text, convId })
  chatHistory.push({ role: 'user', content: text })
  if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40)
  runChatStream(epoch)
}
function menuTemplate() {
  const check = (label, key) => ({ label, type: 'checkbox', checked: settings[key], click: mi => setSetting(key, mi.checked) })
  return [
    { label: '动作', submenu: [['wave', '挥挥钳'], ['cheer', '开心一下'], ['clap', '抛接杂耍'], ['sit', '看书'], ['sleep', '睡觉'], ['shy', '蹦跶'], ['pout', '闹脾气'], ['error', '报错惊呆'], ['sweep', '扫地'], ['groove', '戴耳机摇摆']].map(([action, label]) => ({ label, click: () => send('do-action', action) })) },
    { label: '大小', submenu: [[0.75, '小巧'], [1, '标准'], [1.3, '大号']].map(([s2, label]) => ({ label, type: 'radio', checked: settings.scale === s2, click: () => setSetting('scale', s2) })) },
    { type: 'separator' }, check('打字应援', 'listenKeys'), check('交互音效', 'soundEnabled'), check('轻柔动作', 'reducedMotion'), check('专注模式（暂停应援）', 'quietMode'),
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', enabled: app.isPackaged && !previewMode, checked: settings.autoStart, click: mi => setAutoStart(mi.checked) },
    { label: win?.isVisible() ? '隐藏宠物（Ctrl+Alt+C）' : '显示宠物（Ctrl+Alt+C）', click: () => setVisible(!win?.isVisible()) },
    { type: 'separator' }, { label: '退出', click: () => app.quit() }
  ]
}
function refreshTray() { if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate())) }
function openMenu() {
  if (menuOpen || !validWindow()) return
  endPress(true); menuOpen = true; motion.setWalk(false); emitSnapshot(true)
  Menu.buildFromTemplate(menuTemplate()).popup({ window: win, callback: () => { menuOpen = false; emitSnapshot(true); send('menu-closed') } })
}
function updateHooker() {
  hookWanted = !previewMode && !closing && !suspended && validWindow() && win.isVisible() && !settings.quietMode && settings.listenKeys
  if (!hookWanted) { if (hookProc) hookProc.kill(); hookProc = null; return }
  if (hookProc || hookStarting) return
  hookStarting = true
  const source = fs.readFileSync(path.join(__dirname, 'tools', 'hooker.cs'))
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)
  const dir = app.getPath('userData'), cs = path.join(dir, `input-${hash}.cs`), exe = path.join(dir, `input-${hash}.exe`)
  fs.mkdirSync(dir, { recursive: true })
  const start = () => {
    hookStarting = false
    if (!hookWanted || closing) return
    const child = spawn(exe, [String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    hookProc = child
    const rl = readline.createInterface({ input: child.stdout })
    let lastKey = 0
    rl.on('line', line => {
      if (line.length > 64 || !validWindow() || !win.isVisible() || settings.quietMode || motion.drag || menuOpen) return
      try {
        const ev = JSON.parse(line), t = performance.now()
        if (ev.t === 'kd' && settings.listenKeys && t - lastKey >= 45) { lastKey = t; send('hook-key', 1) }
      } catch {}
    })
    child.on('error', e => console.warn('[input]', e.message))
    child.on('exit', () => { rl.close(); if (hookProc === child) hookProc = null })
  }
  if (fs.existsSync(exe)) return start()
  const csc = ['Framework64', 'Framework'].map(f => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(f => fs.existsSync(f))
  if (!csc) { hookStarting = false; console.warn('[input] .NET compiler not available'); return }
  fs.writeFileSync(cs, source)
  execFile(csc, ['/nologo', '/target:winexe', '/out:' + exe, cs], { windowsHide: true, timeout: 20000 }, e => {
    if (e) { hookStarting = false; console.warn('[input]', e.message) } else start()
  })
}
function trusted(event) {
  return validWindow() && (event.sender === win.webContents || (chatWin && !chatWin.isDestroyed() && event.sender === chatWin.webContents)) && event.senderFrame === event.sender.mainFrame
}
function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (e, arg) => { if (!trusted(e)) throw new Error('Untrusted frame'); return fn(arg) })
  const on = (channel, fn) => ipcMain.on(channel, (e, arg) => { if (trusted(e)) fn(arg) })
  handle('get-init', () => ({ settings, manifest: JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'manifest.json'), 'utf8')), motion: snapshot(),
    shortcuts: { pet: globalShortcut.isRegistered('Control+Alt+C'), chat: globalShortcut.isRegistered('Alt+C') } }))
  handle('press-start', () => { if (menuOpen || suspended) return false; pressTime = performance.now(); const ok = motion.beginDrag(screen.getCursorScreenPoint(), pressTime); setIgnore(false); emitSnapshot(true); return ok })
  handle('press-end', cancelled => endPress(cancelled === true))
  on('hit-rect', r => { if (r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.width > 0 && r.height > 0 && r.width <= 1000 && r.height <= 1000) hitRect = r })
  on('body-rect', r => {
    if (!r || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) ||
      r.x < -2 || r.y < -2 || r.width < 20 || r.height < 30 ||
      r.x + r.width > motion.size.width + 8 || r.y + r.height > motion.size.height + 8) return
    if (motion.setBody(r)) { lastNative = null; placeWindow(); emitSnapshot(true) }
  })
  on('open-menu', openMenu)
  on('ui-open', open => { uiOpen = open === true })
  handle('quick-action', name => { if (name === '__chat') { createChatWindow(); return { ok: true } } return { ok: false, error: '未知操作' } })
  let lastChatSend = { text: '', t: 0 }
  on('chat-send', text => {
    if (typeof text !== 'string' || !text.trim()) return
    text = text.trim().slice(0, 30000)
    // 同文本 800ms 内只处理一次：拦截输入法组合期 Enter 泄漏等一切连发
    const now = Date.now()
    if (text === lastChatSend.text && now - lastChatSend.t < 800) return
    lastChatSend = { text, t: now }
    chatUserMessage(text)
  })
  // 清空：先换代并终止进行中的流与工具副作用，再清历史，最后回确认——
  // IPC 顺序保证渲染层先收到 chat-cleared 再收到任何后续消息，旧会话迟到事件全部作废
  on('chat-clear', () => {
    convId++
    interruptChatStream(false)
    chatHistory = []
    chatSend('chat-cleared', { convId })
  })
  on('chat-stop', () => interruptChatStream(true))
  // 配置来源诊断（CFG-03）：返回实际生效文件与全部有效候选，界面据此提示多配置冲突
  handle('models-get', () => {
    const all = models.findAll(app)
    return { state: all[0]?.state || models.sanitize(null), sourceFile: all[0]?.file || null,
      candidates: all.map(x => x.file) }
  })
  // 外链白名单：渲染层只送 http(s)，主进程再验一次才交给系统浏览器（SEC-01）
  handle('open-link', href => {
    if (typeof href !== 'string' || !/^https?:\/\/[^\s"'<>]+$/i.test(href) || href.length > 2048) return { ok: false }
    shell.openExternal(href).catch(e => console.error('[open-link]', e.message))
    return { ok: true }
  })
  // 身份设定编辑：与 readUserPrompt 同源同路径，GUI 与本地 AGENTS.md 永远是同一份
  handle('agents-get', () => {
    for (const m of models.candidates(app)) {
      try { return fs.readFileSync(path.join(path.dirname(m), 'AGENTS.md'), 'utf8') } catch {}
    }
    return ''
  })
  handle('agents-save', text => {
    const dir = path.dirname(models.resolveForWrite(app))
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), String(text ?? '').slice(0, 16000), 'utf8')
    return fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
  })
  on('models-save', state => {
    const file = models.resolveForWrite(app)
    try { chatSend('models-saved', { ok: true, state: models.save(file, state) }) }
    catch (e) { chatSend('models-saved', { ok: false, error: e.message }) } // 保存失败必须可见，UI 保留表单内容
  })
  let lastHeart = -Infinity
  on('add-hearts', n => {
    if (!Number.isFinite(n) || performance.now() - lastHeart < 250) return
    lastHeart = performance.now(); settings.hearts = Math.min(Number.MAX_SAFE_INTEGER, settings.hearts + Math.max(0, Math.min(10, Math.floor(n))))
    saveSoon(); send('apply-settings', settings); refreshTray()
  })
  on('reset-position', () => resetPosition())
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (validWindow()) setVisible(true) })
  app.whenReady().then(async () => {
    settings = store.load(file()).settings
    if (previewMode) settings = { ...settings, listenKeys: false, autoStart: false, soundEnabled: false }
    registerIpc(); createWindow()
    if (!testMode) {
      tray = new Tray(path.join(__dirname, 'assets', 'tray.png'))
      tray.setToolTip('Clawd · 双击宠物开 AI 对话 · Ctrl+Alt+C 显示/隐藏 · Alt+C 聊天窗')
      tray.on('double-click', () => setVisible(!win.isVisible())); refreshTray()
      if (!previewMode) {
        if (!globalShortcut.register('Control+Alt+C', () => setVisible(!win?.isVisible()))) console.warn('[shortcut] Ctrl+Alt+C already in use')
        if (!globalShortcut.register('Alt+C', toggleChatWindow)) console.warn('[shortcut] Alt+C already in use')
      }
    }
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => { syncGeometry(true); placeWindow(); emitSnapshot(true) })
    powerMonitor.on('suspend', () => { suspended = true; endPress(true); updateHooker(); emitSnapshot(true) })
    powerMonitor.on('resume', () => { suspended = false; lastFrame = performance.now(); guard(); updateHooker() })
    if (testMode) require('./tests/electron-smoke').run({ app, win, motion, screen, syncGeometry, guard, placeWindow, settings, resetPosition, setSetting })
  }).catch(e => { console.error(e); app.exit(1) })
  app.on('before-quit', () => {
    closing = true; clearInterval(tickTimer); clearInterval(guardTimer); clearTimeout(saveTimer)
    // 先保存当前位置再重置物理状态：reset 会把 y 拉回地面，先 reset 再存会把悬停位置错存成落地（PET-01）
    if (motion) { savePosition(); motion.reset() }
    // 退出前取消进行中的流与工具：命令进程树立刻补刀，写入清理半截临时文件（AGT-01）
    if (chatBusy) {
      if (currentStream) currentStream.abort()
      if (activeController) activeController.abort()
    }
    persist()
    if (hookProc) hookProc.kill()
    globalShortcut.unregisterAll(); if (tray) tray.destroy()
  })
  app.on('window-all-closed', () => app.quit())
}
