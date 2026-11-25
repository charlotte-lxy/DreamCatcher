'use strict'
const { app, BrowserWindow, ipcMain, shell, net, dialog, clipboard } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const auth = require('./auth')
const bili = require('./bilibili')
const dl = require('./downloader')
const updater = require('./updater')
const proxy = require('./proxy')
const store = require('./store')
const subs = require('./subscription')
const hanime = require('./hanime')
const tagApi = require('./tags')
const ugreen = require('./ugreen')
const medialib = require('./medialib')
const upload = require('./upload')

const ROOT = path.join(__dirname, '..')
const IS_PACKAGED = app.isPackaged
const EXE_DIR = path.dirname(process.execPath)
// electron-builder 每次打包都会清空 win-unpacked，所以登录态和下载文件不能放在里面，
// 统一放到 win-unpacked 的上一级目录，重新打包不会丢
const STABLE_ROOT = IS_PACKAGED && path.basename(EXE_DIR).toLowerCase() === 'win-unpacked'
  ? path.dirname(EXE_DIR)
  : EXE_DIR
const DATA_HOME = (() => {
  const preferred = IS_PACKAGED ? path.join(STABLE_ROOT, 'data') : path.join(ROOT, '.tmp', 'data')
  try {
    fs.mkdirSync(preferred, { recursive: true })
    const probe = path.join(preferred, '.wtest')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return preferred
  } catch (_) {
    return app.getPath('userData')
  }
})()
if (path.resolve(DATA_HOME) !== path.resolve(app.getPath('userData'))) app.setPath('userData', DATA_HOME)
const DATA_ROOT = DATA_HOME
// 受限环境（安全软件/受限令牌）下用户目录可能不可写，按可写性依次降级
const LOG_DIR = (() => {
  const candidates = [path.join(DATA_ROOT, 'logs'), path.join(EXE_DIR, 'logs')]
  for (const dir of candidates) if (dl.ensureWritable(dir)) return dir
  return candidates[0]
})()
const LOG_FILE = path.join(LOG_DIR, 'app.log')
// 下载目录可能被系统重定向到不可写的盘符，失败就退回程序目录，绝不能在启动时崩
const DOWNLOAD_DIR = (() => {
  const candidates = IS_PACKAGED
    ? [path.join(STABLE_ROOT, 'downloads'), path.join(app.getPath('downloads'), 'Dreamcatcher'), path.join(DATA_ROOT, 'downloads')]
    : [path.join(ROOT, 'downloads')]
  for (const dir of candidates) {
    // 只建目录不够，还要真的能写（重定向的下载目录常常存在但无写入权限）
    if (dl.ensureWritable(dir)) return dir
  }
  return app.getPath('temp')
})()
const COOKIE_DIR = path.join(dl.tmpDir(), 'cookies')
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch (_) { /* 日志目录不可写时退化为仅控制台输出 */ }
try { fs.mkdirSync(COOKIE_DIR, { recursive: true }) } catch (_) { /* 由 exportCookies 再报具体错误 */ }

let win = null
let settings = store.read('settings.json', store.DEFAULTS)
let history = store.readAny('tasks.json', []).map((t) => (t.status === 'running' ? Object.assign({}, t, { status: 'interrupted' }) : t))
let subscriptions = store.readAny('subscriptions.json', []).map(normalizeSubscription).filter(Boolean)
let tagStore = store.read('tags.json', {})
const HISTORY_LIMIT = 50
const tasks = new Map()
const queue = []
let active = 0
saveHistory()
saveSubscriptions()

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch (_) { /* 日志失败不影响主流程 */ }
  if (win && !win.isDestroyed()) win.webContents.send('app:log', line)
}

function fmtSec(s) {
  s = Math.round(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(r).padStart(2, '0')}`
}

function saveHistory() {
  store.write('tasks.json', history.slice(0, HISTORY_LIMIT))
}

function saveSubscriptions() {
  store.write('subscriptions.json', subscriptions)
}

function subKey(site, type, id) {
  return `${site}:${type}:${id}`
}

// 兼容旧版只保存了 mid 的 B 站订阅；Hanime 订阅按播放清单/上传者区分
function normalizeSubscription(raw) {
  if (!raw || typeof raw !== 'object') return null
  const site = raw.site === 'hanime' ? 'hanime' : 'bilibili'
  const type = ['playlist', 'uploader', 'search'].includes(raw.type)
    ? raw.type
    : (site === 'bilibili' ? 'up' : 'uploader')
  const id = String(site === 'bilibili'
    ? (raw.mid || raw.id || '')
    : (raw.listId || raw.userId || raw.query || raw.id || '')).trim()
  if (!id) return null
  const ignored = (Array.isArray(raw.ignored) ? raw.ignored : [])
    .filter((v) => v && v.id)
    .map((v) => ({
      id: String(v.id),
      title: String(v.title || v.id),
      created: Number(v.created) || 0,
      dateText: String(v.dateText || ''),
      thumb: String(v.thumb || ''),
      url: String(v.url || ''),
      site,
      ignoredAt: Number(v.ignoredAt) || Date.now()
    }))
  const filter = raw.filter === 'normal' || raw.filter === 'charging' ? raw.filter : 'all'
  const url = raw.url || (site === 'bilibili'
    ? `https://space.bilibili.com/${id}`
    : type === 'playlist' ? `https://hanime1.me/playlist?list=${id}&sort=latest`
      : type === 'search' ? `https://hanime1.me/search?query=${encodeURIComponent(id)}`
        : `https://hanime1.me/user/${id}`)
  return Object.assign({}, raw, {
    site,
    type,
    id,
    key: raw.key || subKey(site, type, id),
    url,
    filter: site === 'bilibili' ? filter : 'all',
    ignored,
    listId: site === 'hanime' && type === 'playlist' ? id : String(raw.listId || ''),
    userId: site === 'hanime' && type === 'uploader' ? id : String(raw.userId || ''),
    query: site === 'hanime' && type === 'search' ? id : String(raw.query || ''),
    name: String(raw.name || (site === 'bilibili' ? `UP ${id}` : `Hanime ${id}`)),
    face: String(raw.face || ''),
    lastCheckAt: Number(raw.lastCheckAt) || 0,
    lastCount: Number(raw.lastCount) || 0,
    lastMissing: Number(raw.lastMissing) || 0
  })
}

function findSubscription(key) {
  if (!key) return null
  const k = String(key)
  return subscriptions.find((s) => s.key === k) ||
    subscriptions.find((s) => s.site === 'bilibili' && String(s.mid) === k) ||
    subscriptions.find((s) => s.site === 'hanime' && String(s.id) === k) ||
    null
}

