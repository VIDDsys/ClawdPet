'use strict'
// 多模型档案：models.json 由用户自配，与 EXE 放同一目录（便携模式，换机拷走即可）。
// 程序不内置任何模型与密钥；开发/测试模式下落在 userData 以便隔离。
// 便携封装版内层 exe 可能跑在临时解压目录，因此候选目录按顺序逐个探测真实存在的
// models.json；每次读写都直接落盘，不做内存缓存（用户要求：每一步实际看盘）。
const fs = require('fs')
const path = require('path')

function candidates(app) {
  const dirs = []
  if (app.isPackaged) {
    if (process.env.PORTABLE_EXECUTABLE_DIR) dirs.push(process.env.PORTABLE_EXECUTABLE_DIR)
    try { dirs.push(path.dirname(app.getPath('exe'))) } catch {}
    dirs.push(path.dirname(process.execPath))
  }
  dirs.push(app.getPath('userData'))
  return [...new Set(dirs)].map(d => path.join(d, 'models.json'))
}

// 读：返回第一个真实存在且可解析的文件；全都不存在返回 null（不猜路径）
function resolveForRead(app) {
  for (const file of candidates(app)) {
    try {
      const state = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (state.models.length) return { file, state }
    } catch {}
  }
  return null
}

// 写：优先写已有文件的位置；否则写首选目录（便携目录 → exe 目录 → userData）
function resolveForWrite(app) {
  const found = resolveForRead(app)
  if (found) return found.file
  return candidates(app)[0]
}

function sanitize(input) {
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const seen = new Set()
  const models = (Array.isArray(obj.models) ? obj.models : []).filter(m => m && typeof m === 'object').map((m, i) => {
    let id = String(m.id || '').trim() || ('m' + Date.now().toString(36) + i)
    while (seen.has(id)) id += '-' + i
    seen.add(id)
    return {
      id,
      name: String(m.name || '未命名').trim().slice(0, 40),
      baseUrl: String(m.baseUrl || '').trim().slice(0, 200),
      model: String(m.model || '').trim().slice(0, 100),
      apiKey: String(m.apiKey || '').trim().slice(0, 200)
    }
  })
  let active = obj.active
  if (!models.some(m => m.id === active)) active = models[0]?.id || null
  return { active, models }
}

function load(file) {
  try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { return null }
}

function save(file, state) {
  const data = sanitize(state)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  return data
}

module.exports = { candidates, resolveForRead, resolveForWrite, sanitize, load, save }
