'use strict'
// 微型 Agent 工具层：参数统一校验 + 可取消执行。
// 契约保持「全自动、全权限、不打扰」（用户明确选择）：这里不加审批与提醒，
// 只保证两件事——
// 1) 残缺/非法的工具调用绝不产生副作用（截断 JSON、未知工具、坏参数统一拒绝）；
// 2) 停止/清空/退出能真正终止进行中的命令进程树与文件写入。
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const TOOL_NAMES = new Set(['read_file', 'write_file', 'run_command'])

const AGENT_TOOLS = [
  { type: 'function', function: { name: 'read_file', description: '读取本地文本文件内容（UTF-8，超过 64KB 截断）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入本地文件（UTF-8，父目录不存在时自动创建）。写含中文的 .ps1/.bat 建议 bom:true lineEnding:crlf（PS5.1 无 BOM 会按 ANSI 误读）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' }, content: { type: 'string', description: '要写入的全部内容' }, bom: { type: 'boolean', description: '是否加 UTF-8 BOM（默认 false）' }, lineEnding: { type: 'string', enum: ['lf', 'crlf'], description: '行尾格式（默认 lf；.bat/.reg/.ini 建议 crlf）' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: '在 Windows 上执行 PowerShell 命令（powershell -NoProfile，输出 UTF-8，已预置 Get-Content/Set-Content/Out-File 编码 UTF8）。返回 stdout/stderr，末尾附 [exit N]；超时会附已收集的部分输出。命令经 argv 直传，$ 与引号原样保留，支持多行脚本', parameters: { type: 'object', properties: { command: { type: 'string', description: 'PowerShell 命令或脚本块' }, cwd: { type: 'string', description: '工作目录（可选，绝对路径）' }, timeout_ms: { type: 'number', description: '超时毫秒数（可选，默认 60000，上限 600000）' } }, required: ['command'] } } }
]

// 执行前的统一校验（AGT-02）：残缺调用在此被拒绝并回给模型重发，不进入执行器
function validateToolCall(call) {
  if (!call || typeof call !== 'object') return '工具调用格式无效'
  if (call.truncated) return '工具调用因输出长度上限被截断，参数可能不完整，请重新完整发起'
  const a = call.arguments
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '工具参数必须是 JSON 对象'
  if (a._raw !== undefined) return '工具参数 JSON 不完整（输出被长度上限截断），请重新完整发起该工具调用'
  if (!TOOL_NAMES.has(call.name)) return `未知工具 ${String(call.name)}，可用：read_file / write_file / run_command`
  if (typeof call.id !== 'string' || !call.id) return '工具调用缺少 id'
  if (call.name === 'read_file') {
    if (typeof a.path !== 'string' || !a.path.trim()) return 'read_file 需要 string 类型的 path 参数'
  } else if (call.name === 'write_file') {
    if (typeof a.path !== 'string' || !a.path.trim()) return 'write_file 需要 string 类型的 path 参数'
    if (a.content !== undefined && typeof a.content !== 'string') return 'write_file 的 content 必须是字符串'
    if (a.bom !== undefined && typeof a.bom !== 'boolean') return 'write_file 的 bom 必须是布尔值'
    if (a.lineEnding !== undefined && a.lineEnding !== 'lf' && a.lineEnding !== 'crlf') return 'write_file 的 lineEnding 只能是 lf 或 crlf'
  } else if (call.name === 'run_command') {
    if (typeof a.command !== 'string' || !a.command.trim()) return 'run_command 需要 string 类型的 command 参数'
    if (a.cwd !== undefined && typeof a.cwd !== 'string') return 'run_command 的 cwd 必须是字符串'
    if (a.timeout_ms !== undefined && !Number.isFinite(Number(a.timeout_ms))) return 'run_command 的 timeout_ms 必须是数字'
  }
  return null
}

function toolCallSummary(call) {
  const a = call.arguments || {}
  if (call.name === 'read_file') return String(a.path || '')
  if (call.name === 'write_file') return String(a.path || '') + `（${String(a.content ?? '').length} 字符）`
  if (call.name === 'run_command') return String(a.command || '')
  return ''
}

const CANCELLED = () => ({ status: 'cancelled', output: '已取消：用户停止了本次任务' })

