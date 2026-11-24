'use strict'
const crypto = require('crypto')
const auth = require('./auth')

// WBI 签名用的固定混排表（B 站前端同款）
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]
const PAGE_SIZE = 30
const PAGE_DELAY = 180
const MAX_PAGES = 200

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 只接受 B 站 UP 主空间；YouTube 空间暂不适配
function parseMid(input) {
  let url
  try {
    url = new URL(String(input || '').trim())
  } catch (_) {
    throw new Error('链接格式不对，需要以 http(s):// 开头')
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('链接格式不对，需要以 http(s):// 开头')
  if (!/(^|\.)space\.bilibili\.com$/i.test(url.hostname)) {
    throw new Error('目前只支持 B 站 UP 主空间链接（space.bilibili.com/...）')
  }
  const m = /^\/(\d+)(?:\/|$)/.exec(url.pathname)
  if (!m) throw new Error('链接里没有识别到 UP 主 UID')
  return m[1]
}

// B 站返回的时长是 "15:16" / "1:02:03" 这种格式
function parseLength(value) {
  const parts = String(value || '').trim().split(':')
  if (parts.length < 2 || parts.some((p) => !/^\d+$/.test(p))) return 0
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0)
}

// 用 B 站图片服务的缩放参数，避免 496 张原图把内存和流量吃满
function thumbUrl(pic) {
  let s = String(pic || '').trim()
  if (!s) return ''
  if (s.startsWith('//')) s = 'https:' + s
  s = s.replace(/^http:\/\//i, 'https://')
  const [base, query] = s.split('?')
  const sized = base.includes('@') ? base : base + '@480w_270h_1c.webp'
  return sized + (query ? '?' + query : '')
}

function mixinKey(imgUrl, subUrl) {
  const key = (u) => String(u || '').slice(String(u || '').lastIndexOf('/') + 1).split('.')[0]
  const raw = key(imgUrl) + key(subUrl)
  if (raw.length < 64) throw new Error('B 站签名数据异常，请稍后重试')
  return MIXIN_TABLE.map((i) => raw[i]).join('').slice(0, 32)
}

function headersFor() {
  // Chromium 的 session.fetch 对 Referer 为 space 路径的请求会直接 ERR_BLOCKED_BY_CLIENT，
  // 用 www 首页作 Referer 既能通过客户端，也能正常调用 WBI 空间接口。
  return {
    'User-Agent': auth.UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*'
  }
}

async function fetchJson(session, url, headers) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await session.fetch(url, { headers, credentials: 'include', signal: ctrl.signal })
    if (!res.ok) throw new Error(`B 站接口 HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('请求 B 站超时，请稍后重试')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function signedSearchUrl(mid, page, mixin, specialType) {
  const params = {
    mid: String(mid),
    ps: String(PAGE_SIZE),
    pn: String(page),
    order: 'pubdate',
    platform: 'web',
    web_location: '1550101',
    wts: String(Math.floor(Date.now() / 1000))
  }
  // 空间页「更多筛选 → 充电专属」走的就是这个参数，缺省时只返回非充电视频
  if (specialType) params.special_type = String(specialType)
  const query = Object.keys(params).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const wRid = crypto.createHash('md5').update(query + mixin).digest('hex')
  return `https://api.bilibili.com/x/space/wbi/arc/search?${query}&w_rid=${wRid}`
}

// is_union_video 是合作视频，不是充电；充电要认 is_charging_arc / elec_arc_type
function isChargingVideo(v) {
  return !!(v.is_charging_arc || v.elec_arc_badge || Number(v.elec_arc_type) > 0)
}

// 按投稿时间倒序拉取某一种类型的全部视频；specialType 为空时是「全部类型」
// stopIds 非空时只拉最新的几条：从最新往回翻，碰到已知视频（已下载/已上传）就停
async function fetchVideoPages(session, headers, mid, mixin, specialType, onProgress, stopIds) {
  const videos = []
  const seen = new Set()
  let total = 0
  let slist = []
  let hit = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await fetchJson(session, signedSearchUrl(mid, page, mixin, specialType), headers)
    if (!j || j.code !== 0) {
      const code = (j && j.code) || '未知'
      const msg = (j && j.message) || '未知错误'
      if (code === -352 || code === -799 || code === 412) {
        throw new Error(`B 站风控拦截（${code}），请稍后重试或确认登录态`)
      }
      if (code === -101) throw new Error('需要先登录 B 站')
      throw new Error(`B 站接口返回 ${code}：${msg}`)
    }
    const list = (j.data && j.data.list && j.data.list.vlist) || []
    if (j.data && j.data.list && Array.isArray(j.data.list.slist)) slist = j.data.list.slist
    total = Number(j.data && j.data.page && j.data.page.count) || total
    for (const v of list) {
      const id = String(v.bvid || '')
      if (!id || seen.has(id)) continue
      if (stopIds && stopIds.has(id)) {
        hit = true
        break
      }
      seen.add(id)
      videos.push({
        id,
        url: `https://www.bilibili.com/video/${id}`,
        title: String(v.title || ''),
        thumb: thumbUrl(v.pic),
        duration: parseLength(v.length),
        created: Number(v.created || 0) * 1000,
        author: String(v.author || ''),
        charging: isChargingVideo(v)
      })
    }
    if (onProgress) onProgress({ loaded: videos.length, total: total || videos.length, slist })
    if (hit || !list.length || (total > 0 && videos.length >= total)) break
    if (page < MAX_PAGES) await sleep(PAGE_DELAY)
  }
  return { videos, total, slist, stopped: hit }
}

