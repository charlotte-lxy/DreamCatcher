'use strict'
const { app, net } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const REPO = 'charlotte-lxy/DreamCatcher'
const BRANCH = 'main'
const MANIFEST = 'version.json'
const ASAR_REL = 'release/app.asar'
const TIMEOUT = 15000
const SOURCES = [
  { id: 'raw', base: `https://raw.githubusercontent.com/${REPO}/${BRANCH}` },
  { id: 'github', base: `https://github.com/${REPO}/raw/${BRANCH}` },
  { id: 'jsdelivr', base: `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}` },
  { id: 'api', api: `https://api.github.com/repos/${REPO}/contents/${MANIFEST}?ref=${BRANCH}` }
]

let lastState = null

function sources() {
  const custom = String(process.env.DC_UPDATE_BASE || '').trim().replace(/\/+$/, '')
  return custom ? [{ id: 'custom', base: custom }] : SOURCES
}

function compareVersion(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

async function request(url, kind) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  const headers = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  try {
    let res
    try {
      // Electron 的 net.fetch 会走系统代理，优先使用；no-store 避免 CDN/Chromium 旧缓存
      res = await net.fetch(url, { signal: ctrl.signal, cache: 'no-store', headers })
    } catch (_) {
      // 兜底：本机/直连网络下用 Node fetch
      res = await fetch(url, { signal: ctrl.signal, headers })
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (kind === 'buffer') return Buffer.from(await res.arrayBuffer())
    if (kind === 'json') return await res.json()
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchSource(src) {
  if (src.api) {
    const j = await request(`${src.api}&t=${Date.now()}`, 'json')
    if (!j || !j.content) throw new Error('GitHub API 清单为空')
    const text = Buffer.from(String(j.content).replace(/\s+/g, ''), 'base64').toString('utf8')
    const manifest = JSON.parse(text)
    if (!manifest || !manifest.version) throw new Error('version.json 缺少 version')
    return { manifest, base: null, source: src.id }
  }
  const text = await request(`${src.base}/${MANIFEST}?t=${Date.now()}`, 'text')
  const manifest = JSON.parse(text)
  if (!manifest || !manifest.version) throw new Error('version.json 缺少 version')
  return { manifest, base: src.base, source: src.id }
}

// 并行拉所有源并取最高版本：raw 正常时用 raw，某个 CDN 还缓存着旧版也不会把结果压回旧版
async function fetchManifest() {
  const results = await Promise.all(sources().map(async (src) => {
    try {
      return await fetchSource(src)
    } catch (err) {
      return { source: src.id, error: err }
    }
  }))
  const usable = results.filter((r) => r && r.manifest)
  if (!usable.length) {
    const detail = results.map((r) => `${r.source}:${r.error ? r.error.message : '未知错误'}`).join(' | ')
    throw new Error('无法获取更新信息：' + detail)
  }
  usable.sort((a, b) => compareVersion(b.manifest.version, a.manifest.version))
  return usable[0]
}

function publicState(st) {
  return {
    ok: true,
    localVersion: st.localVersion,
    remoteVersion: st.remoteVersion,
    updateAvailable: st.updateAvailable,
    notes: st.notes,
    source: st.source,
    checkedAt: st.checkedAt
  }
}

async function checkForUpdate() {
  const localVersion = app.getVersion()
  const { manifest, base, source } = await fetchManifest()
  const remoteVersion = String(manifest.version)
  const updateAvailable = compareVersion(remoteVersion, localVersion) > 0
  const releases = Array.isArray(manifest.releases) ? manifest.releases : []
  const notes = releases
    .filter((r) => r && r.version && compareVersion(r.version, localVersion) > 0 && compareVersion(r.version, remoteVersion) <= 0)
    .sort((a, b) => compareVersion(b.version, a.version))
    .map((r) => ({
      version: String(r.version),
      date: String(r.date || ''),
      items: Array.isArray(r.items) ? r.items.map(String) : []
    }))
  lastState = { localVersion, remoteVersion, updateAvailable, notes, source, checkedAt: Date.now(), manifest, base }
  return publicState(lastState)
}

function getState() {
  return lastState ? publicState(lastState) : null
}

function autoCheck(win, log) {
  const run = () => {
    checkForUpdate()
      .then((st) => {
        if (win && !win.isDestroyed()) win.webContents.send('update:checked', st)
        if (st.updateAvailable) log(`发现新版本 ${st.remoteVersion}（当前 ${st.localVersion}）`)
      })
      .catch((err) => log('检查更新失败: ' + err.message))
  }
  const start = () => setTimeout(run, 1500)
  if (win && win.webContents.isLoading()) win.webContents.once('did-finish-load', start)
  else start()
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function writeHelper(pid) {
  const appDir = path.dirname(process.execPath)
  const helperPath = path.join(appDir, 'apply-update.vbs')
  const lines = [
    'Option Explicit',
    'Dim fso, sh, appDir, asarPath, newPath, bakPath, pid, i, replaced',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    'appDir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'asarPath = appDir & "\\resources\\app.asar"',
    'newPath = appDir & "\\resources\\app.asar.new"',
    'bakPath = appDir & "\\resources\\app.asar.bak"',
    `pid = ${Number(pid) || 0}`,
    'For i = 0 To 120',
    '  If Not ProcessExists(pid) Then Exit For',
    '  WScript.Sleep 500',
    'Next',
    'If ProcessExists(pid) Then WScript.Quit',
    'replaced = False',
    'For i = 0 To 20',
    '  On Error Resume Next',
    '  fso.CopyFile asarPath, bakPath, True',
    '  Err.Clear',
    '  fso.CopyFile newPath, asarPath, True',
    '  If Err.Number = 0 Then',
    '    replaced = True',
    '    On Error GoTo 0',
    '    Exit For',
    '  End If',
    '  Err.Clear',
    '  On Error GoTo 0',
    '  WScript.Sleep 500',
    'Next',
    'If replaced Then',
    '  On Error Resume Next',
    '  fso.DeleteFile newPath, True',
    '  On Error GoTo 0',
    'End If',
    'sh.Run """" & appDir & "\\Dreamcatcher.exe""", 1, False',
    'On Error Resume Next',
    'fso.DeleteFile WScript.ScriptFullName, True',
    'Function ProcessExists(p)',
    '  Dim svc, col',
    '  ProcessExists = False',
    '  On Error Resume Next',
    '  Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")',
    '  Set col = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & p)',
    '  If Not col Is Nothing Then ProcessExists = (col.Count > 0)',
    '  On Error GoTo 0',
    'End Function'
  ]
  fs.writeFileSync(helperPath, lines.join('\r\n') + '\r\n', 'utf8')
  return helperPath
}

async function installUpdate() {
  if (!app.isPackaged) throw new Error('开发模式不支持自动更新，请使用打包版')
  if (!lastState || !lastState.updateAvailable) await checkForUpdate()
  if (!lastState || !lastState.updateAvailable) throw new Error('当前已是最新版本')

  const manifest = lastState.manifest
  const relPath = String(manifest.asar || ASAR_REL).replace(/^\/+/, '')
  if (relPath.includes('..')) throw new Error('更新清单路径不合法')
  const expected = String(manifest.sha256 || '').trim().toLowerCase()
  if (!expected) throw new Error('更新清单缺少 sha256，已取消下载')

  const bases = [lastState.base, ...sources().map((s) => s.base)]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
  let buf = null
  let lastErr = null
  for (const base of bases) {
    try {
      const data = await request(`${base}/${relPath}?t=${Date.now()}`, 'buffer')
      if (sha256(data) !== expected) throw new Error('更新包 sha256 校验失败')
      buf = data
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!buf) throw new Error('更新包下载失败：' + (lastErr ? lastErr.message : '网络错误'))

  const asarPath = path.join(process.resourcesPath, 'app.asar')
  const newPath = asarPath + '.new'
  fs.writeFileSync(newPath, buf)
  const helperPath = writeHelper(process.pid)
  spawn('wscript.exe', [helperPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  setTimeout(() => {
    try { app.quit() } catch (_) { /* ignore */ }
    // app.quit 会触发 cookie flush，若被卡住则强制结束，避免更新器一直等 PID
    setTimeout(() => { try { app.exit(0) } catch (_) { /* ignore */ } }, 1500)
  }, 300)
  return { ok: true, version: lastState.remoteVersion }
}

module.exports = { checkForUpdate, getState, autoCheck, installUpdate }
