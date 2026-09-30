'use strict';
// Markdown 输出的链接与图片协议白名单（SEC-01）。
// 浏览器端供 chat.js 使用；Node 端供单元测试（CommonJS 导出）。
(function (root) {
  // 只允许完整 http(s) 绝对链接：javascript:/data:/vbscript:/file:/协议相对 // 等一律不放行
  const SAFE_HREF = /^https?:\/\/[^\s"'<>]+$/i
  // 渲染结果落地后做 DOM 级兜底校验（不信任 parser 配置）：
  // - 非白名单链接解包成纯文本（保留文字，丢掉危险 href）
  // - 图片只留相对路径（与聊天页 CSP img-src 'self' 一致），外链/data: 换成替代文字
  function sanitize(frag) {
    for (const a of Array.from(frag.querySelectorAll('a'))) {
      const href = a.getAttribute('href') || ''
      if (!SAFE_HREF.test(href)) a.replaceWith(ownerDocument(a).createTextNode(a.textContent || href))
    }
    for (const img of Array.from(frag.querySelectorAll('img'))) {
      const src = img.getAttribute('src') || ''
      if (/:\/\//.test(src) || /^data:/i.test(src)) img.replaceWith(ownerDocument(img).createTextNode(img.getAttribute('alt') || ''))
    }
    return frag
  }
  function ownerDocument(el) { return el.ownerDocument || document }
  const api = { SAFE_HREF, sanitize }
  root.SafeLinks = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