async function listUpVideos(input, onProgress, opts = {}) {
  const mid = parseMid(input)
  const session = auth.getSession()
  const headers = headersFor()
  const stopIds = opts.stopIds && opts.stopIds.size ? opts.stopIds : null
  const nav = await fetchJson(session, 'https://api.bilibili.com/x/web-interface/nav', headers)
  if (!nav || nav.code !== 0 || !nav.data || !nav.data.wbi_img) {
    throw new Error(`获取 B 站签名失败（${(nav && nav.code) || '未知'}）`)
  }
  const mixin = mixinKey(nav.data.wbi_img.img_url, nav.data.wbi_img.sub_url)

  // 默认接口只返回非充电视频；空间页的充电筛选是额外传 special_type=charging
  let chargeTotal = 0
  const normal = await fetchVideoPages(session, headers, mid, mixin, '', (p) => {
    const charge = (p.slist || []).find((it) => it && it.special_type === 'charging')
    if (charge) chargeTotal = Number(charge.count) || 0
    if (onProgress) onProgress({ mid, loaded: p.loaded, total: p.total + chargeTotal })
  }, stopIds)

  const charging = await fetchVideoPages(session, headers, mid, mixin, 'charging', (p) => {
    if (onProgress) onProgress({ mid, loaded: normal.videos.length + p.loaded, total: normal.videos.length + p.total })
  }, stopIds)

  // 同一视频可能两边都返回，充电列表里的数据覆盖它，确保充电标记正确
  const merged = new Map()
  for (const v of normal.videos) merged.set(v.id, v)
  for (const v of charging.videos) merged.set(v.id, v)
  const videos = [...merged.values()].sort((a, b) => b.created - a.created)

  return {
    mid,
    total: videos.length,
    stopped: !!(normal.stopped || charging.stopped),
    author: (videos[0] && videos[0].author) || '',
    videos
  }
}

// 订阅列表要显示 UP 主昵称和头像；这个接口不需要 WBI 签名
async function fetchUpProfile(mid) {
  const session = auth.getSession()
  const j = await fetchJson(session, `https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}`, headersFor())
  const card = j && j.code === 0 && j.data && j.data.card
  if (!card) return { name: '', face: '' }
  let face = String(card.face || '').trim()
  if (face.startsWith('//')) face = 'https:' + face
  face = face.replace(/^http:\/\//i, 'https://')
  return { name: String(card.name || '').trim(), face }
}

module.exports = { parseMid, parseLength, thumbUrl, listUpVideos, fetchUpProfile, isChargingVideo, signedSearchUrl }
