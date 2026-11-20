'use strict'
const fs = require('fs')
const path = require('path')

// 本地是否已下载，以文件名里的 [BV号] 为准；音频也算已下载
const MEDIA_EXT = new Set([
  '.mp4', '.mkv', '.webm', '.flv', '.mov', '.ts', '.m4v',
  '.m4a', '.mp3', '.aac', '.flac', '.wav', '.ogg'
])
const BVID_RE = /\[(BV[0-9A-Za-z]{10})\]/

function bvidFromFilename(name) {
  const m = BVID_RE.exec(String(name || ''))
  return m ? m[1] : ''
}

// 递归扫描下载目录，分别返回 B 站 BV 号、Hanime 数字 ID → 本地文件路径
async function scanLocalMedia(root) {
  const bilibili = new Map()
  const hanime = new Map()
  async function walk(dir, depth) {
    if (depth > 6) return
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
      if (!MEDIA_EXT.has(path.extname(ent.name).toLowerCase())) continue
      const bvid = bvidFromFilename(ent.name)
      if (bvid) {
        if (!bilibili.has(bvid)) bilibili.set(bvid, full)
        continue
      }
      const hm = /\[(\d{4,10})\]/.exec(ent.name)
      if (hm && !hanime.has(hm[1])) hanime.set(hm[1], full)
    }
  }
  await walk(root, 0)
  return { bilibili, hanime }
}

async function scanLocalBvids(root) {
  return (await scanLocalMedia(root)).bilibili
}

// B 站订阅的视频类型过滤；Hanime 没有普通/充电之分
function filterVideos(videos, filter) {
  const list = videos || []
  if (filter === 'normal') return list.filter((v) => !v.charging)
  if (filter === 'charging') return list.filter((v) => v.charging)
  return list
}

// 网页清单 + 本地文件 → 比对清单；已下载的默认不勾选，但仍允许手动勾选重下
function buildComparison(videos, localMap) {
  const list = (videos || []).map((v) => Object.assign({}, v, {
    downloaded: localMap.has(v.id),
    localPath: localMap.get(v.id) || '',
    selected: !localMap.has(v.id)
  }))
  const downloaded = list.filter((v) => v.downloaded).length
  return { videos: list, downloaded, missing: list.length - downloaded }
}

module.exports = { bvidFromFilename, scanLocalMedia, scanLocalBvids, filterVideos, buildComparison }
