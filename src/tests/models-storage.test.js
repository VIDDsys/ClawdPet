'use strict'
// models.json 存储可靠性专项（CFG-01/03/04）：原子写与恢复链、
// API Key 不截断与超长拒绝、多候选来源诊断。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const models = require('../lib/models')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-models-'))
const profile = (over = {}) => ({ active: null, models: [Object.assign({ name: 'A', baseUrl: 'https://a/v1', model: 'm1', apiKey: 'k1' }, over)] })

test('save is atomic: no tmp residue, parseable result, bak chain like settings', () => {
  const dir = tmp(), file = path.join(dir, 'models.json')
  const first = models.save(file, profile({ apiKey: 'k1' }))
  assert.equal(first.models[0].apiKey, 'k1')
  assert.ok(!fs.existsSync(file + '.tmp'), '临时文件必须被 rename 掉')
  models.save(file, profile({ apiKey: 'k2' }))
  assert.equal(models.load(file).models[0].apiKey, 'k2')
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak')).models[0].apiKey, 'k1', '上一次好版本进备份')
  // 主文件损坏：load 走 .bak 恢复
  fs.writeFileSync(file, '{half json')
  const recovered = models.load(file)
  assert.equal(recovered.models[0].apiKey, 'k1')
  // 损坏的主文件不得覆盖好备份；再次保存后恢复正常
  models.save(file, recovered)
  assert.equal(JSON.parse(fs.readFileSync(file)).models[0].apiKey, 'k1')
  assert.equal(fs.existsSync(file + '.tmp'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('API Key is never silently truncated (CFG-04)', () => {
  const s = models.sanitize(profile({ apiKey: 'k'.repeat(201) }))
  assert.equal(s.models[0].apiKey.length, 201, '201 字符 Key 不得被截到 200')
  const s2 = models.sanitize(profile({ apiKey: 'k'.repeat(4096) }))
  assert.equal(s2.models[0].apiKey.length, 4096)
})

test('saving an over-long API Key is rejected explicitly', () => {
  const dir = tmp(), file = path.join(dir, 'models.json')
  assert.throws(() => models.save(file, profile({ apiKey: 'k'.repeat(4097) })), /超过 4096 字符.*拒绝/)
  assert.ok(!fs.existsSync(file), '被拒绝的保存不得落盘')
  assert.ok(!fs.existsSync(file + '.tmp'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('findAll reports every valid candidate and resolveForRead picks the first (CFG-03)', () => {
  const dirA = tmp(), dirB = tmp()
  fs.writeFileSync(path.join(dirA, 'models.json'), JSON.stringify(profile({ apiKey: 'a' })))
  fs.writeFileSync(path.join(dirB, 'models.json'), JSON.stringify(profile({ apiKey: 'b' })))
  fs.writeFileSync(path.join(dirA, 'models.json.cruft'), 'x') // 无关文件不参与
  const prev = process.env.PORTABLE_EXECUTABLE_DIR
  process.env.PORTABLE_EXECUTABLE_DIR = dirA
  try {
    const app = { isPackaged: true, getPath: () => dirB } // userData = dirB
    const all = models.findAll(app)
    assert.equal(all.length, 2, '两份有效配置都要被扫出')
    assert.equal(all[0].file, path.join(dirA, 'models.json'), '便携目录优先')
    const r = models.resolveForRead(app)
    assert.equal(r.state.models[0].apiKey, 'a')
    assert.equal(models.resolveForWrite(app), path.join(dirA, 'models.json'), '写固定写当前生效的那一份')
  } finally {
    if (prev === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR; else process.env.PORTABLE_EXECUTABLE_DIR = prev
  }
  // 损坏文件不算有效候选
  fs.writeFileSync(path.join(dirA, 'models.json'), '{broken')
  process.env.PORTABLE_EXECUTABLE_DIR = dirA
  try {
    const app = { isPackaged: true, getPath: () => dirB }
    assert.equal(models.findAll(app).length, 1)
    assert.equal(models.resolveForRead(app).file, path.join(dirB, 'models.json'))
  } finally {
    if (prev === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR; else process.env.PORTABLE_EXECUTABLE_DIR = prev
  }
  fs.rmSync(dirA, { recursive: true, force: true })
  fs.rmSync(dirB, { recursive: true, force: true })
})

test('saved file permissions are restricted on POSIX (plaintext key, local-only)', { skip: process.platform === 'win32' ? 'Windows/NTFS 不认 POSIX 权限位' : false }, () => {
  const dir = tmp(), file = path.join(dir, 'models.json')
  models.save(file, profile({ apiKey: 'secret' }))
  const st = fs.statSync(file)
  assert.equal(st.mode & 0o077, 0, '其他用户/组不得可读写')
  fs.rmSync(dir, { recursive: true, force: true })
})
