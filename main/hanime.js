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
    .replace(/&nbsp;/g, ' ')
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

function outputPath(outDir, info, authorOverride) {
  const pageUploader = sanitizeName(info.uploader)
  const uploader = sanitizeName(authorOverride) || pageUploader || 'Hanime'
  const date = info.uploadDate || new Date().toISOString().slice(0, 10)
  let title = String(info.title || '').trim()
  const prefixUploader = pageUploader || uploader
  const prefix = new RegExp('^\\[' + prefixUploader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\s*')
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

// ---------- 订阅：播放清单 / 上传者 ----------

function parseLength(value) {
  const parts = String(value || '').trim().split(':')
  if (parts.length < 2 || parts.some((p) => !/^\d+$/.test(p))) return 0
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0)
}

function relativeToMs(text, now = Date.now()) {
  const m = /(\d+)\s*(分鐘|分钟|小時|小时|天|週|周|個月|个月|年)前/.exec(String(text || ''))
  if (!m) return now
  const n = Number(m[1]) || 0
  const unit = m[2]
  let ms = 0
  if (/分鐘|分钟/.test(unit)) ms = n * 60e3
  else if (/小時|小时/.test(unit)) ms = n * 3600e3
  else if (unit === '天') ms = n * 86400e3
  else if (/週|周/.test(unit)) ms = n * 7 * 86400e3
  else if (/個月|个月/.test(unit)) ms = n * 30 * 86400e3
  else if (unit === '年') ms = n * 365 * 86400e3
  return now - ms
}

function firstMatch(re, s) {
  const m = re.exec(s)
  return m ? m[1] : ''
}

function parseCardDate(text) {
  const raw = String(text || '')
  let m = /<span class="subtitle-time"[^>]*>([\s\S]*?)<\/span>/i.exec(raw)
  let s = m ? stripTags(m[1]) : ''
  if (!s) {
    m = /<div class="meta-stats">[\s\S]*?<span>([^<]*前)<\/span>/i.exec(raw)
    s = m ? stripTags(m[1]) : ''
  }
  if (!s) {
    m = /(\d+\s*(?:分鐘|分钟|小時|小时|天|週|周|個月|个月|年)前)/.exec(stripTags(raw))
    s = m ? m[1] : ''
  }
  return s.replace(/^[•·\s]+/, '').trim()
}

function parseCardTitle(block) {
  let m = /<h4[^>]*class="video-title"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block)
  if (m) return stripTags(m[1])
  m = /<div[^>]*class="title"[^>]*>([\s\S]*?)<\/div>/i.exec(block)
  if (m) return stripTags(m[1])
  m = /<div[^>]*title="([^"]+)"[^>]*class="video-item-container"/i.exec(block)
  return m ? stripTags(m[1]) : ''
}

function imgSrcByClass(text, cls) {
  const tags = String(text).match(/<img\b[^>]*>/gi) || []
  for (const tag of tags) {
    if (!new RegExp(`class="[^"]*${cls}`, 'i').test(tag)) continue
    const m = /src="([^"]+)"/i.exec(tag)
    if (m) return decodeEntities(m[1])
  }
  return ''
}

function parseCardThumb(block) {
  return imgSrcByClass(block, 'main-thumb')
}

function parseCardUploader(block, fallback) {
  let m = /<div class="meta-author">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block)
  if (!m) m = /<div class="subtitle">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block)
  return m ? stripTags(m[1]) : (fallback || '')
}

// 清单页和上传者页的卡片都包在 user-tab-item-wrapper 里
function parseListCards(html, fallbackUploader) {
  const out = []
  const seen = new Set()
  const blocks = String(html).split(/<div class="user-tab-item-wrapper"/i).slice(1)
  const now = Date.now()
  for (const block of blocks) {
    const m = /<a[^>]+href="https?:\/\/hanime1\.me\/watch\?v=(\d+)[^"]*"/i.exec(block)
    if (!m) continue
    const id = m[1]
    if (seen.has(id)) continue
    const title = parseCardTitle(block)
    if (!title) continue
    seen.add(id)
    const dateText = parseCardDate(block)
    const durationText = firstMatch(/<div[^>]*class="duration"[^>]*>([\s\S]*?)<\/div>/i, block)
    out.push({
      id,
      url: `https://hanime1.me/watch?v=${id}`,
      title,
      thumb: parseCardThumb(block),
      duration: parseLength(stripTags(durationText)),
      created: relativeToMs(dateText, now),
      dateText,
      uploader: parseCardUploader(block, fallbackUploader),
      charging: false
    })
  }
  return out
}

