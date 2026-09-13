'use strict'
const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, powerMonitor } = require('electron')
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

const WIN_W = 420, WIN_H = 500
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
function savePosition() {
  if (!motion || motion.mode !== 'ground' || motion.drag) return
  const pos = { x: Math.round(motion.x), y: Math.round(motion.y) }
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
const AGENT_TOOLS = [
  { type: 'function', function: { name: 'read_file', description: '读取本地文本文件内容（UTF-8，超过 64KB 截断）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入本地文件（UTF-8，父目录不存在时自动创建）。写含中文的 .ps1/.bat 建议 bom:true lineEnding:crlf（PS5.1 无 BOM 会按 ANSI 误读）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' }, content: { type: 'string', description: '要写入的全部内容' }, bom: { type: 'boolean', description: '是否加 UTF-8 BOM（默认 false）' }, lineEnding: { type: 'string', enum: ['lf', 'crlf'], description: '行尾格式（默认 lf；.bat/.reg/.ini 建议 crlf）' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: '在 Windows 上执行 PowerShell 命令（powershell -NoProfile，输出 UTF-8，已预置 Get-Content/Set-Content/Out-File 编码为 UTF8）。返回 stdout/stderr，末尾附 [exit N]；超时会附已收集的部分输出。命令经 argv 直传，$ 与引号原样保留，支持多行脚本', parameters: { type: 'object', properties: { command: { type: 'string', description: 'PowerShell 命令或脚本块' }, cwd: { type: 'string', description: '工作目录（可选，绝对路径）' }, timeout_ms: { type: 'number', description: '超时毫秒数（可选，默认 60000，上限 600000）' } }, required: ['command'] } } }
]
function toolCallSummary(call) {
  const a = call.arguments || {}
  if (call.name === 'read_file') return String(a.path || '')
  if (call.name === 'write_file') return String(a.path || '') + `（${String(a.content ?? '').length} 字符）`
  if (call.name === 'run_command') return String(a.command || '')
  return ''
}
async function execToolCall(call) {
  const a = call.arguments || {}
  // 截断时带统计（显示 X / 共 Y 字符），模型能判断丢了多少
  const clip = (s, n) => s.length > n ? s.slice(0, n) + `\n…（已截断：显示 ${n} / 共 ${s.length} 字符，如需其余内容请缩小范围重试）` : s
  // 默认工作目录固定为程序所在目录——从快捷方式启动时主进程 cwd 可能是 system32，
  // 不固定的话命令行为会随启动方式漂移
  const defaultCwd = path.dirname(models.resolveForWrite(app))
  // 相对路径自动锚定到程序目录执行（不报错拦截），并注明解析结果让模型知情
  const resolvePathArg = p => {
    const s = String(p)
    if (path.isAbsolute(s)) return { p: s, note: '' }
    const abs = path.join(defaultCwd, s)
    return { p: abs, note: `（相对路径 "${s}" 已按工作目录解析为 ${abs}）\n` }
  }
  try {
    // 流被 token 上限截断时 arguments JSON 不完整（解析成 {_raw}）——不要拿残缺参数执行
    if (a._raw !== undefined) return '错误：工具参数 JSON 不完整（输出被长度上限截断），请重新完整地发起该工具调用'
    if (call.name === 'read_file') {
      const r = resolvePathArg(a.path)
      const buf = await fs.promises.readFile(r.p)
      // 二进制检测（NUL 字节或大量替换符）：直接说明而不是吐乱码误导模型
      const text = buf.toString('utf8')
      if (buf.includes(0) || (text.match(/\uFFFD/g) || []).length > buf.length * 0.02)
        return r.note + `二进制文件（${buf.length} 字节），本工具不支持读取内容`
      return r.note + (clip(text, 64000) || '(空文件)')
    }
    if (call.name === 'write_file') {
      const r = resolvePathArg(a.path)
      await fs.promises.mkdir(path.dirname(r.p), { recursive: true })
      let content = String(a.content ?? '')
      if (a.lineEnding === 'crlf') content = content.replace(/\r?\n/g, '\r\n')
      await fs.promises.writeFile(r.p, (a.bom ? '\ufeff' : '') + content, 'utf8')
      return (r.note || '') + `已写入 ${r.p}（UTF-8${a.bom ? ' + BOM' : ''}，${a.lineEnding === 'crlf' ? 'CRLF' : 'LF'}）`
    }
    if (call.name === 'run_command') {
      const cwd = a.cwd !== undefined ? resolvePathArg(a.cwd).p : defaultCwd
      const timeout = Math.min(600000, Math.max(1000, Number(a.timeout_ms) || 60000))
      return await new Promise(resolve => {
        // PowerShell 而非 cmd：argv 直传不经 shell 二次转义（$ 和引号原样保留）、无 wmic 历史包袱；
        // 输出强制 UTF-8，宿主对残留 GBK（老 exe）按字节智能兜底解码
        let child
        // execFile 的 timeout 只杀 powershell 本体，它拉起的孙进程会变孤儿继续跑——超时补刀整棵树
        const killTree = () => { if (child?.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}) }
        child = execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            // 预置编码：控制台输出 + 常用读写命令全部 UTF8，中文文件读写不再乱码
            '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
            "$PSDefaultParameterValues['Get-Content:Encoding']='UTF8';" +
            "$PSDefaultParameterValues['Set-Content:Encoding']='UTF8';" +
            "$PSDefaultParameterValues['Add-Content:Encoding']='UTF8';" +
            "$PSDefaultParameterValues['Out-File:Encoding']='UTF8';", String(a.command)],
          { cwd, windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'buffer' }, (e, stdout, stderr) => {
            const decode = b => {
              if (!b || !b.length) return ''
              try { return new TextDecoder('utf-8', { fatal: true }).decode(b) } catch {}
              try { return new TextDecoder('gbk').decode(b) } catch { return b.toString('utf8') }
            }
            let out = decode(stdout)
            const err = decode(stderr)
            if (err) out += (out ? '\n' : '') + '[stderr] ' + err
            // 超时时 stdout 已是收集到的部分输出，一并返回；exit code 恒附在末尾
            const code = e ? (e.killed ? 'timeout' : (e.code ?? 1)) : 0
            out += (out ? '\n' : '') + `[exit ${code}]` + (e && e.killed ? '（超时被终止，以上为已收集的部分输出）' : '')
            if (e && e.killed) killTree()
            resolve(clip(out || '(无输出)', 30000))
          })
      })
    }
    return '未知工具: ' + call.name
  } catch (e) { return '错误: ' + e.message }
}
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
  chatWin.webContents.on('did-finish-load', () => { state.loaded = true; tryShow() })
  setTimeout(() => { if (chatWin && !chatWin.isDestroyed() && !chatWin.isVisible()) chatWin.show() }, 2000)
  chatWin.on('closed', () => { chatWin = null })
  return chatWin
}
let streamEpoch = 0, currentStream = null, streamPartial = ''
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
async function runChatStream() {
  if (chatBusy) return
  chatBusy = true
  const epoch = ++streamEpoch
  streamPartial = ''
  try {
    const cfg = activeModel()
    if (!cfg) {
      chatSend('chat-msg', { role: 'assistant', text: '还没有配置模型。点右上角设置按钮，添加一条配置（API 地址、模型名、API Key）并保存即可开始对话。配置文件 models.json 与本程序放在同一目录。', tag: 'system' })
      chatSend('chat-done', { ok: true })
      return
    }
    const messages = [{ role: 'system', content: CHAT_SYSTEM }, ...chatHistory]
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      messages[0] = { role: 'system', content: CHAT_SYSTEM + readUserPrompt() } // 每轮实时并入 AGENTS.md
      shrinkToolOutputs(messages)
      currentStream = ai.completeStream(cfg, messages,
        delta => { streamPartial += delta; chatSend('chat-chunk', delta) }, { tools: AGENT_TOOLS })
      const { content, toolCalls, finishReason } = await currentStream
      currentStream = null
      if (epoch !== streamEpoch) return // 被打断（插话/停止/清空），收尾已由 interruptChatStream 完成
      if (!toolCalls.length || round === MAX_TOOL_ROUNDS) {
        // finish_reason=length：正文被 token 上限硬切——明确告知而不是装作正常结束
        let finalText = content || streamPartial
        if (finishReason === 'length' && !toolCalls.length) {
          finalText += '\n\n（输出达到长度上限被截断，可让我继续）'
          chatSend('chat-chunk', '\n\n（输出达到长度上限被截断，可让我继续）')
        }
        chatHistory.push({ role: 'assistant', content: finalText })
        if (round === MAX_TOOL_ROUNDS && toolCalls.length) chatSend('chat-msg', { role: 'assistant', text: '（已达工具调用轮数上限，本轮到此为止）', tag: 'agent' })
        chatSend('chat-done', { ok: true })
        send('do-action', 'cheer')
        return
      }
      messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) })
      for (const call of toolCalls) {
        const output = await execToolCall(call)
        if (epoch !== streamEpoch) return
        chatSend('chat-tool', { name: call.name, input: toolCallSummary(call), output })
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(output) })
      }
    }
  } catch (e) {
    // 中断的流由 interruptChatStream() 同步收尾；只有当前世代的真错误才上报
    if (epoch === streamEpoch) {
      currentStream = null
      chatSend('chat-done', { ok: false, error: e.message })
      send('do-action', 'error')
    }
  } finally {
    if (epoch === streamEpoch) chatBusy = false
  }
}
// 中断进行中的流：interrupt = 用户插话（保留已生成部分为一条 assistant 记录）；
// discard = 清空对话（丢弃部分输出）。新流随后的 runChatStream 会让旧回调失效。
function interruptChatStream(keepPartial) {
  if (!chatBusy) return
  streamEpoch++
  if (currentStream) currentStream.abort()
  currentStream = null
  chatBusy = false
  if (keepPartial && streamPartial.trim()) {
    chatHistory.push({ role: 'assistant', content: streamPartial })
    chatSend('chat-aborted', { partial: true })
  } else chatSend('chat-aborted', { partial: false })
  streamPartial = ''
}
function chatUserMessage(text) {
  createChatWindow()
  if (chatBusy) interruptChatStream(true) // 插话：立即打断当前回复，接着发新消息
  chatSend('chat-msg', { role: 'user', text })
  chatHistory.push({ role: 'user', content: text })
  if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40)
  runChatStream()
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
  on('chat-clear', () => { interruptChatStream(false); chatHistory = [] })
  on('chat-stop', () => interruptChatStream(true))
  handle('models-get', () => readModelState())
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
    chatSend('models-saved', models.save(file, state))
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
    if (motion) { motion.reset(); savePosition() }
    persist()
    if (hookProc) hookProc.kill()
    globalShortcut.unregisterAll(); if (tray) tray.destroy()
  })
  app.on('window-all-closed', () => app.quit())
}
