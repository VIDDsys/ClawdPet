'use strict'
// 聊天窗口：只负责展示与输入，全部 AI 逻辑在主进程。
const log = document.getElementById('chat-log')
const input = document.getElementById('chat-input')
const sendBtn = document.getElementById('send-btn')
const stopBtn = document.getElementById('stop-btn')
const status = document.getElementById('status')
const bridge = window.petChatBridge
let streamBody = null

// Markdown 渲染：与你网站 AI 助手同款 marked 引擎；先转义原始 HTML 防注入。
function renderMd(text) {
  if (!window.marked) return document.createTextNode(text)
  const frag = document.createElement('div')
  frag.className = 'md'
  frag.innerHTML = window.marked.parse(String(text).replace(/</g, '&lt;'))
  return frag
}
// 仅当用户本就在底部附近时才自动吸底；手动上翻阅读时不强制滚动
function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 48 }
function autoScroll(mutation) {
  const stick = nearBottom()
  mutation()
  if (stick) log.scrollTop = log.scrollHeight
}
function addMsg(role, text, tag) {
  const el = document.createElement('div')
  el.className = 'msg ' + role
  if (tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = tag; el.appendChild(t) }
  const body = role === 'assistant' ? renderMd(text) : document.createTextNode(text)
  el.appendChild(body)
  autoScroll(() => log.appendChild(el))
  return body
}
function setStatus(text) { status.textContent = text }
// 忙碌 = 生成中：发送键原位变停止键（单按钮互斥；思考阶段无 chunk 也要能停）
function setBusy(b) { sendBtn.hidden = b; stopBtn.hidden = !b }

window.pet.on('chat-msg', data => addMsg(data.role, data.text || '', data.tag))
// agent 工具卡片：读文件 / 写文件 / 执行命令（SVG 图标，不用表情符号）
const TOOL_ICONS = {
  read_file: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  write_file: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  run_command: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
}
window.pet.on('chat-tool', data => {
  // 工具卡片之后开启新气泡：否则多轮循环的所有文字都挤在第一轮的旧气泡里，
  // 视觉顺序变成“总结在命令卡片前面”，像还没执行一样
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
  if (streamBody) streamBody.innerHTML = renderMd(streamText).innerHTML // 冲刷节流残稿再封气泡
  streamBody = null
  streamText = ''
  const el = document.createElement('div')
  el.className = 'tool-card'
  const row = document.createElement('div')
  row.className = 'tool-row'
  const head = document.createElement('div')
  head.className = 'tool-head'
  head.innerHTML = (TOOL_ICONS[data.name] || '') + '<span></span>'
  head.lastChild.textContent = ' ' + data.name + '  ' + (data.input || '')
  row.appendChild(head)
  // 工具失败（错误前缀）：行内直接亮红色「失败」标记，不弹黑色输出块
  const failed = /^(错误|未知工具)/.test(data.output || '')
  if (failed) {
    const fail = document.createElement('span')
    fail.className = 'tool-fail'
    fail.textContent = '失败'
    row.appendChild(fail)
    el.classList.add('failed')
  }
  if (data.output) {
    // 自实现展开（details/summary 在 flex 里 display:list-item 会吃满整行挤掉命令文字）
    const btn = document.createElement('button')
    btn.type = 'button'; btn.className = 'tool-toggle'; btn.title = '展开/收起详情'
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>'
    // 展开区在命令行下方：完整命令（未截断）+ 输出结果
    const detail = document.createElement('div')
    detail.className = 'tool-detail'
    detail.hidden = true
    const fullCmd = document.createElement('div')
    fullCmd.className = 'tool-full'
    fullCmd.textContent = data.name + '  ' + (data.input || '')
    const pre = document.createElement('pre')
    pre.textContent = data.output
    detail.append(fullCmd, pre)
    btn.addEventListener('click', () => {
      detail.hidden = !detail.hidden
      btn.classList.toggle('open', !detail.hidden)
    })
    row.appendChild(btn)
    el.appendChild(row)
    el.appendChild(detail)
  } else {
    el.appendChild(row)
  }
  autoScroll(() => log.appendChild(el))
})
let streamText = ''
// 流式重渲节流：chunk 常常只有几个字符，逐条全文重跑 marked 是 O(n²)，长回复会卡住渲染进程
let renderTimer = null
function scheduleStreamRender() {
  if (renderTimer || !streamBody) return
  renderTimer = setTimeout(() => {
    renderTimer = null
    if (streamBody) autoScroll(() => { streamBody.innerHTML = renderMd(streamText).innerHTML })
  }, 80)
}
window.pet.on('chat-chunk', delta => {
  if (!streamBody) {
    setBusy(true); setStatus('thinking…')
    streamBody = addMsg('assistant', '', 'clawd')
    streamText = ''
  }
  streamText += delta
  scheduleStreamRender()
})
window.pet.on('chat-done', data => {
  setBusy(false)
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
  if (streamBody) streamBody.innerHTML = renderMd(streamText).innerHTML // 节流兜底：完成时保证最终全文渲染
  if (!data.ok && streamBody) streamBody.parentElement.classList.add('err')
  if (!data.ok) {
    const el = addMsg('assistant', '出错：' + (data.error || '未知错误'))
    el.parentElement.classList.add('err')
  }
  streamBody = null
  setStatus(data.ok ? 'ready' : 'error')
  input.focus()
})
// 当前回复被打断（用户插话 / 新建对话）：收尾流式气泡并解锁输入
window.pet.on('chat-aborted', data => {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
  if (streamBody) streamBody.innerHTML = renderMd(streamText).innerHTML // 冲刷节流残余
  if (streamBody && data.partial) {
    const mark = document.createElement('span')
    mark.className = 'tag'
    mark.textContent = '已打断'
    streamBody.parentElement.appendChild(mark)
  }
  streamBody = null
  streamText = ''
  setBusy(false)
  setStatus('ready')
})