// 搜索页卡片和清单/上传者页不同，没有 user-tab-item-wrapper 包裹
function parseSearchCards(html, fallbackUploader) {
  const out = []
  const seen = new Set()
  const blocks = String(html).split(/<div[^>]*class="video-item-container"/i).slice(1)
  const now = Date.now()
  for (const block of blocks) {
    const m = /<a[^>]+href="https?:\/\/hanime1\.me\/watch\?v=(\d+)[^"]*"/i.exec(block)
    if (!m) continue
    const id = m[1]
    if (seen.has(id)) continue
    const title = parseCardTitle(block)
    if (!title) continue
    seen.add(id)
    const dateText = parseCardDate(block)
    const durationText = firstMatch(/<div[^>]*class="duration"[^>]*>([\s\S]*?)<\/div>/i, block)
    out.push({
      id,
      url: `https://hanime1.me/watch?v=${id}`,
      title,
      thumb: parseCardThumb(block),
      duration: parseLength(stripTags(durationText)),
      created: relativeToMs(dateText, now),
      dateText,
      uploader: parseCardUploader(block, fallbackUploader),
      charging: false
    })
  }
  return out
}

function parseSubscriptionUrl(input) {
  let u
  try {
    u = new URL(String(input || '').trim())
  } catch (_) {
    return null
  }
  if (!/^https?:$/.test(u.protocol) || !/(^|\.)hanime1\.me$/i.test(u.hostname)) return null
  const list = u.searchParams.get('list')
  if (list && /^\d+$/.test(list)) {
    return { type: 'playlist', id: list, url: `https://hanime1.me/playlist?list=${list}&sort=latest` }
  }
  const m = /^\/user\/(\d+)(?:\/|$)/.exec(u.pathname)
  if (m) return { type: 'uploader', id: m[1], url: `https://hanime1.me/user/${m[1]}` }
  if (u.pathname === '/search') {
    const query = String(u.searchParams.get('query') || '').trim()
    if (query) return { type: 'search', id: query, url: `https://hanime1.me/search?query=${encodeURIComponent(query)}` }
  }
  return null
}

function maxPage(html) {
  let max = 1
  const re = /[?&]page=(\d+)/g
  let m
  while ((m = re.exec(html))) max = Math.max(max, Number(m[1]))
  return Math.min(max, 50)
}

function dedupeVideos(list) {
  const seen = new Set()
  return list.filter((v) => {
    if (!v || !v.id || seen.has(v.id)) return false
    seen.add(v.id)
    return true
  })
}

async function listPlaylist(input, opts = {}) {
  const meta = parseSubscriptionUrl(input)
  if (!meta || meta.type !== 'playlist') throw new Error('需要 Hanime 播放清单链接（.../playlist?list=...）')
  const html = await fetchText(`https://hanime1.me/playlist?list=${meta.id}&sort=latest`, { proxy: opts.proxy, referer: 'https://hanime1.me/' })
  const title = stripTags(firstMatch(/<h1[^>]*class="playlist-title"[^>]*>([\s\S]*?)<\/h1>/i, html))
  const cover = imgSrcByClass(html, 'playlist-main-thumbnail')
  const author = stripTags(firstMatch(/<div class="playlist-author-info">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i, html))
  let videos = parseListCards(html, author || title)
  const pages = maxPage(html)
  for (let page = 2; page <= pages; page++) {
    await new Promise((r) => setTimeout(r, 180))
    const more = await fetchText(`https://hanime1.me/playlist?list=${meta.id}&sort=latest&page=${page}`, { proxy: opts.proxy, referer: 'https://hanime1.me/' })
    videos = videos.concat(parseListCards(more, author || title))
    if (opts.onProgress) opts.onProgress({ loaded: videos.length, total: 0, site: 'hanime', page, pages })
  }
  videos = dedupeVideos(videos)
  if (!videos.length) throw new Error('播放清单里没有找到视频')
  if (opts.onProgress) opts.onProgress({ loaded: videos.length, total: videos.length, site: 'hanime' })
  return {
    site: 'hanime',
    type: 'playlist',
    id: meta.id,
    url: meta.url,
    name: title || `Hanime 清单 ${meta.id}`,
    face: decodeEntities(cover),
    author,
    videos
  }
}

