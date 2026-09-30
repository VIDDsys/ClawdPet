'use strict'
// 链接协议白名单专项（SEC-01）：用最小 DOM 桩验证 safe-links 的白名单决策——
// javascript:/data:/vbscript:/file:/协议相对/大小写/空格绕过全部解包，http(s) 保留。
const test = require('node:test')
const assert = require('node:assert/strict')
const { SAFE_HREF, sanitize } = require('../renderer/safe-links')

function fakeDoc() {
  return { createTextNode: text => ({ nodeType: 3, text }) }
}
function fakeEl(doc, tag, attrs, text) {
  return { tag, ownerDocument: doc, textContent: text || '',
    getAttribute: k => (k in attrs ? attrs[k] : null),
    replacedWith: null,
    replaceWith(n) { this.replacedWith = n } }
}
function fragOf(items) {
  const doc = fakeDoc()
  return { doc, items: items.map(i => fakeEl(doc, i.tag, i.attrs || {}, i.text)),
    querySelectorAll(sel) { return this.items.filter(i => i.tag === sel) } }
}

test('SAFE_HREF only admits full http(s) URLs', () => {
  for (const ok of ['https://example.com/a?b=1', 'http://127.0.0.1:8080/x', 'HTTPS://EXAMPLE.COM/A']) assert.ok(SAFE_HREF.test(ok), ok)
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'jav\tascript:alert(1)', 'data:text/html,<script>', 'vbscript:msgbox',
    'file:///C:/x', '//evil.com/x', 'mailto:a@b.c', '/local/path', 'relative.html', '  https://x.com', 'https://x.com "onmouseover="x']) {
    assert.ok(!SAFE_HREF.test(bad), bad)
  }
})

test('sanitize unwraps dangerous anchors into plain text', () => {
  const f = fragOf([
    { tag: 'a', attrs: { href: 'javascript:alert(1)' }, text: '点我' },
    { tag: 'a', attrs: { href: 'data:text/html,hi' }, text: '数据' },
    { tag: 'a', attrs: { href: '//evil.com/x' }, text: '相对协议' },
    { tag: 'a', attrs: { href: 'https://ok.com/page' }, text: '正常链接' }
  ])
  sanitize(f)
  assert.equal(f.items[0].replacedWith.text, '点我', '危险链接解包保留文字')
  assert.equal(f.items[1].replacedWith.text, '数据')
  assert.equal(f.items[2].replacedWith.text, '相对协议')
  assert.equal(f.items[3].replacedWith, null, '白名单链接保持为链接')
})

test('sanitize drops absolute-URL and data: images to alt text', () => {
  const f = fragOf([
    { tag: 'img', attrs: { src: 'https://evil.com/x.gif', alt: '外链图' } },
    { tag: 'img', attrs: { src: 'data:image/png;base64,AAAA', alt: '内嵌图' } },
    { tag: 'img', attrs: { src: './local.gif', alt: '本地图' } }
  ])
  sanitize(f)
  assert.equal(f.items[0].replacedWith.text, '外链图')
  assert.equal(f.items[1].replacedWith.text, '内嵌图')
  assert.equal(f.items[2].replacedWith, null, '相对路径图片保留')
})
