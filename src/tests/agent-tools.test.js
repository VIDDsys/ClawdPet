'use strict'
// Agent 工具层专项（AGT-01/AGT-02）：调用统一校验矩阵、写入原子性与取消、
// 命令取消（进程树终止）、超时、退出码语义。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { validateToolCall, execToolCall, toolCallSummary, TOOL_NAMES } = require('../lib/agent-tools')

const call = (name, args, extra = {}) => ({ id: 'call_t', name, arguments: args, ...extra })
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-tools-'))
const delay = ms => new Promise(r => setTimeout(r, ms))

// ---------- 校验矩阵 ----------
test('validateToolCall rejects structurally invalid calls', () => {
  assert.ok(validateToolCall(null))
  assert.ok(validateToolCall('x'))
  assert.ok(validateToolCall(call('read_file', { path: 'C:/x' }, { truncated: true })), '截断标志必须拒绝')
  assert.ok(validateToolCall(call('read_file', { _raw: '{"path":' })), '_raw 残缺参数必须拒绝')
  assert.ok(validateToolCall(call('hack', {})), '未知工具必须拒绝')
  assert.ok(validateToolCall({ name: 'read_file', arguments: { path: 'C:/x' } }), '缺 id 必须拒绝')
  assert.ok(validateToolCall(call('read_file', ['C:/x'])), '数组参数必须拒绝')
  assert.ok(validateToolCall(call('read_file', 'x')), '非对象参数必须拒绝')
  assert.ok(validateToolCall(call('read_file', {})), '缺 path 必须拒绝')
  assert.ok(validateToolCall(call('read_file', { path: 42 })), 'path 非字符串必须拒绝')
  assert.ok(validateToolCall(call('write_file', { path: 'C:/x', content: { a: 1 } })), 'content 非字符串必须拒绝')
  assert.ok(validateToolCall(call('write_file', { path: 'C:/x', lineEnding: 'cr' })), '非法 lineEnding 必须拒绝')
  assert.ok(validateToolCall(call('write_file', { path: 'C:/x', bom: 'yes' })), 'bom 非布尔必须拒绝')
  assert.ok(validateToolCall(call('run_command', {})), '缺 command 必须拒绝')
  assert.ok(validateToolCall(call('run_command', { command: 'ls', timeout_ms: 'soon' })), 'timeout_ms 非数字必须拒绝')
})

test('validateToolCall accepts well-formed calls for all three tools', () => {
  assert.equal(validateToolCall(call('read_file', { path: 'C:/x.txt' })), null)
  assert.equal(validateToolCall(call('write_file', { path: 'C:/x.txt', content: '' })), null)
  assert.equal(validateToolCall(call('write_file', { path: 'C:/x', content: 'a', bom: true, lineEnding: 'crlf' })), null)
  assert.equal(validateToolCall(call('run_command', { command: 'ls', cwd: 'C:/', timeout_ms: 5000 })), null)
})

test('TOOL_NAMES matches the tool surface', () => {
  assert.deepEqual([...TOOL_NAMES].sort(), ['read_file', 'run_command', 'write_file'])
})

test('toolCallSummary summarizes per tool', () => {
  assert.equal(toolCallSummary(call('read_file', { path: 'C:/a' })), 'C:/a')
  assert.equal(toolCallSummary(call('write_file', { path: 'C:/a', content: '12345' })), 'C:/a（5 字符）')
  assert.equal(toolCallSummary(call('run_command', { command: 'Get-Date' })), 'Get-Date')
})

