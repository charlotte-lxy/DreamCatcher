'use strict'
const { session } = require('electron')

// 把 Chromium 的 PAC 结果转成 yt-dlp 能用的代理 URL
// 输入形如 "PROXY 127.0.0.1:7890" / "SOCKS5 127.0.0.1:7891; DIRECT" / "DIRECT"
function parsePacResult(line) {
  const first = String(line || '').split(';')[0].trim()
  if (!first || /^DIRECT$/i.test(first)) return null
  const m = /^(PROXY|HTTPS|SOCKS4|SOCKS5)\s+(\S+)$/i.exec(first)
  if (!m) return null
  const scheme = m[1].toUpperCase()
  const host = m[2]
  if (scheme === 'SOCKS4' || scheme === 'SOCKS5') return `${scheme.toLowerCase()}://${host}`
  return `http://${host}`
}

// 让 Chromium 按系统/PAC 规则解析某个 URL 该走哪个代理
async function resolveProxy(url) {
  try {
    const result = await session.defaultSession.resolveProxy(url)
    return parsePacResult(result)
  } catch (_) {
    return null
  }
}

module.exports = { parsePacResult, resolveProxy }
