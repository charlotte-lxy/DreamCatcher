'use strict'
const { spawn } = require('child_process')
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.join(__dirname, '..')
// 打包后 bin 通过 extraResources 放在 resources/bin，不能从 asar 里读可执行文件
const BIN_DIR = (() => {
  try {
    return app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(ROOT, 'bin')
  } catch (_) {
    return path.join(ROOT, 'bin')
  }
})()
const BIN = path.join(BIN_DIR, 'yt-dlp.exe')
const FFMPEG = path.join(BIN_DIR, 'ffmpeg.exe')

let cachedTmp = null
function ensureWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.wtest')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch (_) {
    return false
  }
}

// 纯函数模块也可能在没有 Electron 的环境下被 require，这里做降级；
// 配置目录不可写时（受限令牌/安全软件/重定向）退到系统临时目录，否则 Cookie 与缓存都写不出去
function tmpDir() {
  if (cachedTmp) return cachedTmp
  let base
  try {
    base = app.getPath('userData')
  } catch (_) {
    base = path.join(ROOT, '.tmp')
  }
  const candidates = [
    path.join(base, 'tmp'),
    // 便携目录：受限环境下往往只有程序所在目录可写
    path.join(path.dirname(process.execPath), 'tmp'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Dreamcatcher', 'tmp') : null,
    path.join(os.tmpdir(), 'dreamcatcher')
  ].filter(Boolean)
  for (const dir of candidates) {
    if (ensureWritable(dir)) {
      cachedTmp = dir
      return cachedTmp
    }
  }
  cachedTmp = os.tmpdir()
  return cachedTmp
}

function childEnv() {
  const t = tmpDir()
  return Object.assign({}, process.env, {
    TEMP: t,
    TMP: t,
    // yt-dlp 的 EJS 需要一个 JS 运行时；让 Electron 以 Node 模式充当，省去额外打包 deno
    ELECTRON_RUN_AS_NODE: '1'
  })
}

// YouTube 现在必须有 JS 运行时才能取到全部格式，否则会有 deprecation 警告且缺格式
function runtimeArgs() {
  return [
    '--js-runtimes', `node:${process.execPath}`,
    '--cache-dir', path.join(tmpDir(), 'yt-dlp-cache')
  ]
}

function ffmpegArgs() {
  return fs.existsSync(FFMPEG) ? ['--ffmpeg-location', FFMPEG] : []
}

function run(args, { onLine, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { windowsHide: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let outBuf = ''
    let errBuf = ''
    const handle = (buf, isErr) => {
      const text = buf.toString('utf8')
      if (isErr) stderr += text
      else stdout += text
      if (!onLine) return
      // yt-dlp 的进度 JSON 一行可能跨多个 pipe chunk，必须按行缓冲
      const combined = (isErr ? errBuf : outBuf) + text
      const parts = combined.split(/\r?\n/)
      const rest = parts.pop()
      if (isErr) errBuf = rest
      else outBuf = rest
      for (const line of parts) if (line.trim()) onLine(line, isErr)
    }
    child.stdout.on('data', (b) => handle(b, false))
    child.stderr.on('data', (b) => handle(b, true))
    child.on('error', reject)
    child.on('close', (code) => {
      if (onLine) {
        if (outBuf.trim()) onLine(outBuf, false)
        if (errBuf.trim()) onLine(errBuf, true)
      }
      resolve({ code, stdout, stderr })
    })
    if (onSpawn) onSpawn(child.pid)
  })
}

function buildProbeArgs(url, opts = {}) {
  const args = ['-J', '--no-playlist', '--no-progress', '--encoding', 'utf-8'].concat(ffmpegArgs(), runtimeArgs())
  if (opts.cookieFile) args.push('--cookies', opts.cookieFile)
  if (opts.proxy) args.push('--proxy', opts.proxy)
  args.push(url)
  return args
}

async function probe(url, opts = {}) {
  const res = await run(buildProbeArgs(url, opts))
  if (res.code !== 0) throw new Error(lastError(res.stderr) || `yt-dlp exit ${res.code}`)
  const warnings = res.stderr
    .split(/\r?\n/)
    .filter((l) => /WARNING/i.test(l))
    .map((l) => l.replace(/^.*?WARNING:\s*/i, '').trim())
  return { info: JSON.parse(res.stdout), warnings }
}

function buildDownloadArgs(o) {
  const args = [
    '--newline', '--no-colors', '--no-warnings', '--no-playlist',
    // --print 会隐式进入 quiet 模式，不加 --progress 就完全收不到进度行
    '--progress',
    '--windows-filenames', '--sleep-requests', '1', '--encoding', 'utf-8',
    '--force-overwrites',
    '--progress-template', 'download:PROG:%(progress)j',
    '--print', 'after_move:FILE:%(filepath)s',
    '-f', o.format || 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(o.outDir, '%(uploader)s', '%(uploader)s_%(upload_date>%Y-%m-%d)s_%(title)s [%(id)s].%(ext)s')
  ].concat(ffmpegArgs(), runtimeArgs())
  if (o.cookieFile) args.push('--cookies', o.cookieFile)
  if (o.proxy) args.push('--proxy', o.proxy)
  if (o.rateLimit) args.push('--limit-rate', `${Math.round(o.rateLimit)}K`)
  args.push(o.url)
  return args
}

// 把 yt-dlp 的进度行转成界面用的对象，无法解析时返回 null
function parseProgress(line) {
  if (!line.startsWith('PROG:')) return null
  try {
    const p = JSON.parse(line.slice(5))
    const total = p.total_bytes || p.total_bytes_estimate || 0
    const done = p.downloaded_bytes || 0
    return {
      percent: total ? Math.min(99.9, (done / total) * 100) : 0,
      speed: p.speed || 0,
      eta: p.eta || 0,
      bytes: done,
      total,
      filename: String(p.filename || ''),
      status: String(p.status || '')
    }
  } catch (_) {
    return null
  }
}

async function start(opts, onEvent) {
  fs.mkdirSync(opts.outDir, { recursive: true })
  const state = opts.state || { canceled: false }
  let file = null

  const phases = new Map()
  const onLine = (line) => {
    if (line.startsWith('FILE:')) {
      file = line.slice(5).trim()
      return onEvent({ type: 'file', file })
    }
    const prog = parseProgress(line)
    if (!prog) return
    // 视频/音频分两条流下载，按 filename 汇总，避免进度条在两条流之间来回跳
    const key = prog.filename || ('phase-' + phases.size)
    phases.set(key, { bytes: prog.bytes || 0, total: prog.total || 0 })
    let bytes = 0
    let total = 0
    for (const p of phases.values()) {
      bytes += p.bytes
      total += p.total
    }
    const percent = total ? Math.min(99.9, (bytes / total) * 100) : prog.percent
    onEvent(Object.assign({ type: 'progress' }, prog, { percent, bytes, total }))
  }

  const res = await run(buildDownloadArgs(opts), { onLine, onSpawn: (pid) => onEvent({ type: 'spawn', pid }) })
  if (state.canceled) return { canceled: true }
  if (res.code !== 0) throw new Error(lastError(res.stderr) || `yt-dlp exit ${res.code}`)
  return { file }
}

function lastError(stderr) {
  const lines = (stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const err = lines.filter((l) => /^ERROR/i.test(l)).pop()
  return err || lines.pop() || ''
}

function cancel(pid) {
  if (!pid) return
  spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
}

// 用 ffmpeg 读容器时长（ffmpeg -i 只打印信息、退出码非 0，属于正常现象）
function probeDuration(file) {
  return new Promise((resolve) => {
    if (!fs.existsSync(FFMPEG) || !fs.existsSync(file)) return resolve(0)
    const child = spawn(FFMPEG, ['-hide_banner', '-i', file], { windowsHide: true, env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (b) => { err += b.toString('utf8') })
    child.on('error', () => resolve(0))
    child.on('close', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err)
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0)
    })
  })
}

// 站点改动频繁时，更新 yt-dlp 往往就能修复解析失败
async function updateEngine() {
  const res = await run(['-U'])
  return { ok: res.code === 0, output: (res.stdout + res.stderr).trim() }
}

module.exports = { probe, start, cancel, probeDuration, updateEngine, buildDownloadArgs, buildProbeArgs, parseProgress, tmpDir, ensureWritable, ROOT }