function upsertSubscription(rec) {
  const i = subscriptions.findIndex((s) => s.key === rec.key)
  if (i >= 0) subscriptions[i] = Object.assign({}, subscriptions[i], rec)
  else subscriptions.unshift(rec)
  saveSubscriptions()
  return subscriptions.find((s) => s.key === rec.key)
}

function applySubFilter(videos, sub) {
  const list = videos || []
  if (!sub || sub.site !== 'bilibili') return list
  return subs.filterVideos(list, sub.filter)
}

// Hanime 搜索订阅用搜索词、合集订阅用合集名作为文件夹名和文件名前缀，不用上传者
function subDownloadAuthor(sub) {
  if (!sub || sub.site !== 'hanime') return ''
  if (sub.type === 'search') return String(sub.query || sub.name || '').trim()
  if (sub.type === 'playlist') return String(sub.name || '').trim()
  return ''
}

// 已下载和已上传的视频都不用再下载；已上传的单独标记，界面上用蓝色「已上传」
async function buildSubComparison(sub, videos, localMap) {
  const filtered = applySubFilter(videos, sub)
  const ignored = new Set((sub.ignored || []).map((v) => String(v.id)))
  const visible = filtered.filter((v) => !ignored.has(String(v.id)))
  const cmp = subs.buildComparison(visible, localMap || new Map())
  const author = subDownloadAuthor(sub)
  if (author) for (const v of cmp.videos) v.subAuthor = author
  const names = await upload.uploadedNames(sub.key)
  const uploadedIds = new Set()
  for (const name of names) {
    const id = subs.idFromFilename(sub.site, name)
    if (id) uploadedIds.add(id)
  }
  let uploaded = 0
  for (const v of cmp.videos) {
    if (!uploadedIds.has(String(v.id))) continue
    v.uploaded = true
    v.selected = false
    uploaded++
  }
  const missing = cmp.videos.filter((v) => !v.downloaded && !v.uploaded).length
  return Object.assign(cmp, {
    uploaded,
    missing,
    ignoredCount: filtered.length - visible.length,
    filteredCount: filtered.length
  })
}

// 仅拉取最新时用来判定「翻到了旧视频」：本地已下载 + 云端已上传
async function knownVideoIds(sub, local) {
  const map = sub.site === 'hanime' ? local.hanime : local.bilibili
  const ids = new Set(map.keys())
  try {
    for (const name of await upload.uploadedNames(sub.key)) {
      const id = subs.idFromFilename(sub.site, name)
      if (id) ids.add(id)
    }
  } catch (err) {
    log(`读取已上传清单失败（仅拉取最新将只参考本地）: ${err.message}`)
  }
  return ids
}

async function listSubscriptionVideos(sub, onProgress, local, knownIds) {
  if (sub.site === 'hanime') {
    const proxyUrl = await proxyFor(sub.url)
    return hanime.listSubscription(sub.url, { proxy: proxyUrl, onProgress })
  }
  const known = settings.subLatestOnly && local ? (knownIds || await knownVideoIds(sub, local)) : null
  return bili.listUpVideos(sub.url || `https://space.bilibili.com/${sub.mid}`, (p) => {
    if (onProgress) onProgress(Object.assign({ site: 'bilibili' }, p))
  }, known && known.size ? { stopIds: known } : {})
}

function sendSummaryProgress(p) {
  if (win && !win.isDestroyed()) win.webContents.send('subs:summary:progress', p)
}

let summaryRunning = false
async function buildUpdateSummary() {
  if (summaryRunning) throw new Error('更新汇总正在进行中，请稍候')
  summaryRunning = true
  const groups = []
  const errors = []
  const local = await subs.scanLocalMedia(effectiveDownloadDir())
  const list = subscriptions.slice()
  try {
    for (let i = 0; i < list.length; i++) {
      const sub = list[i]
      sendSummaryProgress({ done: i, total: list.length, current: sub.name })
      try {
        // 本地已下载 + 云端已上传都算「已有」：订阅里的过滤与忽略清单照旧生效，
        // 这样上传后删掉本地文件的视频不会又冒出来
        const known = await knownVideoIds(sub, local)
        const r = await listSubscriptionVideos(sub, null, local, known)
        medialib.saveVideoList(sub.key, r.videos)
        const filtered = applySubFilter(r.videos || [], sub)
        const ignored = new Set((sub.ignored || []).map((v) => String(v.id)))
        let cutoff = -1
        for (let j = 0; j < filtered.length; j++) {
          if (known.has(String(filtered[j].id))) {
            cutoff = j
            break
          }
        }
        const base = cutoff >= 0 ? filtered.slice(0, cutoff) : filtered
        const author = subDownloadAuthor(sub)
        const videos = base
          .filter((v) => !known.has(String(v.id)) && !ignored.has(String(v.id)))
          .map((v) => Object.assign({}, v, { selected: true }, author ? { subAuthor: author } : {}))
        if (videos.length) {
          groups.push({
            key: sub.key,
            site: sub.site,
            type: sub.type,
            name: sub.name,
            face: sub.face,
            filter: sub.filter,
            videos,
            hasLocal: cutoff >= 0,
            latestLocalTitle: cutoff >= 0 ? filtered[cutoff].title : '',
            latestLocalDateText: cutoff >= 0 ? (filtered[cutoff].dateText || '') : '',
            latestLocalCreated: cutoff >= 0 ? (Number(filtered[cutoff].created) || 0) : 0
          })
        }
      } catch (err) {
        errors.push({ key: sub.key, name: sub.name, error: err.message })
        log(`更新汇总失败 ${sub.name}: ${err.message}`)
      }
      await sleep(250)
    }
  } finally {
    summaryRunning = false
    sendSummaryProgress({ done: list.length, total: list.length })
  }
  log(`更新汇总完成: ${groups.length} 个有更新, ${errors.length} 个失败`)
  return { groups, errors, checkedAt: Date.now() }
}

// 定时自动检测订阅：只刷新清单和「待下载」数量，不自动下载
let autoCheckTimer = null
let autoCheckRunning = false

