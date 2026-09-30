'use strict'
// OpenAI 兼容聊天客户端：主进程专用，渲染层不直接联网。
// 连接信息（API 地址 / 模型名 / API Key）全部来自用户自配的 models.json，
// 代码不内置任何模型与密钥。
const https = require('https')
const http = require('http')

// baseUrl 容错解析：支持 https://host、https://host/v1、甚至贴完整 .../chat/completions。
// host 与 port 必须拆开返回——http.request 的 host 选项不认 "host:port" 整串
// （曾致带端口 baseUrl（如本地 Ollama :11434）DNS 解析失败）。
function parseEndpoint(baseUrl) {
  const s = String(baseUrl || '').trim().replace(/\/+$/, '')
  const m = s.match(/^(https?):\/\/([^/]+)(\/.*)?$/i)
  if (!m) return null
  const prefix = (m[3] || '').replace(/\/chat\/completions$/i, '')
  const secure = m[1].toLowerCase() === 'https'
  let host = m[2], port
  if (host.startsWith('[')) {
    const v6 = host.match(/^\[(.+)\](?::(\d+))?$/)
    if (v6) { host = v6[1]; port = v6[2] ? Number(v6[2]) : undefined }
  } else {
    const colon = host.match(/^(.+):(\d+)$/)
    if (colon) { host = colon[1]; port = Number(colon[2]) }
  }
  return { secure, host, port: port || (secure ? 443 : 80), prefix }
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
    req = lib.request({ host: ep.host, port: ep.port, path: ep.prefix + '/chat/completions', method: 'POST', agent: false,
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
        // finish_reason=length 时 arguments JSON 大概率残缺；即使碰巧仍是合法 JSON，
        // 也不把截断流里的工具调用伪装成正常调用送进执行链（主循环另有二道校验）
        const truncated = finishReason === 'length'
        const toolCalls = truncated ? [] : pendingTools.filter(Boolean).map(t => {
          let args = {}
          try { args = JSON.parse(t.args || '{}') } catch { args = { _raw: t.args } }
          return { id: t.id || ('call_' + Math.random().toString(36).slice(2, 10)), name: t.name, arguments: args, truncated: false }
        })
        let content = full
        if (truncated && pendingTools.some(Boolean)) {
          const note = '\n\n（输出达到长度上限被截断，未完成的工具调用已丢弃，请重新完整发起）'
          content += note
          onDelta(note)
        }
        if (!content.trim() && !toolCalls.length) return reject(new Error('回复为空（可能被思考预算耗尽截断），请重试'))
        resolve({ content, toolCalls, finishReason })
      }
      // SSE 事件按空行分帧：多行 data 拼接，注释行（:开头）与其他字段（event/id/retry）忽略
      let eventLines = null
      const handlePayload = payload => {
        if (payload === '[DONE]') return finish()
        try {
          const choice = JSON.parse(payload).choices[0]
          if (!choice) return
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
      const dispatch = () => {
        const lines = eventLines
        eventLines = null
        if (!lines) return
        const payload = lines.join('\n').trim()
        if (!payload) return
        try {
          JSON.parse(payload)
        } catch (e) {
          // 兼容兜底：全程用单换行分隔事件（不规范代理）时按行各自解析，不整包丢弃
          if (lines.length > 1) { for (const l of lines) handlePayload(l.trim()); return }
        }
        handlePayload(payload)
      }
      const processLine = line => {
        if (line === '') return dispatch()
        if (line.startsWith(':')) return
        if (line.startsWith('data:')) {
          eventLines = eventLines || []
          eventLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
      res.on('data', chunk => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          processLine(line)
        }
      })
      // EOF 冲刷：部分兼容服务最后一帧不带换行、也不补空行——end 时必须把
      // 剩余行与未分帧的半截事件处理完再收尾，否则丢最后一条（可能正是
      // 结束状态或最后一段工具参数）
      res.on('end', () => {
        if (buf) processLine(buf.replace(/\r$/, ''))
        dispatch()
        finish()
      })
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

module.exports = { completeStream, parseEndpoint, estimateTokens, shrinkContext }

// AGT-04：上下文预算按 token 保守估算（无 tokenizer 依赖，宁紧勿溢出）：
// CJK 字符按 1 token/字计，其余按 0.35 token/字符计（宽松 tokenizer 下也不会低估）。
function estimateTokens(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let t = 0
  for (let i = 0; i < s.length; i++) t += s.charCodeAt(i) > 0x2e80 ? 1 : 0.35
  return t
}

// 分级折叠直到回到预算内：最早的工具输出 → 更早的 assistant 正文。
// system 与最近对话前缀不动（保 DeepSeek 前缀缓存命中）；最近一条 assistant 不折叠。
// 返回折叠后的估算值——仍超预算时由调用方以可解释错误拒绝发送。
function shrinkContext(messages, budget) {
  const total = () => messages.reduce((n, m) => n + estimateTokens(m.content || '') + (m.tool_calls ? estimateTokens(m.tool_calls) : 0), 0)
  while (total() > budget) {
    // 折叠产物约 450 字符：阈值必须高于它，否则预算无法满足时同一条会被反复选中（死循环）
    const tool = messages.find(x => x.role === 'tool' && x.content.length > 600)
    if (tool) {
      tool.content = '(此工具输出过长已折叠，如需完整内容请重新调用工具读取)' + tool.content.slice(0, 400) + '…'
      continue
    }
    const lastAssistant = messages.map(m => m.role === 'assistant').lastIndexOf(true)
    const old = messages.find((x, i) => x.role === 'assistant' && x.content && x.content.length > 800 && i !== lastAssistant)
    if (old) {
      old.content = '(早期回复已折叠，完整内容上文已展示过)' + old.content.slice(0, 400) + '…'
      continue
    }
    break
  }
  return total()
}