// ---------- read_file ----------
test('read_file returns UTF-8 content, notes relative-path resolution, detects binary', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'a.txt'), '你好 Clawd', 'utf8')
  const base = { baseDir: dir }
  const r1 = await execToolCall(call('read_file', { path: path.join(dir, 'a.txt') }), base)
  assert.equal(r1.status, 'ok')
  assert.ok(r1.output.includes('你好 Clawd'))
  const r2 = await execToolCall(call('read_file', { path: 'a.txt' }), base)
  assert.ok(r2.output.includes('已按工作目录解析为'), '相对路径要注明解析结果')
  assert.ok(r2.output.includes('你好 Clawd'))
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
  const r3 = await execToolCall(call('read_file', { path: path.join(dir, 'b.bin') }), base)
  assert.ok(r3.output.includes('二进制文件'))
  const r4 = await execToolCall(call('read_file', { path: path.join(dir, '不存在') }), base)
  assert.equal(r4.status, 'failed')
  assert.ok(r4.output.startsWith('错误'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('read_file is cancellable before it starts', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
  const c = new AbortController()
  c.abort()
  const r = await execToolCall(call('read_file', { path: path.join(dir, 'a.txt') }), { baseDir: dir, signal: c.signal })
  assert.equal(r.status, 'cancelled')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- write_file ----------
test('write_file writes content with bom/crlf options and cleans up tmp file', async () => {
  const dir = tmp()
  const r = await execToolCall(call('write_file', { path: path.join(dir, 'sub', '新文件.txt'), content: '第一行\n第二行', bom: true, lineEnding: 'crlf' }), { baseDir: dir })
  assert.equal(r.status, 'ok')
  const buf = fs.readFileSync(path.join(dir, 'sub', '新文件.txt'))
  assert.equal(buf[0], 0xef, 'BOM 已写入')
  assert.ok(buf.toString('utf8').includes('第一行\r\n第二行'), 'CRLF 已转换')
  assert.ok(!fs.existsSync(path.join(dir, 'sub', '新文件.txt.clawd-tmp')), '临时文件已清理')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('write_file cancelled before start leaves no target and no tmp', async () => {
  const dir = tmp()
  const c = new AbortController()
  c.abort()
  const target = path.join(dir, 'x.txt')
  const r = await execToolCall(call('write_file', { path: target, content: 'data' }), { baseDir: dir, signal: c.signal })
  assert.equal(r.status, 'cancelled')
  assert.ok(!fs.existsSync(target), '取消不得产生目标文件')
  assert.ok(!fs.existsSync(target + '.clawd-tmp'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('write_file failure keeps old content intact and removes tmp (atomic guard)', async () => {
  const dir = tmp()
  const target = path.join(dir, 'd') // 目标是一个已存在的目录：rename 必失败
  fs.mkdirSync(target)
  const r = await execToolCall(call('write_file', { path: target, content: '新内容' }), { baseDir: dir })
  assert.equal(r.status, 'failed')
  assert.ok(!fs.existsSync(target + '.clawd-tmp'), '失败后临时文件必须清理')
  assert.ok(fs.statSync(target).isDirectory(), '原目录未被破坏')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- run_command ----------
test('run_command executes PowerShell and reports [exit 0]', async () => {
  const r = await execToolCall(call('run_command', { command: "Write-Output 'hello 爪子'" }), { baseDir: tmp() })
  assert.equal(r.status, 'ok')
  assert.ok(r.output.includes('hello 爪子'))
  assert.ok(r.output.includes('[exit 0]'))
})

test('non-zero exit code is a command result, not a tool failure', async () => {
  const r = await execToolCall(call('run_command', { command: 'exit 3' }), { baseDir: tmp() })
  assert.equal(r.status, 'ok')
  assert.ok(r.output.includes('[exit 3]'))
})

test('run_command timeout kills and reports partial output', async () => {
  const r = await execToolCall(call('run_command', { command: "Write-Output '先输出'; Start-Sleep -Seconds 30", timeout_ms: 2500 }), { baseDir: tmp() })
  assert.equal(r.status, 'timeout')
  assert.ok(r.output.includes('先输出'))
  assert.ok(r.output.includes('[exit timeout]'))
  assert.ok(r.output.includes('超时被终止'))
})

test('run_command cancellation kills the whole process tree promptly', async () => {
  const dir = tmp()
  const pidFile = path.join(dir, 'child.pid')
  const marker = path.join(dir, 'alive.marker')
  const grand = path.join(dir, 'grandchild.ps1')
  // 孙进程持续写心跳文件；取消后必须随进程树一起死。
  // 经临时 .ps1 + -File 启动：避开 Start-Process ArgumentList 的嵌套引号丢失问题
  const script = `Set-Content -Path '${grand.replace(/'/g, "''")}' @'
Set-Content -Path '${marker.replace(/'/g, "''")}' x
1..600 | ForEach-Object { Add-Content -Path '${marker.replace(/'/g, "''")}' .; Start-Sleep -Milliseconds 200 }
'@
$g = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${grand.replace(/'/g, "''")}' -PassThru -WindowStyle Hidden
$g.Id | Set-Content -Path '${pidFile.replace(/'/g, "''")}'
Start-Sleep -Seconds 120`
  const c = new AbortController()
  const started = Date.now()
  const p = execToolCall(call('run_command', { command: script, timeout_ms: 120000 }), { baseDir: dir, signal: c.signal })
  // 等孙进程落盘心跳与 pid 文件
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && !(fs.existsSync(pidFile) && fs.existsSync(marker))) await delay(200)
  assert.ok(fs.existsSync(pidFile), '孙进程已启动')
  const grandchildPid = fs.readFileSync(pidFile, 'utf8').trim()
  const sizeAtCancel = fs.statSync(marker).size
  await delay(800) // 确保还有新输出在产生
  assert.ok(fs.statSync(marker).size > sizeAtCancel, '取消前孙进程确实在持续输出')
  c.abort()
  const r = await p
  assert.equal(r.status, 'cancelled', '输出：' + r.output)
  assert.ok(r.output.includes('已被用户终止'))
  assert.ok(Date.now() - started < 60000, '取消必须尽快返回，而不是等命令自然结束')
  // 孙进程必须真的死了：pid 不再存活
  await delay(1500)
  const alive = await new Promise(resolve => {
    execFile('tasklist', ['/FI', 'PID eq ' + grandchildPid, '/FO', 'CSV'], { windowsHide: true }, (e, out) => {
      resolve(!e && String(out).includes(grandchildPid))
    })
  })
  assert.equal(alive, false, '孙进程必须随取消被终止（进程树补刀生效）')
  // 心跳文件不再增长
  const sizeAfter = fs.statSync(marker).size
  await delay(1200)
  assert.equal(fs.statSync(marker).size, sizeAfter, '被杀后不得继续产生输出')
  fs.rmSync(dir, { recursive: true, force: true })
})