async function autoCheckSubscriptions() {
  if (autoCheckRunning || !subscriptions.length) return
  autoCheckRunning = true
  const found = []
  try {
    const local = await subs.scanLocalMedia(effectiveDownloadDir())
    for (const sub of subscriptions.slice()) {
      const prev = medialib.videoCache(sub.key)
      const prevIds = prev ? new Set(prev.ids) : null
      try {
        const r = await listSubscriptionVideos(sub, null, local)
        const localMap = sub.site === 'hanime' ? local.hanime : local.bilibili
        medialib.saveVideoList(sub.key, r.videos)
        const comparison = await buildSubComparison(sub, r.videos, localMap)
        sub.lastCheckAt = Date.now()
        if (!r.stopped) sub.lastCount = comparison.videos.length
        sub.lastMissing = comparison.missing
        if (!sub.name && r.author) sub.name = r.author
        // 第一次检测只当基线，不然会把全部历史视频都报成「新增」
        const fresh = prevIds ? r.videos.filter((v) => !prevIds.has(String(v.id))) : []
        if (fresh.length) {
          const entry = { key: sub.key, site: sub.site, name: sub.name, fresh: fresh.length, missing: comparison.missing }
          // 自动下载交给渲染层发起，任务列表和下载队列都复用现有那一套
          if (settings.subAutoDownload) {
            const freshIds = new Set(fresh.map((v) => String(v.id)))
            entry.videos = comparison.videos
              .filter((v) => !v.downloaded && !v.uploaded && freshIds.has(String(v.id)))
              .map((v) => ({ id: v.id, title: v.title, url: v.url, duration: v.duration, subAuthor: v.subAuthor || '' }))
          }
          found.push(entry)
        }
      } catch (err) {
        log(`自动检测失败 ${sub.name}: ${err.message}`)
      }
      await sleep(500)
    }
    saveSubscriptions()
  } finally {
    autoCheckRunning = false
  }
  if (!found.length) return
  log(`自动检测完成: ${found.map((f) => `${f.name} 新增 ${f.fresh}`).join('，')}`)
  if (win && !win.isDestroyed()) win.webContents.send('subs:auto', { checkedAt: Date.now(), found, autoDownload: !!settings.subAutoDownload })
}

// 开关或间隔改动后重排定时器；关掉时清空
function scheduleSubAutoCheck() {
  if (autoCheckTimer) clearTimeout(autoCheckTimer)
  autoCheckTimer = null
  if (!settings.subAutoCheck) return
  const minutes = Math.max(5, Number(settings.subCheckInterval) || 60)
  autoCheckTimer = setTimeout(async () => {
    autoCheckTimer = null
    await autoCheckSubscriptions()
    scheduleSubAutoCheck()
  }, minutes * 60 * 1000)
  if (autoCheckTimer.unref) autoCheckTimer.unref()
  log(`订阅自动检测已开启，每 ${minutes} 分钟一次`)
}

function sendSubProgress(p) {
  if (win && !win.isDestroyed()) win.webContents.send('subs:progress', p)
}

function sendUploadProgress(p) {
  if (win && !win.isDestroyed()) win.webContents.send('upload:progress', p)
}

function saveTagStore() {
  store.write('tags.json', tagStore)
}

function tagRecord(site, id) {
  if (!site || !id) return null
  return tagStore[tagApi.tagKey(site, id)] || null
}

function rememberTags(site, id, tags) {
  const rec = { site, id, tags: tagApi.normalizeTags(tags), updatedAt: Date.now() }
  tagStore[tagApi.tagKey(site, id)] = rec
  saveTagStore()
  if (win && !win.isDestroyed()) win.webContents.send('tags:updated', { site, id, key: tagApi.tagKey(site, id), tags: rec.tags })
  return rec
}

function sendTagProgress(p) {
  if (win && !win.isDestroyed()) win.webContents.send('tags:progress', p)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureTagsForUrl(url, opts = {}) {
  const info = tagApi.detectSite(url)
  if (!info) return { info: null, tags: [] }
  const existing = tagRecord(info.site, info.id)
  if (existing && !opts.force) return { info, tags: existing.tags || [] }
  const proxyUrl = await proxyFor(url)
  const list = await tagApi.fetchTags(info.site, info.id, { proxy: proxyUrl })
  const rec = rememberTags(info.site, info.id, list)
  log(`标签 ${info.site}:${info.id} ${rec.tags.length ? rec.tags.slice(0, 8).join('、') : '无'}`)
  return { info, tags: rec.tags }
}

const autoTagQueue = []
let autoTagRunning = false

// 下载完成后异步拉标签，串行执行，避免批量下载时同时请求大量页面
function enqueueAutoTag(url) {
  if (!url || autoTagQueue.includes(url)) return
  autoTagQueue.push(url)
  if (autoTagRunning) return
  autoTagRunning = true
  Promise.resolve().then(async () => {
    try {
      while (autoTagQueue.length) {
        const next = autoTagQueue.shift()
        try {
          await ensureTagsForUrl(next)
        } catch (err) {
          log(`自动打标失败 ${next}: ${err.message}`)
        }
        await sleep(300)
      }
    } finally {
      autoTagRunning = false
    }
  })
}

async function tagAllFiles() {
  const root = effectiveDownloadDir()
  const files = await listMedia(root, 'all')
  const targets = []
  let already = 0
  let unrecognized = 0
  for (const f of files) {
    const info = tagApi.detectFilename(f.path)
    if (!info) {
      unrecognized++
      continue
    }
    if (tagRecord(info.site, info.id)) {
      already++
      continue
    }
    targets.push(info)
  }

  let done = 0
  let tagged = 0
  let empty = 0
  let failed = 0
  sendTagProgress({ done, total: targets.length, tagged, empty, failed })
  for (const info of targets) {
    try {
      const proxyUrl = await proxyFor(info.url)
      const list = await tagApi.fetchTags(info.site, info.id, { proxy: proxyUrl })
      rememberTags(info.site, info.id, list)
      if (list.length) tagged++
      else empty++
    } catch (err) {
      failed++
      log(`一键打标失败 ${info.site}:${info.id}: ${err.message}`)
    }
    done++
    sendTagProgress({ done, total: targets.length, current: info.id, tagged, empty, failed })
    await sleep(250)
  }
  log(`一键打标完成: 新打标 ${tagged}, 无标签 ${empty}, 失败 ${failed}, 已打标 ${already}, 无法识别 ${unrecognized}`)
  return { total: files.length, targets: targets.length, tagged, empty, failed, already, unrecognized }
}

function pushHistory(rec) {
  history.unshift(rec)
  history = history.slice(0, HISTORY_LIMIT)
  saveHistory()
}

function updateHistory(id, patch) {
  const i = history.findIndex((t) => t.id === id)
  if (i === -1) return
  history[i] = Object.assign({}, history[i], patch)
  saveHistory()
}

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 800,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#14161a',
    title: '捕梦网',
    icon: path.join(ROOT, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'))
}

async function proxyFor(url) {
  // B 站直连：走境外代理既慢又容易触发风控
  try {
    if (/(^|\.)bilibili\.com$/i.test(new URL(url).hostname)) return null
  } catch (_) { /* URL 不合法时交给 yt-dlp 报错 */ }
  if (settings.proxyMode === 'direct') return null
  if (settings.proxyMode === 'custom') return (settings.proxyUrl || '').trim() || null
  return proxy.resolveProxy(url)
}

function formatFor(maxHeight, audioOnly) {
  if (audioOnly) return 'ba/b'
  if (!maxHeight) return 'bv*+ba/b'
  // 末尾的 /bv*+ba/b 是兜底：某些视频没有低分辨率格式，不能直接失败
  return `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/bv*+ba/b`
}

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.flv', '.mov', '.ts', '.m4v'])
const AUDIO_EXT = new Set(['.m4a', '.mp3', '.aac', '.flac', '.wav', '.ogg'])

// 用户在设置里指定的目录优先；不可写时退回默认下载目录
function effectiveDownloadDir() {
  const custom = String(settings.downloadDir || '').trim()
  if (custom && dl.ensureWritable(custom)) return custom
  return DOWNLOAD_DIR
}

async function listMedia(root, filter) {
  const out = []
  async function walk(dir, depth) {
    if (depth > 6 || out.length >= 3000) return
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      const ext = path.extname(ent.name).toLowerCase()
      const type = VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : null
      if (!type) continue
      if (filter && filter !== 'all' && filter !== type) continue
      try {
        const st = await fs.promises.stat(full)
        // 文件名以「UP名_YYYY-MM-DD_」开头；列表里只展示原视频名
        let display = ent.name
        const parent = path.basename(dir)
        if (parent && display.startsWith(parent + '_')) {
          const rest = display.slice(parent.length + 1)
          const stripped = rest.replace(/^\d{4}-\d{2}-\d{2}_/, '')
          if (stripped !== rest) display = stripped
        }
        out.push({ name: display, path: full, size: st.size, mtime: st.mtimeMs, type })
      } catch (_) { /* 文件可能刚被删除 */ }
    }
  }
  await walk(root, 0)
  return out.sort((a, b) => b.mtime - a.mtime)
}

