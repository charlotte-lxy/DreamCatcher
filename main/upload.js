'use strict'
// 上传任务：一个任务 = 一个订阅 + 绿联云目录 + 同步方式
// 比对基准直接取绿联云目录列表（同名同大小即视为已上传），不额外维护清单文件
const fs = require('fs')
const path = require('path')
const store = require('./store')
const subs = require('./subscription')
const ug = require('./ugreen')
const medialib = require('./medialib')

const FILE = 'upload-tasks.json'
const MAX_TASKS = 50

function list() {
  const l = store.readAny(FILE, [])
  return Array.isArray(l) ? l : []
}

function saveAll(l) {
  store.write(FILE, l)
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null
  const subKey = String(raw.subKey || '').trim()
  const dest = String(raw.dest || '').trim()
  if (!subKey || !dest) return null
  return {
    id: String(raw.id || 'up' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    subKey,
    subName: String(raw.subName || ''),
    dest,
    mode: raw.mode === 'auto' ? 'auto' : 'manual',
    deleteLocal: !!raw.deleteLocal,
    enabled: raw.enabled !== false,
    createdAt: Number(raw.createdAt) || Date.now(),
    lastRunAt: Number(raw.lastRunAt) || 0,
    last: raw.last && typeof raw.last === 'object' ? raw.last : null
  }
}

function save(payload) {
  const rec = normalize(payload)
  if (!rec) throw new Error('上传任务需要选择订阅和上传位置')
  const l = list()
  const i = l.findIndex((t) => t.id === rec.id)
  if (i >= 0) l[i] = Object.assign({}, l[i], rec, { createdAt: l[i].createdAt || rec.createdAt })
  else l.unshift(rec)
  saveAll(l.slice(0, MAX_TASKS))
  return list()
}

function remove(id) {
  saveAll(list().filter((t) => t.id !== id))
  return list()
}

function tasksForKey(key) {
  if (!key) return []
  return list().filter((t) => t.subKey === String(key) && t.enabled)
}

function updateTask(id, patch) {
  const l = list()
  const i = l.findIndex((t) => t.id === id)
  if (i < 0) return null
  l[i] = Object.assign({}, l[i], patch)
  saveAll(l)
  return l[i]
}

// 已下载到本地的候选文件：索引里登记的优先，老文件用清单缓存里的 ID 扫目录兜底
async function candidates(task, downloadDir) {
  const found = new Map()
  const add = (p) => {
    try {
      const st = fs.statSync(p)
      if (!st.isFile() || !st.size) return
      if (!subs.MEDIA_EXT.has(path.extname(p).toLowerCase())) return
      found.set(path.basename(p), { path: p, size: st.size })
    } catch (_) { /* 文件已被删除或正在写入 */ }
  }
  for (const e of medialib.entriesForKey(task.subKey)) add(e.file)

  const cache = medialib.videoCache(task.subKey)
  if (cache && cache.ids.length && downloadDir) {
    const local = await subs.scanLocalMedia(downloadDir)
    const site = String(task.subKey).split(':')[0]
    const map = site === 'hanime' ? local.hanime : local.bilibili
    for (const id of cache.ids) {
      const p = map.get(String(id))
      if (p) add(p)
    }
  }
  return [...found.values()]
}

const running = new Map()

async function runOne(task, { downloadDir, only, onProgress } = {}) {
  if (running.has(task.id)) return { skipped: true, reason: '任务正在执行' }
  const job = doRun(task, { downloadDir, only, onProgress })
  running.set(task.id, job)
  try {
    return await job
  } finally {
    running.delete(task.id)
  }
}

async function doRun(task, { downloadDir, only, onProgress } = {}) {
  const result = { uploaded: 0, skipped: 0, failed: 0, bytes: 0, files: [], error: '', at: Date.now() }
  try {
    await ug.ensureDir(task.dest)
    const remote = await ug.listDir(task.dest)
    const have = new Set(remote.files.map((f) => f.name + '\u0000' + f.size))

    let items = await candidates(task, downloadDir)
    if (only) {
      const target = path.resolve(only)
      items = items.filter((i) => path.resolve(i.path) === target)
    }
    const count = items.length
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const name = path.basename(item.path)
      if (have.has(name + '\u0000' + item.size)) {
        result.skipped++
        continue
      }
      try {
        // 开始/进度/结束都走同一路事件，任务列表里按文件生成条目
        const base = { taskId: task.id, taskName: task.subName, dest: task.dest, file: name, index: index + 1, count }
        if (onProgress) onProgress(Object.assign({ phase: 'start', done: 0, total: item.size }, base))
        await ug.uploadFile(item.path, task.dest, (done, total) => {
          if (onProgress) onProgress(Object.assign({ phase: 'chunk', done, total }, base))
        })
        result.uploaded++
        result.bytes += item.size
        result.files.push(name)
        if (onProgress) onProgress(Object.assign({ phase: 'done', done: item.size, total: item.size }, base))
        if (task.deleteLocal) fs.promises.rm(item.path, { force: true }).catch(() => {})
      } catch (err) {
        result.failed++
        result.error = String(err.message || err)
        if (onProgress) {
          onProgress(Object.assign({
            phase: 'error', done: 0, total: item.size, error: result.error,
            taskId: task.id, taskName: task.subName, dest: task.dest, file: name, index: index + 1, count
          }))
        }
      }
    }
  } catch (err) {
    result.failed++
    result.error = String(err.message || err)
  }
  updateTask(task.id, {
    lastRunAt: result.at,
    last: {
      at: result.at,
      uploaded: result.uploaded,
      skipped: result.skipped,
      failed: result.failed,
      bytes: result.bytes,
      error: result.error
    }
  })
  return result
}

async function runTask(id, opts) {
  const task = list().find((t) => t.id === id)
  if (!task) throw new Error('上传任务不存在')
  return runOne(task, opts)
}

// 下载完成：只传刚下完的那一个文件，没完成的文件根本不会走到这里
async function autoAfterDownload(subKey, file, opts) {
  if (!subKey || !file) return []
  if (!ug.hasSession()) return []
  const targets = tasksForKey(subKey).filter((t) => t.mode === 'auto')
  const out = []
  for (const t of targets) {
    try {
      out.push(await runOne(t, Object.assign({}, opts, { only: file })))
    } catch (err) {
      out.push({ failed: 1, error: String(err.message || err) })
    }
  }
  return out
}

// 启动时补一次全量自动同步，覆盖关闭程序期间漏掉的文件
async function autoAll(opts) {
  if (!ug.hasSession()) return []
  const out = []
  for (const t of list().filter((x) => x.mode === 'auto' && x.enabled)) {
    try {
      out.push(await runOne(t, opts))
    } catch (err) {
      out.push({ failed: 1, error: String(err.message || err) })
    }
  }
  return out
}

// 该订阅已上传到云端的文件名：只查它自己任务的目录，未登录或没有任务时返回空
async function uploadedNames(subKey) {
  const names = new Set()
  const tasks = tasksForKey(subKey)
  if (!tasks.length || !ug.hasSession()) return names
  for (const dest of new Set(tasks.map((t) => t.dest))) {
    try {
      const r = await ug.listDir(dest)
      for (const f of r.files || []) names.add(f.name)
    } catch (_) { /* 目录暂时不可用就当没上传过，不影响本地比对 */ }
  }
  return names
}

module.exports = {
  list, save, remove, updateTask, candidates, runTask, autoAfterDownload, autoAll, uploadedNames
}