let composing = false
input.addEventListener('compositionstart', () => { composing = true })
input.addEventListener('compositionend', () => { composing = false })
let lastSent = { text: '', t: 0 }
function send() {
  const text = input.value.trim()
  if (!text) return
  const now = Date.now()
  if (composing || text === lastSent.text && now - lastSent.t < 800) return
  lastSent = { text, t: now }
  input.value = ''; input.style.height = 'auto'
  setBusy(true)
  // 气泡只由主进程 chat-msg 回推渲染（唯一显示路径，杜绝本地+回推双气泡）
  bridge.send(text)
}
sendBtn.addEventListener('click', send)
stopBtn.addEventListener('click', () => bridge.stop())
input.addEventListener('keydown', e => {
  // 输入法组合期（含结束瞬间）与按住不放的重复 Enter 都不触发发送
  if (composing || e.isComposing || e.keyCode === 229 || e.repeat) return
  // Enter 发送；Shift/Ctrl/Alt/Win + Enter 一律换行
  if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey)) return
  if (e.key === 'Enter') { e.preventDefault(); send() }
})
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(110, input.scrollHeight) + 'px'
})
document.getElementById('clear-btn').addEventListener('click', () => {
  streamBody = null
  streamText = ''
  setBusy(false)
  setStatus('ready')
  log.innerHTML = ''
  bridge.clear()
  const hello = document.createElement('div')
  hello.className = 'hello'
  hello.innerHTML = '<img src="../assets/pet/wave-a.gif" alt=""><p>新对话开始。<br>Enter 发送 · Shift+Enter 换行</p>'
  log.appendChild(hello)
  input.focus()
})
input.focus()