function pickMeta(info) {
  return {
    id: info.id,
    title: info.title,
    uploader: info.uploader,
    duration: info.duration || 0,
    thumbnail: info.thumbnail,
    webpage_url: info.webpage_url,
    formats: (info.formats || [])
      .filter((f) => f.vcodec !== 'none' || f.acodec !== 'none')
      .map((f) => ({
        format_id: f.format_id,
        height: f.height || 0,
        ext: f.ext,
        vcodec: f.vcodec || '',
        acodec: f.acodec || '',
        tbr: f.tbr || 0,
        filesize: f.filesize || 0,
        note: f.format_note || ''
      }))
  }
}

async function makeCookieFile(id) {
  const dest = path.join(COOKIE_DIR, `${id}.txt`)
  const names = await auth.exportCookies(dest)
  const hasSession = names.includes('SESSDATA')
  log(`cookie 导出 ${names.length} 条 ${hasSession ? '(含 SESSDATA)' : '(未登录)'}`)
  return dest
}

// 充电专属视频在无权益时只会给试看片段，提前提示比下完再发现更好
async function checkUpower(url) {
  const m = /(BV[0-9A-Za-z]+)/.exec(url)
  if (!m) return false
  try {
    const res = await auth.getSession().fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${m[1]}`, {
      headers: { Referer: 'https://www.bilibili.com/' },
      credentials: 'include'
    })
    const j = await res.json()
    return !!(j && j.data && j.data.is_upower_exclusive)
  } catch (_) {
    return false
  }
}

// 并发上限 2 的简单队列，超出的任务在前端显示“排队中”
function pump() {
  const max = Math.max(1, Number(settings.concurrency) || 2)
  while (active < max && queue.length) {
    const job = queue.shift()
    active++
    Promise.resolve()
      .then(job)
      .catch((err) => log('队列任务异常:', err.message))
      .finally(() => {
        active--
        pump()
      })
  }
}

async function timedFetch(fetchFn, url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const r = await fetchFn(url, { signal: ctrl.signal, method: 'HEAD' })
    return { ok: r.status < 500, ms: Date.now() - t0, status: r.status }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.name === 'AbortError' ? '超时' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

// 判断代理是否真的生效：B 站走登录会话（直连），YouTube 走系统代理
async function testProxy() {
  const bilibili = await timedFetch((u, o) => auth.getSession().fetch(u, o), 'https://api.bilibili.com/x/web-interface/nav', 8000)
  const youtube = await timedFetch((u, o) => net.fetch(u, o), 'https://www.youtube.com', 8000)
  const resolved = await proxy.resolveProxy('https://www.youtube.com')
  log(`代理测试: bilibili=${bilibili.ok ? bilibili.ms + 'ms' : 'FAIL(' + (bilibili.error || bilibili.status) + ')'} youtube=${youtube.ok ? youtube.ms + 'ms' : 'FAIL(' + (youtube.error || youtube.status) + ')'} resolved=${resolved || 'direct'}`)
  return { bilibili, youtube, resolved }
}

function registerIpc() {
  ipcMain.handle('auth:status', () => auth.checkLogin())

  ipcMain.handle('auth:open', async () => {
    const st = await auth.openLogin(win)
    log('登录窗口关闭:', JSON.stringify({ reason: st.reason, ok: st.ok, name: st.name }))
    return st
  })

  ipcMain.handle('settings:get', () => settings)

  ipcMain.handle('tasks:list', () => history)

  ipcMain.handle('tasks:clear', () => {
    history = history.filter((t) => t.status === 'running')
    saveHistory()
    log(`已清除下载记录，保留进行中 ${history.length} 条`)
    return history
  })

  // 失败/取消的任务不在 tasks 里，可以单独清除；还在执行的任务不允许删
  ipcMain.handle('tasks:remove', (_e, id) => {
    if (!id || tasks.has(id)) return false
    history = history.filter((t) => t.id !== id)
    saveHistory()
    log(`已删除下载记录 ${id}`)
    return true
  })

  ipcMain.handle('files:list', async (_e, filter) => {
    const root = effectiveDownloadDir()
    const files = await listMedia(root, filter)
    for (const f of files) {
      const info = tagApi.detectFilename(f.path)
      f.taggable = !!info
      f.tagged = false
      f.tags = []
      if (info) {
        const rec = tagRecord(info.site, info.id)
        if (rec) {
          f.tagged = true
          f.tags = rec.tags || []
        }
      }
    }
    return { root, files }
  })

  ipcMain.handle('tags:tagAll', () => tagAllFiles())

  ipcMain.handle('files:trash', async (_e, p) => {
    if (!p) return false
    await shell.trashItem(p)
    log('已移入回收站: ' + p)
    return true
  })

  ipcMain.handle('dialog:pick-dir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: effectiveDownloadDir()
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('update:check', async () => {
    try {
      const st = await updater.checkForUpdate()
      log(`检查更新: 本地 ${st.localVersion} 远端 ${st.remoteVersion}${st.updateAvailable ? ' 有更新' : ' 已最新'} 来源=${st.source || '-'}`)
      return st
    } catch (err) {
      log('检查更新失败: ' + err.message)
      return { ok: false, error: err.message, localVersion: app.getVersion() }
    }
  })

  ipcMain.handle('update:get', () => updater.getState())

  ipcMain.handle('update:install', async () => {
    try {
      const r = await updater.installUpdate()
      log(`开始安装更新 ${r.version}`)
      return r
    } catch (err) {
      log('安装更新失败: ' + err.message)
      throw err
    }
  })

  ipcMain.handle('settings:set', async (_e, next) => {
    const mode = ['system', 'direct', 'custom'].includes(next.proxyMode) ? next.proxyMode : 'system'
    const concRaw = next.concurrency == null ? settings.concurrency : next.concurrency
    const speedRaw = next.maxSpeed == null ? settings.maxSpeed : next.maxSpeed
    const concurrency = Math.max(1, Math.min(10, parseInt(concRaw, 10) || 2))
    const maxSpeed = Math.max(0, Number(speedRaw) || 0)
    const intervalRaw = next.subCheckInterval == null ? settings.subCheckInterval : next.subCheckInterval
    settings = Object.assign({}, settings, {
      proxyMode: mode,
      proxyUrl: String(next.proxyUrl || ''),
      downloadDir: String(next.downloadDir || ''),
      concurrency,
      maxSpeed,
      subAutoCheck: next.subAutoCheck == null ? !!settings.subAutoCheck : !!next.subAutoCheck,
      subCheckInterval: Math.max(5, Math.min(1440, parseInt(intervalRaw, 10) || 60)),
      subLatestOnly: next.subLatestOnly == null ? !!settings.subLatestOnly : !!next.subLatestOnly,
      subAutoDownload: next.subAutoDownload == null ? !!settings.subAutoDownload : !!next.subAutoDownload
    })
    store.write('settings.json', settings)
    await auth.applyProxy(settings)
    scheduleSubAutoCheck()
    log(`设置已更新: proxyMode=${settings.proxyMode} proxyUrl=${settings.proxyUrl || '-'} concurrency=${settings.concurrency} maxSpeed=${settings.maxSpeed || '不限'}`)
    return settings
  })

  ipcMain.handle('video:probe', async (_e, url) => {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('链接格式不对，需要以 http(s):// 开头')
    if (hanime.isUrl(url)) {
      const proxyUrl = await proxyFor(url)
      const info = await hanime.probe(url, { proxy: proxyUrl })
      const rec = rememberTags('hanime', info.id, info.tags)
      log(`解析成功: ${info.title} (hanime, proxy=${proxyUrl || 'direct'})`)
      return {
        id: info.id,
        site: 'hanime',
        title: info.title,
        uploader: info.uploader,
        duration: info.duration,
        thumbnail: info.thumbnail,
        webpage_url: info.url,
        formats: info.formats.map((f) => ({
          format_id: f.format_id,
          height: f.height,
          ext: f.ext,
          vcodec: f.vcodec,
          acodec: f.acodec,
          tbr: f.tbr,
          filesize: f.filesize,
          note: f.note
        })),
        warnings: [],
        tags: rec.tags,
        audio: false
      }
    }

    const cookieFile = await makeCookieFile('probe-' + Date.now().toString(36))
    try {
      const proxyUrl = await proxyFor(url)
      const { info, warnings } = await dl.probe(url, { cookieFile, proxy: proxyUrl })
      if (warnings.length) log(`解析警告: ${warnings.join(' | ')}`)
      log(`解析成功: ${info.title} (proxy=${proxyUrl || 'direct'})`)
      const meta = Object.assign(pickMeta(info), { warnings })
      meta.site = (tagApi.detectSite(url) || {}).site || ''
      try {
        const tagResult = await ensureTagsForUrl(url)
        meta.tags = tagResult.tags
      } catch (err) {
        log(`获取标签失败: ${err.message}`)
        meta.tags = []
      }
      if (/bilibili\.com\/video\//i.test(url)) meta.upowerExclusive = await checkUpower(url)
      return meta
    } finally {
      fs.rm(cookieFile, { force: true }, () => {})
    }
  })

  ipcMain.handle('up:list', async (_e, url) => {
    const r = await bili.listUpVideos(url, (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('up:progress', p)
    })
    log(`UP 列表: mid=${r.mid} 共 ${r.videos.length} 个视频`)
    return r
  })

  ipcMain.handle('subs:list', () => subscriptions)

  ipcMain.handle('subs:add', async (_e, url) => {
    const list = await bili.listUpVideos(url, sendSubProgress)
    let profile = { name: '', face: '' }
    try {
      profile = await bili.fetchUpProfile(list.mid)
    } catch (err) {
      log(`获取 UP 资料失败: ${err.message}`)
    }
    const name = profile.name || list.author || `UP ${list.mid}`
    const rec = normalizeSubscription({
      site: 'bilibili',
      type: 'up',
      mid: list.mid,
      name,
      face: profile.face,
      filter: 'all',
      ignored: [],
      lastCheckAt: Date.now(),
      addedAt: Date.now()
    })
    const prev = findSubscription(rec.key)
    if (prev) Object.assign(rec, { filter: prev.filter, ignored: prev.ignored, addedAt: prev.addedAt })
    const local = await subs.scanLocalMedia(effectiveDownloadDir())
    const comparison = await buildSubComparison(rec, list.videos, local.bilibili)
    medialib.saveVideoList(rec.key, list.videos)
    rec.lastCount = comparison.videos.length
    rec.lastMissing = comparison.missing
    const saved = upsertSubscription(rec)
    log(`订阅 UP: mid=${list.mid} name=${name} 共 ${comparison.videos.length} 个，待下载 ${comparison.missing}`)
    return Object.assign({ subscription: saved }, comparison)
  })

  ipcMain.handle('subs:addHanime', async (_e, url) => {
    const proxyUrl = await proxyFor(url)
    const info = await hanime.listSubscription(url, { proxy: proxyUrl, onProgress: sendSubProgress })
    const rec = normalizeSubscription({
      site: 'hanime',
      type: info.type,
      listId: info.type === 'playlist' ? info.id : '',
      userId: info.type === 'uploader' ? info.id : '',
      query: info.type === 'search' ? info.id : '',
      url: info.url,
      name: info.name,
      face: info.face,
      filter: 'all',
      ignored: [],
      lastCheckAt: Date.now(),
      addedAt: Date.now()
    })
    const prev = findSubscription(rec.key)
    if (prev) Object.assign(rec, { ignored: prev.ignored, addedAt: prev.addedAt })
    const local = await subs.scanLocalMedia(effectiveDownloadDir())
    const comparison = await buildSubComparison(rec, info.videos, local.hanime)
    medialib.saveVideoList(rec.key, info.videos)
    rec.lastCount = comparison.videos.length
    rec.lastMissing = comparison.missing
    const saved = upsertSubscription(rec)
    log(`订阅 Hanime: ${info.type}=${info.id} name=${info.name} 共 ${comparison.videos.length} 个，待下载 ${comparison.missing}`)
    return Object.assign({ subscription: saved }, comparison)
  })

  ipcMain.handle('subs:check', async (_e, key) => {
    const sub = findSubscription(key)
    if (!sub) throw new Error('订阅不存在，可能已被删除')
    const local = await subs.scanLocalMedia(effectiveDownloadDir())
    const r = await listSubscriptionVideos(sub, sendSubProgress, local)
    medialib.saveVideoList(sub.key, r.videos)
    const localMap = sub.site === 'hanime' ? local.hanime : local.bilibili
    const comparison = await buildSubComparison(sub, r.videos, localMap)
    sub.lastCheckAt = Date.now()
    // 仅拉取最新时只拿到最新一段，「共 N 个」保留上次的完整数量
    if (!r.stopped) sub.lastCount = comparison.videos.length
    sub.lastMissing = comparison.missing
    if (!sub.name && r.author) sub.name = r.author
    saveSubscriptions()
    log(`检查订阅: ${sub.site}:${sub.key} 共 ${comparison.videos.length} 个，待下载 ${comparison.missing}`)
    return Object.assign({ subscription: sub }, comparison)
  })

  ipcMain.handle('subs:remove', (_e, key) => {
    const sub = findSubscription(key)
    if (!sub) return subscriptions
    subscriptions = subscriptions.filter((s) => s.key !== sub.key)
    saveSubscriptions()
    const cleared = upload.clearCloud(sub.key)
    log(`取消订阅: ${sub.key}${cleared ? `，一并移除云同步设置` : ''}`)
    return subscriptions
  })

  // 下载完成后只重扫本地，不重复请求网页清单
  ipcMain.handle('subs:compare', async (_e, payload) => {
    const sub = findSubscription(payload && (payload.key || payload.mid))
    const ids = Array.isArray(payload && payload.ids) ? payload.ids.map(String) : []
    const local = await subs.scanLocalMedia(effectiveDownloadDir())
    const localMap = sub && sub.site === 'hanime' ? local.hanime : local.bilibili
    const map = {}
    for (const id of ids) if (localMap.has(id)) map[id] = localMap.get(id)
    const downloaded = Object.keys(map).length
    if (sub) {
      sub.lastMissing = ids.length - downloaded
      saveSubscriptions()
    }
    return { map, subscription: sub || null, downloaded, missing: ids.length - downloaded }
  })

  ipcMain.handle('subs:settings', (_e, payload) => {
    const sub = findSubscription(payload && payload.key)
    if (!sub) throw new Error('订阅不存在，可能已被删除')
    if (sub.site === 'bilibili' && ['all', 'normal', 'charging'].includes(payload.filter)) {
      sub.filter = payload.filter
    }
    // 云同步跟订阅走：选了网盘就落一条上传任务，选「不上传」就删掉
    const cloud = payload && payload.cloud
    if (cloud && typeof cloud === 'object') {
      if (cloud.provider === 'ugreen') {
        upload.setCloud({
          subKey: sub.key,
          subName: sub.name || sub.key,
          dest: cloud.dest,
          autoUpload: !!cloud.autoUpload,
          deleteLocal: !!cloud.deleteLocal
        })
        log(`云同步设置: ${sub.key} → ${cloud.dest}${cloud.autoUpload ? '（自动上传）' : ''}${cloud.deleteLocal ? '（上传后删本地）' : ''}`)
      } else {
        upload.clearCloud(sub.key)
        log(`云同步设置: ${sub.key} 改为不上传`)
      }
    }
    saveSubscriptions()
    log(`订阅设置: ${sub.key} filter=${sub.filter} ignored=${sub.ignored.length}`)
    return sub
  })

  ipcMain.handle('subs:cloud', (_e, key) => {
    const sub = findSubscription(key)
    return { task: (sub && upload.taskForSub(sub.key)) || null }
  })

  // 立即同步这一个订阅的云同步
  ipcMain.handle('subs:sync', async (_e, key) => {
    const sub = findSubscription(key)
    if (!sub) throw new Error('订阅不存在，可能已被删除')
    const task = upload.taskForSub(sub.key)
    if (!task) throw new Error('这个订阅还没有云同步设置')
    log(`同步上传任务 ${task.id}: ${task.subName || task.subKey} → ${task.dest}`)
    const r = await upload.runTask(task.id, {
      downloadDir: effectiveDownloadDir(),
      onProgress: sendUploadProgress
    })
    log(`上传任务 ${task.id}: 上传 ${r.uploaded} 跳过 ${r.skipped}${r.failed ? ` 失败 ${r.failed}` : ''}${r.error ? ` ${r.error}` : ''}`)
    return r
  })

  ipcMain.handle('subs:ignore', (_e, payload) => {
    const sub = findSubscription(payload && payload.key)
    if (!sub) throw new Error('订阅不存在，可能已被删除')
    const videos = Array.isArray(payload.videos) ? payload.videos : []
    const have = new Set(sub.ignored.map((v) => String(v.id)))
    for (const v of videos) {
      const id = String((v && v.id) || '')
      if (!id || have.has(id)) continue
      have.add(id)
      sub.ignored.push({
        id,
        title: String(v.title || id),
        created: Number(v.created) || 0,
        dateText: String(v.dateText || ''),
        thumb: String(v.thumb || ''),
        url: String(v.url || ''),
        site: sub.site,
        ignoredAt: Date.now()
      })
    }
    saveSubscriptions()
    log(`忽略更新: ${sub.key} +${videos.length}，共 ${sub.ignored.length}`)
    return sub
  })

  ipcMain.handle('subs:unignore', (_e, payload) => {
    const sub = findSubscription(payload && payload.key)
    if (!sub) throw new Error('订阅不存在，可能已被删除')
    const ids = new Set((Array.isArray(payload.ids) ? payload.ids : []).map(String))
    sub.ignored = sub.ignored.filter((v) => !ids.has(String(v.id)))
    saveSubscriptions()
    log(`移除忽略: ${sub.key} 剩余 ${sub.ignored.length}`)
    return sub
  })

  ipcMain.handle('subs:summary', () => buildUpdateSummary())

  ipcMain.handle('ugreen:config', () => ugreen.publicConfig())

  ipcMain.handle('ugreen:saveConfig', (_e, patch) => {
    const cfg = ugreen.saveConfig(patch || {})
    log(`绿联云账号配置已更新: ${cfg.username || '(空)'} endpoint=${cfg.endpoint}`)
    return cfg
  })

  // 只检查本地缓存，不主动联网；force=true 时才真的去登录一次
  ipcMain.handle('ugreen:status', () => ugreen.test(false))

  ipcMain.handle('ugreen:login', async () => {
    const r = await ugreen.test(true)
    log(`绿联云登录: ${r.ok ? '成功' : '失败 ' + r.error}`)
    return r
  })

  ipcMain.handle('ugreen:logout', () => {
    ugreen.clearSession()
    log('绿联云登录状态已清除')
    return { ok: true }
  })

  ipcMain.handle('ugreen:listDir', (_e, p) => ugreen.listDir(p))

  ipcMain.handle('upload:list', () => upload.list())

  ipcMain.handle('upload:save', (_e, task) => upload.save(task || {}))

  ipcMain.handle('upload:remove', (_e, id) => upload.remove(id))

  ipcMain.handle('upload:clearHistory', () => {
    const n = upload.clearHistory()
    log(`已清除上传记录 ${n} 条`)
    return n
  })

  ipcMain.handle('upload:run', async (_e, id) => {
    const r = await upload.runTask(id, { downloadDir: effectiveDownloadDir(), onProgress: sendUploadProgress })
    log(`上传任务 ${id}: 上传 ${r.uploaded} 跳过 ${r.skipped} 失败 ${r.failed}${r.error ? ' ' + r.error : ''}`)
    if (win && !win.isDestroyed()) win.webContents.send('upload:done', Object.assign({ id }, r))
    return Object.assign({ ok: !r.error }, r)
  })

  ipcMain.handle('upload:clearUploadedLocal', async (_e, id) => {
    const r = await upload.clearUploadedLocal(id, { downloadDir: effectiveDownloadDir() })
    log(`清除已上传的本地文件 ${id}: 删除 ${r.deleted} 个 / 保留 ${r.kept} 个${r.failed ? ' / 失败 ' + r.failed : ''}${r.error ? ' ' + r.error : ''}`)
    return r
  })

  ipcMain.handle('video:download', async (_e, payload) => {
    const id = payload.id || Date.now().toString(36)
    const state = { pid: 0, canceled: false }
    tasks.set(id, state)
    pushHistory({ id, url: payload.url, title: payload.title || payload.url, status: 'running', createdAt: Date.now() })
    const isHanime = hanime.isUrl(payload.url)
    const subAuthor = isHanime ? String(payload.subAuthor || '').trim() : ''
    const cookieFile = isHanime ? '' : await makeCookieFile(id)

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (cookieFile) fs.rm(cookieFile, { force: true }, () => {})
        tasks.delete(id)
      }
      queue.push(async () => {
        if (state.canceled) {
          updateHistory(id, { status: 'canceled', finishedAt: Date.now() })
          cleanup()
          return resolve({ ok: true, canceled: true })
        }
        try {
          const proxyUrl = await proxyFor(payload.url)
          const onEvent = (ev) => {
            if (ev.type === 'spawn') state.pid = ev.pid
            if (ev.type === 'file') log(`下载完成 ${id}: ${ev.file}`)
            if (win && !win.isDestroyed()) win.webContents.send('task:progress', Object.assign({ id }, ev))
          }
          let res
          if (isHanime) {
            const info = await hanime.probe(payload.url, { proxy: proxyUrl })
            const chosen = hanime.pickFormat(info.formats, Number(payload.maxHeight) || 0)
            if (!chosen) throw new Error('没有找到可下载的视频源')
            const final = hanime.outputPath(effectiveDownloadDir(), info, subAuthor)
            fs.mkdirSync(path.dirname(final), { recursive: true })
            log(`开始下载 ${id}: ${payload.url} (hanime ${chosen.height}p, proxy=${proxyUrl || 'direct'})`)
            res = await dl.start({
              id,
              url: chosen.url,
              direct: true,
              // yt-dlp 会把 -o 当模板，标题里的 % 需要转义成 %%
              output: final.replace(/%/g, '%%'),
              outDir: path.dirname(final),
              proxy: proxyUrl,
              state,
              rateLimit: Number(settings.maxSpeed) || 0
            }, onEvent)
            if (!res.file && fs.existsSync(final)) res.file = final
          } else {
            const format = formatFor(Number(payload.maxHeight) || 0, !!payload.audioOnly)
            log(`开始下载 ${id}: ${payload.url} format=${format} proxy=${proxyUrl || 'direct'}`)
            res = await dl.start(
              { id, url: payload.url, format, outDir: effectiveDownloadDir(), cookieFile, proxy: proxyUrl, state, rateLimit: Number(settings.maxSpeed) || 0 },
              onEvent
            )
          }
          // 没有权益时 yt-dlp 会把试看片段当成功下载，这里用时长兜底识别
          let warning = ''
          const expected = Number(payload.expectedDuration) || 0
          if (res.file && expected > 0) {
            const actual = await dl.probeDuration(res.file)
            log(`时长探测 ${id}: expected=${expected} actual=${actual}`)
            if (actual > 0 && actual < expected * 0.9) {
              warning = `文件时长 ${fmtSec(actual)}，原视频 ${fmtSec(expected)}，可能是试看片段或下载不完整`
              log(`时长校验未通过 ${id}: ${warning}`)
              if (win && !win.isDestroyed()) win.webContents.send('task:progress', { id, type: 'warning', message: warning })
            }
          }
          if (res.canceled) {
            updateHistory(id, { status: 'canceled', finishedAt: Date.now() })
          } else {
            updateHistory(id, { status: 'done', file: res.file, warning, finishedAt: Date.now() })
            if (res.file) {
              enqueueAutoTag(payload.url)
              medialib.recordFile({ file: res.file, id: payload.mediaId, key: payload.subKey })
              // 只传刚下完的文件；下载失败或取消不会走到这里
              if (payload.subKey) {
                upload.autoAfterDownload(payload.subKey, res.file, {
                  downloadDir: effectiveDownloadDir(),
                  onProgress: sendUploadProgress
                }).catch((err) => log(`自动上传失败 ${id}: ${err.message}`))
              }
            }
          }
          resolve({ ok: true, file: res.file, canceled: !!res.canceled, warning })
        } catch (err) {
          log(`下载失败 ${id}: ${err.message}`)
          updateHistory(id, { status: 'failed', error: err.message, finishedAt: Date.now() })
          reject(new Error(err.message))
        } finally {
          cleanup()
        }
      })
      pump()
    })
  })

  ipcMain.handle('video:cancel', (_e, id) => {
    const t = tasks.get(id)
    if (!t) return false
    t.canceled = true
    if (t.abort) t.abort()
    if (t.pid) dl.cancel(t.pid)
    log(`已请求取消 ${id}`)
    return true
  })

  ipcMain.handle('proxy:test', () => testProxy())

  ipcMain.handle('engine:update', async () => {
    log('开始更新 yt-dlp…')
    const r = await dl.updateEngine()
    log('更新结果: ' + r.output.replace(/\s*\n\s*/g, ' | '))
    return r
  })

  ipcMain.handle('shell:open-path', (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p)
    else shell.openPath(effectiveDownloadDir())
    return true
  })

  // 直接 CreateProcess 拉起 explorer，绕开 ShellExecuteEx（受限令牌下它会弹“无法访问”对话框）
  ipcMain.handle('shell:reveal', (_e, p) => {
    return new Promise((resolve) => {
      const exists = !!p && fs.existsSync(p)
      const isFile = exists && fs.statSync(p).isFile()
      const target = isFile ? p : effectiveDownloadDir()
      const dir = isFile ? path.dirname(target) : target
      // /select, 后面必须紧跟路径，且是同一个参数。
      // 路径常带空格，必须自己加引号并关掉 Node 的自动转义，
      // 否则 explorer 会把引号收在 /select, 外面，带空格的文件选不中。
      const arg = isFile ? `/select,"${target}"` : `"${dir}"`
      let settled = false
      const done = (r) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      let child
      try {
        child = spawn('explorer.exe', [arg], {
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true
        })
      } catch (e) {
        log('打开文件夹失败(抛出): ' + e.message)
        return done({ ok: false, error: e.message, path: dir })
      }
      child.on('error', (e) => {
        log('打开文件夹失败(进程): ' + e.message)
        done({ ok: false, error: e.message, path: dir })
      })
      child.on('exit', (code) => {
        log(`explorer 退出码 ${code} (${dir})`)
        // explorer 把请求转交给已运行的资源管理器后通常以 1 退出，这是正常结果；
        // 只有 0xC0000142（STATUS_DLL_INIT_FAILED）才表示进程根本没起来
        if (code === 3221225794 || code === -1073741502) {
          done({ ok: false, error: `explorer 退出码 ${code}（当前运行环境无法启动资源管理器）`, path: dir })
        } else {
          done({ ok: true, path: dir })
        }
      })
      child.unref()
      log('尝试打开: ' + dir + ' arg=' + arg)
      setTimeout(() => done({ ok: true, path: dir }), 400)
    })
  })

  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text || ''))
    return true
  })
}

// 退出前强制把 Cookie 刷盘，否则进程被结束时登录态会丢
let cookiesFlushed = false
app.on('before-quit', (e) => {
  if (cookiesFlushed) return
  e.preventDefault()
  auth.getSession().cookies.flushStore()
    .catch(() => {})
    .finally(() => {
      cookiesFlushed = true
      app.quit()
    })
})

app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  app.setAppUserModelId('com.dreamcatcher.desktop')
  app.userAgentFallback = auth.UA
  registerIpc()
  await auth.applyProxy(settings)
  if (process.argv.includes('--selftest')) return selftest()
  createWindow()
  updater.autoCheck(win, log)
  // 老版本的「上传任务」并入订阅：同一订阅只留最近同步的那一条
  const merged = upload.migrateOnePerSub()
  if (merged.length) {
    log(`上传任务已并入订阅：移除 ${merged.length} 条重复任务（${merged.map((t) => t.subName || t.subKey).join('，')}）`)
  }
  // 启动后补跑一次自动同步，覆盖关机期间漏掉的文件
  setTimeout(() => {
    upload.autoAll({ downloadDir: effectiveDownloadDir(), onProgress: sendUploadProgress })
      .then((rs) => {
        if (rs.length) log(`自动同步完成: ${rs.length} 个任务`)
      })
      .catch((err) => log(`自动同步失败: ${err.message}`))
  }, 15000)
  scheduleSubAutoCheck()
})

// 无界面自检：只验证 cookie 导出与 yt-dlp 链路，不涉及登录
async function selftest() {
  const BV = 'https://www.bilibili.com/video/BV1kYsW6NE6E'
  try {
    log('=== SELFTEST START ===')
    const w = new BrowserWindow({ show: false, webPreferences: { partition: auth.PARTITION } })
    await w.loadURL('https://www.bilibili.com/')
    await new Promise((r) => setTimeout(r, 5000))
    log('login state:', JSON.stringify(await auth.checkLogin()))
    const cookiePath = path.join(ROOT, '.tmp', 'selftest-cookies.txt')
    const names = await auth.exportCookies(cookiePath)
    log('cookies exported:', names.length, 'SESSDATA:', names.includes('SESSDATA'), 'exists:', fs.existsSync(cookiePath))
    const { info } = await dl.probe(BV, { cookieFile: cookiePath })
    const heights = [...new Set(info.formats.filter((f) => f.height).map((f) => f.height))].sort((a, b) => a - b)
    log('probe ok:', info.title, '| formats:', info.formats.length, '| heights:', heights.join(','))
    const outDir = path.join(ROOT, '.tmp', 'selftest-dl')
    const res = await dl.start(
      { id: 'selftest', url: BV, format: 'bv*[height<=360]+ba/b[height<=360]', outDir, cookieFile: cookiePath },
      (ev) => {
        if (ev.type === 'file') log('file:', ev.file)
        if (ev.type === 'progress' && ev.percent > 0 && Math.floor(ev.percent) % 30 === 0) log('progress:', ev.percent.toFixed(0) + '%')
      }
    )
    log('download result:', JSON.stringify(res))
    log('=== SELFTEST OK ===')
  } catch (err) {
    log('=== SELFTEST FAILED ===', err.message)
  } finally {
    fs.rmSync(path.join(ROOT, '.tmp', 'selftest-cookies.txt'), { force: true })
    app.quit()
  }
}
