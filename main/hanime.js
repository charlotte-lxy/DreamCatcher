'use strict'
const { session } = require('electron')
const path = require('path')
const auth = require('./auth')

const PARTITION = 'persist:hanime'
const UA = auth.UA
const QUALITY_TAG_RE = /^(?:\d{3,4}p|4k|8k|uhd|fhd|hd)$/i

let cachedSession = null

function getSession() {
  if (!cachedSession) {
    cachedSession = session.fromPartition(PARTITION)
    cachedSession.setUserAgent(UA)
  }
  return cachedSession
}

async function prepareSession(proxy) {
  const s = getSession()
  try {
    await s.setProxy(proxy ? { proxyRules: proxy } : { mode: 'direct' })
  } catch (_) { /* 代理设置失败时按当前会话设置继续 */ }
  return s
}

function headers(referer) {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    Referer: referer || 'https://hanime1.me/'
  }
}

async function fetchText(url, opts = {}) {
  const s = await prepareSession(opts.proxy)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await s.fetch(url, { headers: headers(opts.referer), signal: ctrl.signal, credentials: 'include' })
    if (!res.ok) throw new Error(`hanime 页面 HTTP ${res.status}`)
    return await res.text()
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('访问 hanime1.me 超时')
    throw err
  } finally {
    clearTimeout(timer)
  }
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

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
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

function parseUploader(html, title) {
  const re = /<a[^>]+href="https?:\/\/hanime1\.me\/user\/\d+"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html))) {
    const text = stripTags(m[1])
    if (text) return text
  }
  const prefix = /^\[([^\]]+)\]/.exec(title || '')
  return prefix ? prefix[1].trim() : ''
}

function parseTags(html) {
  const list = metaContent(html, 'keywords').split(',').map((t) => t.trim()).filter(Boolean)
  const tags = list.filter((t) => !QUALITY_TAG_RE.test(t))
  // 页面还会把分类（如 2.5D/3DCG）作为标签展示，取标签块之前最后一个 genre 链接
  const tagBlock = html.indexOf('tags%5B%5D')
  if (tagBlock > 0) {
    const head = html.slice(0, tagBlock)
    const re = /href="[^"]*\/search\?genre=([^"&]+)[^"]*"/g
    let last = ''
    let m
    while ((m = re.exec(head))) last = decodeURIComponent(m[1])
    if (last && !tags.some((t) => t.toLowerCase() === last.toLowerCase())) tags.push(last)
  }
  const seen = new Set()
  return tags.filter((t) => {
    const k = t.toLowerCase()
    if (!t || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function parseFormats(html) {
  const found = []
  const add = (raw) => {
    const url = decodeEntities(raw)
    const m = /-(\d{3,4})p\.(?:mp4|m3u8)(?:[?#]|$)/i.exec(url)
    if (!m) return
    const height = Number(m[1])
    if (!height) return
    found.push({
      format_id: `${height}p`,
      height,
      ext: 'mp4',
      vcodec: 'avc1',
      acodec: 'mp4a',
      tbr: 0,
      filesize: 0,
      note: '',
      url
    })
  }
  const sourceRe = /<source[^>]+src="([^"]+)"/gi
  let m
  while ((m = sourceRe.exec(html))) add(m[1])
  if (!found.length) {
    const urlRe = /https?:\/\/vdownload\.hembed\.com\/[^"'\s<>]+?-\d{3,4}p\.mp4[^"'\s<>]*/gi
    while ((m = urlRe.exec(html))) add(m[0])
  }
  found.sort((a, b) => b.height - a.height)
  return found.filter((v, i) => i === 0 || v.height !== found[i - 1].height)
}

function parsePage(html, id) {
  const rawTitle = metaContent(html, 'og:title') || metaContent(html, 'title')
  const title = rawTitle.replace(/\s*-\s*Hanime1\.me\s*$/i, '').trim()
  const uploader = parseUploader(html, title)
  const dateMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(html)
  const duration = Number(metaContent(html, 'og:video:duration')) || 0
  return {
    id: String(id),
    site: 'hanime',
    url: `https://hanime1.me/watch?v=${id}`,
    title: title || `Hanime ${id}`,
    uploader: uploader || 'Hanime',
    uploadDate: dateMatch ? dateMatch[1] : '',
    duration,
    thumbnail: metaContent(html, 'og:image'),
    tags: parseTags(html),
    formats: parseFormats(html),
    audio: false
  }
}

function parseId(input) {
  let u
  try {
    u = new URL(String(input || '').trim())
  } catch (_) {
    return ''
  }
  if (!/^https?:$/.test(u.protocol)) return ''
  if (!/(^|\.)hanime1\.me$/i.test(u.hostname)) return ''
  const v = u.searchParams.get('v')
  if (v && /^\d+$/.test(v)) return v
  const m = /^\/watch\/(\d+)/.exec(u.pathname)
  return m ? m[1] : ''
}

function isUrl(input) {
  return !!parseId(input)
}

async function probe(input, opts = {}) {
  const id = parseId(input)
  if (!id) throw new Error('目前只支持 hanime1.me 的观看页链接（https://hanime1.me/watch?v=...）')
  const html = await fetchText(`https://hanime1.me/watch?v=${id}`, { proxy: opts.proxy, referer: 'https://hanime1.me/' })
  const info = parsePage(html, id)
  if (!info.formats.length) throw new Error('没有在 hanime1.me 页面找到可下载的视频源')
  return info
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
}

function outputPath(outDir, info) {
  const uploader = sanitizeName(info.uploader) || 'Hanime'
  const date = info.uploadDate || new Date().toISOString().slice(0, 10)
  let title = String(info.title || '').trim()
  const prefix = new RegExp('^\\[' + uploader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\s*')
  title = title.replace(prefix, '')
  title = sanitizeName(title).slice(0, 120) || `Hanime ${info.id}`
  const base = `${uploader}_${date}_${title} [${info.id}]`
  return path.join(outDir, uploader, base + '.mp4')
}

function pickFormat(formats, maxHeight) {
  if (!formats || !formats.length) return null
  if (!maxHeight) return formats[0]
  return formats.find((f) => f.height <= maxHeight) || formats[0]
}

async function fetchTags(input, opts = {}) {
  const info = await probe(input, opts)
  return info.tags
}

module.exports = {
  PARTITION,
  isUrl,
  parseId,
  probe,
  fetchTags,
  parsePage,
  parseFormats,
  sanitizeName,
  outputPath,
  pickFormat
}