// ---- 模型配置面板（models.json：与 EXE 同目录，多档案增删改+切换启用） ----
const overlay = document.getElementById('config-overlay')
const cfgList = document.getElementById('cfg-list')
const cfgForm = document.getElementById('cfg-form')
const cfgFields = {
  name: document.getElementById('cfg-name'), baseUrl: document.getElementById('cfg-base'),
  model: document.getElementById('cfg-model'), apiKey: document.getElementById('cfg-key')
}
let cfgState = { active: null, models: [] }
let editingId = null // null=未编辑 'new'=新增 其他=编辑对应 id
function renderCfgList() {
  cfgList.textContent = ''
  if (!cfgState.models.length) {
    const empty = document.createElement('p')
    empty.className = 'cfg-empty'
    empty.textContent = '还没有模型配置，点下方按钮添加。'
    cfgList.appendChild(empty)
    return
  }
  for (const m of cfgState.models) {
    const row = document.createElement('div')
    row.className = 'cfg-row' + (m.id === cfgState.active ? ' active' : '')
    const radio = document.createElement('input')
    radio.type = 'radio'; radio.name = 'cfg-active'; radio.checked = m.id === cfgState.active
    radio.title = '启用此模型'
    radio.addEventListener('change', () => { cfgState.active = m.id; window.pet.modelsSave(cfgState) })
    const label = document.createElement('span')
    label.className = 'cfg-label'
    label.textContent = m.name + ' · ' + m.model
    const editBtn = document.createElement('button')
    editBtn.type = 'button'; editBtn.textContent = '编辑'
    editBtn.addEventListener('click', () => openCfgForm(m))
    const delBtn = document.createElement('button')
    delBtn.type = 'button'; delBtn.className = 'danger'; delBtn.textContent = '删除'
    delBtn.addEventListener('click', () => {
      cfgState.models = cfgState.models.filter(x => x.id !== m.id)
      if (cfgState.active === m.id) cfgState.active = cfgState.models[0]?.id || null
      window.pet.modelsSave(cfgState)
    })
    row.append(radio, label, editBtn, delBtn)
    cfgList.appendChild(row)
  }
}
function openCfgForm(m) {
  editingId = m ? m.id : 'new'
  cfgForm.hidden = false
  cfgFields.name.value = m?.name || ''
  cfgFields.baseUrl.value = m?.baseUrl || ''
  cfgFields.model.value = m?.model || ''
  cfgFields.apiKey.value = m?.apiKey || ''
  cfgFields.name.focus()
}
function closeCfgForm() { editingId = null; cfgForm.hidden = true }
document.getElementById('cfg-add').addEventListener('click', () => openCfgForm(null))
document.getElementById('cfg-cancel').addEventListener('click', closeCfgForm)
document.getElementById('cfg-save').addEventListener('click', () => {
  const entry = {
    id: editingId === 'new' ? '' : editingId,
    name: cfgFields.name.value.trim() || '未命名',
    baseUrl: cfgFields.baseUrl.value.trim(),
    model: cfgFields.model.value.trim(),
    apiKey: cfgFields.apiKey.value.trim()
  }
  if (!entry.baseUrl || !entry.model || !entry.apiKey) {
    // 标红空缺项，输入时自动清除标记——不再无声失败
    for (const i of [cfgFields.baseUrl, cfgFields.model, cfgFields.apiKey]) {
      const bad = !i.value.trim()
      i.classList.toggle('cfg-invalid', bad)
      if (bad) i.addEventListener('input', () => i.classList.remove('cfg-invalid'), { once: true })
    }
    return
  }
  for (const i of Object.values(cfgFields)) i.classList.remove('cfg-invalid')
  if (editingId === 'new') {
    cfgState.models.push(entry) // id 为空，由主进程 sanitize 生成；若当前无启用项会自动启用它
  } else {
    const i = cfgState.models.findIndex(x => x.id === editingId)
    if (i >= 0) cfgState.models[i] = { ...cfgState.models[i], ...entry }
  }
  window.pet.modelsSave(cfgState)
  closeCfgForm()
})
window.pet.on('models-saved', state => { cfgState = state; renderCfgList() })
document.getElementById('config-btn').addEventListener('click', async () => {
  cfgState = await window.pet.modelsGet()
  overlay.hidden = false
  closeCfgForm()
  renderCfgList()
  // AGENTS.md 每次打开面板都实时读盘，与本地文件保持同一份
  document.getElementById('agents-text').value = await window.pet.agentsGet()
  document.getElementById('agents-status').textContent = ''
})
document.getElementById('agents-save').addEventListener('click', async () => {
  const saved = await window.pet.agentsSave(document.getElementById('agents-text').value)
  document.getElementById('agents-text').value = saved
  document.getElementById('agents-status').textContent = '已保存 ' + new Date().toLocaleTimeString()
})
document.getElementById('cfg-close').addEventListener('click', () => { overlay.hidden = true })
overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true })