async function listUploader(input, opts = {}) {
  const meta = parseSubscriptionUrl(input)
  if (!meta || meta.type !== 'uploader') throw new Error('需要 Hanime 上传者链接（.../user/...）')
  const firstUrl = `https://hanime1.me/user/${meta.id}/uploaded`
  const first = await fetchText(firstUrl, { proxy: opts.proxy, referer: `https://hanime1.me/user/${meta.id}` })
  const name = stripTags(firstMatch(/<h1[^>]*class="profile-display-name"[^>]*>([\s\S]*?)<\/h1>/i, first))
  const avatar = imgSrcByClass(first, 'profile-avatar') || firstMatch(/<div class="profile-avatar-wrapper">[\s\S]*?<img[^>]+src="([^"]+)"/i, first)
  let videos = parseListCards(first, name)
  const pages = maxPage(first)
  if (opts.onProgress) opts.onProgress({ loaded: videos.length, total: 0, site: 'hanime', page: 1, pages })
  for (let page = 2; page <= pages; page++) {
    await new Promise((r) => setTimeout(r, 180))
    const html = await fetchText(`${firstUrl}?page=${page}`, { proxy: opts.proxy, referer: firstUrl })
    videos = videos.concat(parseListCards(html, name))
    if (opts.onProgress) opts.onProgress({ loaded: videos.length, total: 0, site: 'hanime', page, pages })
  }
  videos = dedupeVideos(videos)
  if (!videos.length) throw new Error('上传者页面里没有找到视频')
  return {
    site: 'hanime',
    type: 'uploader',
    id: meta.id,
    url: meta.url,
    name: name || `Hanime 上传者 ${meta.id}`,
    face: decodeEntities(avatar),
    author: name,
    videos
  }
}

async function listSearch(input, opts = {}) {
  const meta = parseSubscriptionUrl(input)
  if (!meta || meta.type !== 'search') throw new Error('需要 Hanime 搜索链接（.../search?query=...）')
  const base = `https://hanime1.me/search?query=${encodeURIComponent(meta.id)}`
  const first = await fetchText(base, { proxy: opts.proxy, referer: 'https://hanime1.me/' })
  let videos = parseSearchCards(first, meta.id)
  const pages = maxPage(first)
  if (opts.onProgress) opts.onProgress({ loaded: videos.length, total: 0, site: 'hanime', page: 1, pages })
  for (let page = 2; page <= pages; page++) {
    await new Promise((r) => setTimeout(r, 180))
    const html = await fetchText(`${base}&page=${page}`, { proxy: opts.proxy, referer: base })
    videos = videos.concat(parseSearchCards(html, meta.id))
    if (opts.onProgress) opts.onProgress({ loaded: videos.length, total: 0, site: 'hanime', page, pages })
  }
  videos = dedupeVideos(videos)
  if (!videos.length) throw new Error('搜索结果里没有找到视频')
  return {
    site: 'hanime',
    type: 'search',
    id: meta.id,
    url: meta.url,
    name: meta.id,
    face: (videos[0] && videos[0].thumb) || '',
    author: meta.id,
    videos
  }
}

async function listSubscription(input, opts = {}) {
  const meta = parseSubscriptionUrl(input)
  if (!meta) throw new Error('需要 Hanime 播放清单、上传者或搜索链接')
  if (meta.type === 'playlist') return listPlaylist(input, opts)
  if (meta.type === 'uploader') return listUploader(input, opts)
  return listSearch(input, opts)
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
  pickFormat,
  parseSubscriptionUrl,
  parseListCards,
  parseSearchCards,
  listPlaylist,
  listUploader,
  listSearch,
  listSubscription
}
