'use strict'
// 多模型档案：models.json 由用户自配，与 EXE 放同一目录（便携模式，换机拷走即可）。
// 程序不内置任何模型与密钥；开发/测试模式下落在 userData 以便隔离。
// 便携封装版内层 exe 可能跑在临时解压目录，因此候选目录按顺序逐个探测真实存在的
// models.json；每次读写都直接落盘，不做内存缓存（用户要求：每一步实际看盘）。
// API Key 按用户决策保持明文存储（便携优先）：不写日志、不回显、不自动上传，
// 导出/备份目录时须自行注意（README 有说明）。
const fs = require('fs')
const path = require('path')

const MAX_API_KEY = 4096 // 凭据字段不做静默截断：超限直接拒绝保存并告知

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

// 扫出全部真实存在且可解析的候选（不只第一个）：GUI 用它做「读的是哪一份」
// 的来源显示与多配置冲突提示（写仍固定写当前生效的那一份）
function findAll(app) {
  const found = []
  for (const file of candidates(app)) {
    try {
      const state = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (state.models.length) found.push({ file, state })
    } catch {}
  }
  return found
}

// 读：返回第一个真实存在且可解析的文件；全都不存在返回 null（不猜路径）
function resolveForRead(app) {
  return findAll(app)[0] || null
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
      // 凭据字段不做展示级截断：长令牌静默截断 = 保存成功但认证必败的隐性数据损坏
      apiKey: String(m.apiKey || '').trim(),
      // AGT-04：可选的上下文 token 预算（默认在主进程按 100k 处理，大窗口模型可调大）
      ...(Number.isFinite(Number(m.contextTokens)) ? { contextTokens: Math.min(1000000, Math.max(8000, Math.round(Number(m.contextTokens)))) } : {})
    }
  })
  let active = obj.active
  if (!models.some(m => m.id === active)) active = models[0]?.id || null
  return { active, models }
}

function load(file) {
  for (const p of [file, file + '.bak']) {
    try { return sanitize(JSON.parse(fs.readFileSync(p, 'utf8'))) } catch {}
  }
  return null
}

// 原子写：同目录临时文件 → 校验旧文件可解析才轮换 .bak → rename 覆盖。
// 崩溃/断电最多丢一次保存，不会把 models.json 替换成半个 JSON；
// 保存后回读校验，失败即抛错（调用方必须把错误回传 UI）。
function save(file, state) {
  const data = sanitize(state)
  const tooLong = data.models.find(m => m.apiKey.length > MAX_API_KEY)
  if (tooLong) throw new Error(`模型「${tooLong.name}」的 API Key 超过 ${MAX_API_KEY} 字符，已拒绝保存（凭据不做截断，请检查是否粘贴了错误内容）`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  // 损坏的主文件不得覆盖上一个已知良好的备份
  if (fs.existsSync(file)) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (prev && !Array.isArray(prev) && typeof prev === 'object') fs.copyFileSync(file, file + '.bak')
    } catch (e) { console.warn('[models] 主文件损坏，保留旧备份:', e.message) }
  }
  fs.renameSync(tmp, file)
  return sanitize(JSON.parse(fs.readFileSync(file, 'utf8')))
}

module.exports = { candidates, findAll, resolveForRead, resolveForWrite, sanitize, load, save, MAX_API_KEY }
