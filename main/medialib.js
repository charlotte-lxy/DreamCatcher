'use strict'
// 本地媒资索引：下载完成即登记「文件 → 订阅」，上传任务据此挑候选文件，
// 不必每次再去请求网页清单；清单缓存同样落在这里，供老文件兜底匹配。
const fs = require('fs')
const store = require('./store')

const INDEX = 'media-index.json'
const VIDEO_CACHE = 'sub-videos.json'
const MAX_ENTRIES = 20000

function readIndex() {
  const list = store.readAny(INDEX, [])
  return Array.isArray(list) ? list : []
}

function saveIndex(list) {
  store.write(INDEX, list.slice(0, MAX_ENTRIES))
}

// 下载完成时调用；文件已经不在磁盘上就当作没发生
function recordFile({ file, id, key }) {
  if (!file || !key) return null
  const full = String(file)
  let size = 0
  try {
    size = fs.statSync(full).size
  } catch (_) {
    return null
  }
  const list = readIndex().filter((e) => e.file !== full)
  list.unshift({ file: full, id: String(id || ''), key: String(key), size, at: Date.now() })
  saveIndex(list)
  return list[0]
}

function entriesForKey(key) {
  if (!key) return []
  const k = String(key)
  return readIndex().filter((e) => e.key === k)
}

function readVideos() {
  const v = store.readAny(VIDEO_CACHE, {})
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

// 检查订阅/更新汇总本来就已经拉到完整清单，顺手缓存下来
function saveVideoList(key, videos) {
  if (!key) return
  const cache = readVideos()
  const ids = []
  const titles = {}
  for (const v of videos || []) {
    const id = String((v && v.id) || '')
    if (!id) continue
    ids.push(id)
    titles[id] = String((v && v.title) || id)
  }
  cache[String(key)] = { at: Date.now(), ids, titles }
  store.write(VIDEO_CACHE, cache)
}

function videoCache(key) {
  const rec = readVideos()[String(key)]
  return rec && Array.isArray(rec.ids) ? rec : null
}

module.exports = { recordFile, entriesForKey, saveVideoList, videoCache }
