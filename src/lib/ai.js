'use strict'
// OpenAI 兼容聊天客户端：主进程专用，渲染层不直接联网。
// 连接信息（API 地址 / 模型名 / API Key）全部来自用户自配的 models.json，
// 代码不内置任何模型与密钥。
const https = require('https')
const http = require('http')

// baseUrl 容错解析：支持 https://host、https://host/v1、甚至贴完整 .../chat/completions
function parseEndpoint(baseUrl) {
  const s = String(baseUrl || '').trim().replace(/\/+$/, '')
  const m = s.match(/^(https?):\/\/([^/]+)(\/.*)?$/i)
  if (!m) return null
  const prefix = (m[3] || '').replace(/\/chat\/completions$/i, '')
  return { secure: m[1].toLowerCase() === 'https', host: m[2], prefix }
}

// 流式补全：onDelta(textChunk) 逐段回调，返回 { content, toolCalls, finishReason }。
// 传入 tools 后模型可发起函数调用：toolCalls = [{ id, name, arguments(已解析对象) }]。
// 返回的 Promise 挂有 abort()：调用即断开连接并以 err.aborted=true 的错误 reject。
// maxTokens 须给思维链留余量：思考型模型会先消耗 reasoning token（实测大任务 6k+），
// 预算不足时正文为 0 且 finish_reason=length（表现为"空回复"）。
function completeStream(config, messages, onDelta, { temperature = 0.6, maxTokens = 12288, tools } = {}) {
  let req = null
  const p = new Promise((resolve, reject) => {
    const ep = parseEndpoint(config?.baseUrl)
    const key = String(config?.apiKey || '').trim()
    if (!ep || !String(config?.model || '').trim() || !key)
      return reject(new Error('未配置模型：点聊天窗右上角设置按钮，填写 API 地址 / 模型名 / API Key'))
    const lib = ep.secure ? https : http
    const data = JSON.stringify({ model: config.model, messages, temperature, max_tokens: maxTokens, stream: true,
      ...(tools ? { tools, tool_choice: 'auto' } : {}) })
    req = lib.request({ host: ep.host, path: ep.prefix + '/chat/completions', method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 300000 }, res => {
      if (res.statusCode >= 400) {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', c => { buf += c })
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 300)}`)))
        return
      }
      let buf = '', full = '', done = false, finishReason = 'stop'
      const pendingTools = []
      const finish = () => {
        if (done) return
        done = true
        const toolCalls = pendingTools.filter(Boolean).map(t => {
          let args = {}
          try { args = JSON.parse(t.args || '{}') } catch { args = { _raw: t.args } }
          return { id: t.id || ('call_' + Math.random().toString(36).slice(2, 10)), name: t.name, arguments: args, truncated: finishReason === 'length' }
        })
        if (!full.trim() && !toolCalls.length) return reject(new Error('回复为空（可能被思考预算耗尽截断），请重试'))
        resolve({ content: full, toolCalls, finishReason })
      }
      res.on('data', chunk => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') return finish()
          try {
            const choice = JSON.parse(payload).choices[0]
            if (!choice) continue
            if (choice.finish_reason) finishReason = choice.finish_reason
            const delta = choice.delta
            if (delta?.content) { full += delta.content; onDelta(delta.content) }
            // 工具调用按 index 分片累积：name 首片到达，arguments 逐片拼接（空值不得覆盖已捕获值）
            if (delta?.tool_calls) for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0
              pendingTools[i] = pendingTools[i] || { id: '', name: '', args: '' }
              if (tc.id) pendingTools[i].id = tc.id
              if (tc.function?.name) pendingTools[i].name += tc.function.name
              if (tc.function?.arguments) pendingTools[i].args += tc.function.arguments
            }
          } catch {}
        }
      })
      res.on('end', finish)
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.write(data); req.end()
  })
  const stream = p.catch(e => { throw e }) // 避免未处理拒绝告警
  stream.abort = () => {
    if (!req || req.destroyed) return
    const e = new Error('已中断')
    e.aborted = true
    req.destroy(e)
  }
  return stream
}

module.exports = { completeStream, parseEndpoint }