// 执行工具调用。signal 触发 abort 时：run_command 立即杀整棵进程树并等 close 后返回；
// write_file 清理临时文件（目标文件保持旧版本，绝不落半文件）；read_file 丢弃结果。
async function execToolCall(call, { baseDir, signal } = {}) {
  const a = call.arguments || {}
  // 截断时带统计（显示 X / 共 Y 字符），模型能判断丢了多少
  const clip = (s, n) => s.length > n ? s.slice(0, n) + `\n…（已截断：显示 ${n} / 共 ${s.length} 字符，如需其余内容请缩小范围重试）` : s
  // 默认工作目录固定为程序所在目录——从快捷方式启动时主进程 cwd 可能是 system32，
  // 不固定的话命令行为会随启动方式漂移
  const defaultCwd = baseDir || process.cwd()
  // 相对路径自动锚定到程序目录执行（不报错拦截），并注明解析结果让模型知情
  const resolvePathArg = p => {
    const s = String(p)
    if (path.isAbsolute(s)) return { p: s, note: '' }
    const abs = path.join(defaultCwd, s)
    return { p: abs, note: `（相对路径 "${s}" 已按工作目录解析为 ${abs}）\n` }
  }
  try {
    // 防御性兜底：执行器内部也不吃残缺参数（协议层 validateToolCall 之外的二道防线）
    if (a._raw !== undefined) return { status: 'failed', output: '错误：工具参数 JSON 不完整（输出被长度上限截断），请重新完整地发起该工具调用' }
    if (call.name === 'read_file') {
      if (signal?.aborted) return CANCELLED()
      const r = resolvePathArg(a.path)
      const buf = await fs.promises.readFile(r.p)
      if (signal?.aborted) return CANCELLED()
      // 二进制检测（NUL 字节或大量替换符）：直接说明而不是吐乱码误导模型
      const text = buf.toString('utf8')
      if (buf.includes(0) || (text.match(/\uFFFD/g) || []).length > buf.length * 0.02)
        return { status: 'ok', output: r.note + `二进制文件（${buf.length} 字节），本工具不支持读取内容` }
      return { status: 'ok', output: r.note + (clip(text, 64000) || '(空文件)') }
    }
    if (call.name === 'write_file') {
      // 先写同目录临时文件再原子改名：取消/崩溃/断电都不会留下半写的目标文件
      const r = resolvePathArg(a.path)
      let content = String(a.content ?? '')
      if (a.lineEnding === 'crlf') content = content.replace(/\r?\n/g, '\r\n')
      const payload = (a.bom ? '\ufeff' : '') + content
      await fs.promises.mkdir(path.dirname(r.p), { recursive: true })
      const tmp = r.p + '.clawd-tmp'
      try {
        await fs.promises.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
        if (signal?.aborted) { await fs.promises.unlink(tmp).catch(() => {}); return CANCELLED() }
        await fs.promises.rename(tmp, r.p)
      } catch (e) {
        await fs.promises.unlink(tmp).catch(() => {})
        throw e
      }
      return { status: 'ok', output: (r.note || '') + `已写入 ${r.p}（UTF-8${a.bom ? ' + BOM' : ''}，${a.lineEnding === 'crlf' ? 'CRLF' : 'LF'}）` }
    }
    if (call.name === 'run_command') {
      if (signal?.aborted) return CANCELLED()
      const cwd = a.cwd !== undefined ? resolvePathArg(a.cwd).p : defaultCwd
      const timeout = Math.min(600000, Math.max(1000, Number(a.timeout_ms) || 60000))
      return await new Promise(resolve => {
        // PowerShell 而非 cmd：argv 直传不经 shell 二次转义（$ 和引号原样保留）、无 wmic 历史包袱；
        // 输出强制 UTF-8，宿主对残留 GBK（老 exe）按字节智能兜底解码
        let child, settled = false, timedOut = false
        // execFile 自带 timeout 只杀 powershell 本体，孙进程会变孤儿——超时与取消都补刀整棵树
        const killTree = () => { if (child?.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}) }
        const onAbort = () => killTree()
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        const timer = setTimeout(() => { timedOut = true; killTree() }, timeout)
        child = execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            // 预置编码：控制台输出 + 常用读写命令全部 UTF8，中文文件读写不再乱码
            '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
            "$PSDefaultParameterValues['Get-Content:Encoding']='UTF8';" +
            "$PSDefaultParameterValues['Set-Content:Encoding']='UTF8';" +
            "$PSDefaultParameterValues['Add-Content:Encoding']='UTF8';" +
            "$PSDefaultParameterValues['Out-File:Encoding']='UTF8';", String(a.command)],
          { cwd, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'buffer' }, (e, stdout, stderr) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (signal) signal.removeEventListener('abort', onAbort)
            const decode = b => {
              if (!b || !b.length) return ''
              try { return new TextDecoder('utf-8', { fatal: true }).decode(b) } catch {}
              try { return new TextDecoder('gbk').decode(b) } catch { return b.toString('utf8') }
            }
            let out = decode(stdout)
            const err = decode(stderr)
            if (err) out += (out ? '\n' : '') + '[stderr] ' + err
            const aborted = signal?.aborted === true
            // 超时时 stdout 已是收集到的部分输出，一并返回；exit code 恒附在末尾。
            // 非零退出码是命令的合法结果（[exit N] 已表达），只有spawn 类失败才算工具失败
            const code = e ? (timedOut ? 'timeout' : (e.code ?? 1)) : 0
            out += (out ? '\n' : '') + `[exit ${code}]` +
              (aborted ? '（已被用户终止，以上为已收集的部分输出）' : (timedOut ? '（超时被终止，以上为已收集的部分输出）' : ''))
            const ran = !e || typeof e.code === 'number'
            resolve({ status: aborted ? 'cancelled' : (timedOut ? 'timeout' : (ran ? 'ok' : 'failed')), output: clip(out || '(无输出)', 30000) })
          })
      })
    }
    return { status: 'failed', output: '未知工具: ' + call.name }
  } catch (e) { return { status: 'failed', output: '错误: ' + e.message } }
}

module.exports = { TOOL_NAMES, AGENT_TOOLS, validateToolCall, toolCallSummary, execToolCall }
