'use strict'
const { session } = require('electron')
const path = require('path')
const auth = require('./auth')
const hanime = require('./hanime')

const PARTITION = 'persist:tags'
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/
const BVID_RE = /^(BV[0-9A-Za-z]{10})$/
const HANIME_ID_RE = /^\d{4,10}$/
const QUALITY_TAG_RE = /^(?:\d{3,4}p|4k|8k|uhd|fhd|hd)$/i

let tagSession = null

function getTagSession() {
  if (!tagSession) {
    tagSession = session.fromPartition(PARTITION)
    tagSession.setUserAgent(auth.UA)
  }
  return tagSession
}

async function prepare(proxy) {
  const s = getTagSession()
  try {
    await s.setProxy(proxy ? { proxyRules: proxy } : { mode: 'direct' })
  } catch (_) { /* 保留当前代理设置 */ }
  return s
}

function normalizeTags(list, opts = {}) {
  const seen = new Set()
  const out = []
  for (const raw of list || []) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim()
    if (!t) continue
    if (opts.filterQuality && QUALITY_TAG_RE.test(t)) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= 40) break
  }
  return out
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
}

function metaContent(html, key) {
  const tags = String(html).match(/<meta\b[^>]*>/gi) || []
  const re = new RegExp(`(?:name|property)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i')
  for (const tag of tags) {
    if (!re.test(tag)) continue
    const m = /content\s*=\s*["']([^"']*)["']/i.exec(tag)
    if (m) return decodeEntities(m[1])
  }
  return ''
}

function parseYouTubeKeywords(html) {
  const json = /"keywords"\s*:\s*(\[[^\]]*\])/.exec(String(html))
  if (json) {
    try {
      const arr = JSON.parse(json[1])
      if (Array.isArray(arr) && arr.length) return normalizeTags(arr)
    } catch (_) { /* 回退到 meta 标签 */ }
  }
  const meta = metaContent(html, 'keywords')
  if (meta) return normalizeTags(meta.split(','))
  return []
}

function siteUrl(site, id) {
  if (site === 'bilibili') return `https://www.bilibili.com/video/${id}`
  if (site === 'youtube') return `https://www.youtube.com/watch?v=${id}`
  if (site === 'hanime') return `https://hanime1.me/watch?v=${id}`
  return ''
}

function detectSite(input) {
  let u
  try {
    u = new URL(String(input || '').trim())
  } catch (_) {
    return null
  }
  if (!/^https?:$/.test(u.protocol)) return null
  const host = u.hostname.toLowerCase()

  if (/(^|\.)bilibili\.com$/.test(host)) {
    const m = /(BV[0-9A-Za-z]{10})/.exec(u.pathname + u.search)
    if (!m) return null
    return { site: 'bilibili', id: m[1], url: siteUrl('bilibili', m[1]) }
  }

  if (/(^|\.)youtu\.be$/.test(host)) {
    const id = u.pathname.split('/').filter(Boolean)[0]
    if (YOUTUBE_ID_RE.test(id || '')) return { site: 'youtube', id, url: siteUrl('youtube', id) }
  }
  if (/(^|\.)youtube\.com$/.test(host)) {
    const v = u.searchParams.get('v')
    if (v && YOUTUBE_ID_RE.test(v)) return { site: 'youtube', id: v, url: siteUrl('youtube', v) }
    const m = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(u.pathname)
    if (m) return { site: 'youtube', id: m[1], url: siteUrl('youtube', m[1]) }
  }

  if (/(^|\.)hanime1\.me$/.test(host)) {
    const id = hanime.parseId(u.href)
    if (id) return { site: 'hanime', id, url: siteUrl('hanime', id) }
  }

  return null
}

// 从下载文件名推断来源；BVID 优先，避免把 11 位 YouTube ID 当成别的站
function detectFilename(input) {
  const base = path.basename(String(input || ''))
  let m = /\[(BV[0-9A-Za-z]{10})\]/.exec(base)
  if (m) return { site: 'bilibili', id: m[1], url: siteUrl('bilibili', m[1]) }
  m = /\[([A-Za-z0-9_-]{11})\]/.exec(base)
  if (m && YOUTUBE_ID_RE.test(m[1])) return { site: 'youtube', id: m[1], url: siteUrl('youtube', m[1]) }
  m = /\[(\d{4,10})\]/.exec(base)
  if (m && HANIME_ID_RE.test(m[1])) return { site: 'hanime', id: m[1], url: siteUrl('hanime', m[1]) }
  return null
}

function tagKey(site, id) {
  return `${site}:${id}`
}

async function fetchBilibiliTags(id) {
  const res = await auth.getSession().fetch(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': auth.UA, Referer: 'https://www.bilibili.com/' },
    credentials: 'include'
  })
  if (!res.ok) throw new Error(`B 站标签 HTTP ${res.status}`)
  const j = await res.json()
  if (!j || j.code !== 0) throw new Error(`B 站标签接口返回 ${(j && j.code) || '未知'}`)
  return normalizeTags((j.data || []).map((t) => t.tag_name))
}

async function fetchYouTubeTags(id, proxy) {
  const s = await prepare(proxy)
  const res = await s.fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, {
    headers: {
      'User-Agent': auth.UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    credentials: 'include'
  })
  if (!res.ok) throw new Error(`YouTube 标签 HTTP ${res.status}`)
  const html = await res.text()
  const tags = parseYouTubeKeywords(html)
  if (!tags.length && !/ytInitialPlayerResponse/.test(html)) {
    throw new Error('YouTube 页面被拦截或没有可读取的标签')
  }
  return tags
}

async function fetchTags(site, id, opts = {}) {
  if (site === 'bilibili') return fetchBilibiliTags(id)
  if (site === 'youtube') return fetchYouTubeTags(id, opts.proxy)
  if (site === 'hanime') return normalizeTags(await hanime.fetchTags(siteUrl('hanime', id), { proxy: opts.proxy }), { filterQuality: true })
  throw new Error(`不支持的站点：${site}`)
}

module.exports = {
  PARTITION,
  detectSite,
  detectFilename,
  siteUrl,
  tagKey,
  normalizeTags,
  parseYouTubeKeywords,
  fetchTags
}
