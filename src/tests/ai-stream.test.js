'use strict'
// SSE 流式协议专项（AI-01/AGT-02）：EOF 冲刷、CRLF/注释/多行 data、
// [DONE] 幂等、错误码、abort、finish_reason=length 的工具调用丢弃。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { completeStream } = require('../lib/ai')

function serve(chunks, { status = 200, contentType = 'text/event-stream', keepOpen = false } = {}) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      server.lastBody = JSON.parse(body)
      // connection:close 防止 keep-alive socket 挂住测试进程的事件循环
      res.writeHead(status, { 'content-type': contentType, connection: 'close' })
      if (status >= 400) { res.end(typeof chunks === 'string' ? chunks : 'error body'); return }
      for (const c of chunks) res.write(c)
      if (keepOpen) server.holdRes = res // 不 end，模拟挂起连接
      else res.end()
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}
const cfgFor = server => ({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test-model', apiKey: 'sk-test' })
const ev = obj => 'data: ' + JSON.stringify(obj) + '\n\n'
const text = (content, extra) => JSON.stringify({ choices: [Object.assign({ delta: { content } }, extra)] })
const finish = reason => JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })

test('normal stream with [DONE] assembles content and deltas in order', async () => {
  const s = await serve([ev({ choices: [{ delta: { content: '你' } }] }), ev({ choices: [{ delta: { content: '好' } }] }), 'data: [DONE]\n\n'])
  const deltas = []
  const r = await completeStream(cfgFor(s), [{ role: 'user', content: 'hi' }], d => deltas.push(d))
  assert.equal(r.content, '你好')
  assert.deepEqual(deltas, ['你', '好'])
  assert.equal(r.finishReason, 'stop')
  assert.equal(r.toolCalls.length, 0)
  s.close()
})

test('EOF without trailing newline still delivers the last event (AI-01)', async () => {
  const s = await serve(['data: ' + text('前') + '\n\n', 'data: ' + text('最后一帧')]) // 末帧无换行
  const r = await completeStream(cfgFor(s), [], () => {})
  assert.equal(r.content, '前最后一帧')
  s.close()
})

test('EOF without blank line still dispatches the pending event', async () => {
  const s = await serve(['data: ' + text('a') + '\n', 'data: ' + finish('stop') + '\n']) // 只有单换行，无空行分帧
  const r = await completeStream(cfgFor(s), [], () => {})
  assert.equal(r.content, 'a')
  assert.equal(r.finishReason, 'stop')
  s.close()
})

test('finish_reason from a no-newline final event is preserved', async () => {
  const s = await serve(['data: ' + text('x') + '\n\n', 'data: ' + finish('length')]) // 末帧带结束原因但无换行
  const r = await completeStream(cfgFor(s), [], () => {})
  assert.equal(r.finishReason, 'length')
  s.close()
})

test('CRLF line endings are handled', async () => {
  const s = await serve(['data: ' + text('a') + '\r\n\r\ndata: ' + text('b') + '\r\n\r\ndata: [DONE]\r\n\r\n'])
  const r = await completeStream(cfgFor(s), [], () => {})
  assert.equal(r.content, 'ab')
  s.close()
})

test('comment lines and non-data fields are ignored', async () => {
  const s = await serve([': keep-alive 注释行\n', 'event: message\n', 'id: 7\n', 'retry: 100\n', '\n', 'data: ' + text('ok') + '\n\n', 'data: [DONE]\n\n'])
  const r = await completeStream(cfgFor(s), [], () => {})
  assert.equal(r.content, 'ok')
  s.close()
})

test('multi-line data frames are joined before parsing', async () => {
  const payload = '{"choices":[{\n"delta":{"content":"拼"}}]}'
  const s = await serve(['data: {"choices":[{\n', 'data: "delta":{"content":"拼"}}]}\n\n', 'data: [DONE]\n\n'])
  const r = await completeStream(cfgFor(s), [], () => {})
  assert.equal(r.content, '拼')
  s.close()
})

test('tool call fragments across chunks assemble (id/name/args/index)', async () => {
  const chunks = [
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"pa' } }] } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"C:/x"}' } }] } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'write_file', arguments: '{}' } }] } }] }) + '\n\n',
    'data: ' + finish('tool_calls') + '\n\n', 'data: [DONE]\n\n'
  ]
  const s = await serve(chunks)
  const r = await completeStream(cfgFor(s), [], () => {})
  assert.equal(r.toolCalls.length, 2)
  assert.equal(r.toolCalls[0].name, 'read_file')
  assert.deepEqual(r.toolCalls[0].arguments, { path: 'C:/x' })
  assert.equal(r.toolCalls[0].truncated, false)
  assert.equal(r.toolCalls[1].id, 'call_2')
  s.close()
})

test('finish_reason=length drops pending tool calls and appends a notice (AGT-02)', async () => {
  const chunks = [
    'data: ' + text('我先读文件') + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'write_file', arguments: '{"path":"C:/a","con' } }] } }] }) + '\n\n',
    'data: ' + finish('length') + '\n\n', 'data: [DONE]\n\n'
  ]
  const s = await serve(chunks)
  const deltas = []
  const r = await completeStream(cfgFor(s), [], d => deltas.push(d))
  assert.equal(r.finishReason, 'length')
  assert.equal(r.toolCalls.length, 0, '截断流的工具调用不得进入执行链')
  assert.ok(r.content.includes('未完成的工具调用已丢弃'))
  assert.ok(deltas.some(d => d.includes('未完成的工具调用已丢弃')), 'UI 流里也要看到丢弃提示')
  s.close()
})

test('finish is idempotent: junk after [DONE] does not corrupt the result', async () => {
  const s = await serve(['data: ' + text('done') + '\n\n', 'data: [DONE]\n\n', 'data: ' + text('迟到') + '\n\n'])
  const r = await completeStream(cfgFor(s), [], () => {})
  assert.equal(r.content, 'done')
  s.close()
})

test('empty body rejects with a clear error', async () => {
  const s = await serve(['data: [DONE]\n\n'])
  await assert.rejects(completeStream(cfgFor(s), [], () => {}), /回复为空/)
  s.close()
})

test('HTTP error status rejects with code and body excerpt', async () => {
  const s = await serve('{"error":"bad key"}', { status: 401, contentType: 'application/json' })
  await assert.rejects(completeStream(cfgFor(s), [], () => {}), /HTTP 401.*bad key/)
  s.close()
})

test('abort mid-stream rejects with aborted error', async () => {
  const s = await serve(['data: ' + text('部分') + '\n\n'], { keepOpen: true })
  const stream = completeStream(cfgFor(s), [], () => {})
  await new Promise(r => setTimeout(r, 100))
  stream.abort()
  await assert.rejects(stream, e => e.aborted === true)
  s.holdRes.destroy()
  await new Promise(r => s.close(r))
})

test('abort after completion is a no-op', async () => {
  const s = await serve(['data: ' + text('完整') + '\n\n', 'data: [DONE]\n\n'])
  const stream = completeStream(cfgFor(s), [], () => {})
  const r = await stream
  stream.abort() // 已 resolve，不得抛未处理拒绝
  assert.equal(r.content, '完整')
  s.close()
})

test('request body carries model/messages/tools and Bearer key', async () => {
  const s = await serve(['data: [DONE]\n\n'])
  await assert.rejects(completeStream(cfgFor(s), [{ role: 'user', content: 'q' }], () => {}), /回复为空/)
  assert.equal(s.lastBody.model, 'test-model')
  assert.equal(s.lastBody.messages[0].content, 'q')
  assert.equal(s.lastBody.stream, true)
  s.close()
})
