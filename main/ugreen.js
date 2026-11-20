'use strict'
// 绿联 NAS 客户端：账号配置、RSA 登录、目录浏览与分块上传
const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')
const { safeStorage } = require('electron')
const store = require('./store')

const SESSION = 'ugreen-session.json'
const CHUNK = 8 * 1024 * 1024
// 服务端 token 有效期约 30 分钟，留点余量
const TOKEN_TTL = 20 * 60 * 1000

/* ---------------- 配置 ---------------- */

function rawAccounts() {
  return store.read('accounts.json', {})
}

function encrypt(plain) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(plain).toString('base64')
    }
  } catch (_) { /* 加密不可用时退化为明文，避免功能直接不可用 */ }
  return 'raw:' + plain
}

function decrypt(secret) {
  if (!secret) return ''
  if (secret.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(secret.slice(4), 'base64'))
    } catch (_) {
      return ''
    }
  }
  return secret.startsWith('raw:') ? secret.slice(4) : secret
}

function getConfig() {
  const ug = rawAccounts().ugreen || {}
  return {
    username: String(ug.username || ''),
    password: decrypt(ug.secret || ''),
    local: String(ug.local || ''),
    remote: String(ug.remote || ''),
    endpoint: ug.endpoint === 'remote' ? 'remote' : 'local'
  }
}

// 给渲染进程看的状态，绝不回传密码原文
function publicConfig() {
  const c = getConfig()
  return {
    username: c.username,
    local: c.local,
    remote: c.remote,
    endpoint: c.endpoint,
    hasPassword: !!c.password
  }
}

function saveConfig(patch) {
  const accounts = rawAccounts()
  const next = Object.assign({}, accounts.ugreen || {})
  if (typeof patch.username === 'string') next.username = patch.username.trim()
  if (typeof patch.local === 'string') next.local = patch.local.trim()
  if (typeof patch.remote === 'string') next.remote = patch.remote.trim()
  if (patch.endpoint === 'local' || patch.endpoint === 'remote') next.endpoint = patch.endpoint
  if (typeof patch.password === 'string' && patch.password) next.secret = encrypt(patch.password)
  accounts.ugreen = next
  store.write('accounts.json', accounts)
  clearSession()
  return publicConfig()
}

function baseUrl(cfg) {
  const c = cfg || getConfig()
  const url = c.endpoint === 'remote' ? c.remote : c.local
  if (!url) throw new Error(c.endpoint === 'remote' ? '还没有填写绿联云远程地址' : '还没有填写绿联云局域网地址')
  return url.replace(/\/+$/, '')
}

/* ---------------- 会话 ---------------- */

let tokenCache = null

function readSession() {
  if (!tokenCache) tokenCache = store.read(SESSION, { base: '', token: '', ts: 0 })
  return tokenCache
}

function writeSession(v) {
  tokenCache = v
  store.write(SESSION, v)
}

function clearSession() {
  tokenCache = { base: '', token: '', ts: 0 }
  store.write(SESSION, tokenCache)
}

// 只检查本地缓存的 token，不发请求：用于自动同步前的静默判断
function hasSession() {
  const s = readSession()
  return !!(s.token && Date.now() - s.ts < TOKEN_TTL)
}

/* ---------------- HTTP ---------------- */

// 局域网地址是 IP + 自签证书，只对 IP 主机放宽证书校验
function isIpHost(host) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^\[/.test(host)
}

function netErrText(err) {
  const code = (err && err.code) || ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败，检查远程地址是否填写正确'
  if (code === 'ECONNREFUSED') return '连接被拒绝，检查 NAS 是否开启该端口'
  if (code === 'ETIMEDOUT') return '连接超时，检查网络或 NAS 是否在线'
  if (code === 'CERT_HAS_EXPIRED') return '证书已过期'
  return String((err && err.message) || err)
}

function request(urlStr, { method = 'GET', headers = {}, body, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(urlStr)
    } catch (_) {
      return reject(new Error('地址格式不对：' + urlStr))
    }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        timeout,
        agent: new https.Agent({ rejectUnauthorized: !isIpHost(u.hostname), keepAlive: false })
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      }
    )
    req.on('timeout', () => req.destroy(new Error('连接超时，检查地址和网络')))
    req.on('error', (err) => reject(new Error(netErrText(err))))
    if (body) req.write(body)
    req.end()
  })
}

function parseJson(res, what) {
  try {
    return JSON.parse(res.body.toString('utf8'))
  } catch (_) {
    throw new Error(`${what} 返回的不是 JSON（HTTP ${res.status}）`)
  }
}

async function postJson(url, obj) {
  const body = Buffer.from(JSON.stringify(obj || {}), 'utf8')
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    body
  })
  return res
}

/* ---------------- 登录 ---------------- */

async function login(cfg) {
  const c = cfg || getConfig()
  if (!c.username || !c.password) throw new Error('还没有填写绿联云账号或密码')
  const base = baseUrl(c)

  const check = await postJson(base + '/ugreen/v1/verify/check', { username: c.username })
  const rsaB64 = check.headers['x-rsa-token']
  if (!rsaB64) throw new Error('服务端没有返回公钥，可能不是绿联 NAS 的地址')

  // 服务端的 PEM 头写的是 RSA PUBLIC KEY，但体内是 SPKI 结构，按 DER 依次尝试更稳
  const pem = Buffer.from(rsaB64, 'base64').toString('utf8')
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
  let key = null
  for (const type of ['spki', 'pkcs1']) {
    try {
      key = crypto.createPublicKey({ key: der, format: 'der', type })
      break
    } catch (_) { /* 换下一种结构 */ }
  }
  if (!key) throw new Error('无法解析服务端返回的公钥')

  const encrypted = crypto
    .publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(c.password, 'utf8'))
    .toString('base64')

  const res = await postJson(base + '/ugreen/v1/verify/login', {
    username: c.username,
    password: encrypted,
    keepalive: false,
    otp: false,
    is_simple: false
  })
  const body = parseJson(res, '登录')
  if (body.code !== 200 || !body.data || !body.data.token) throw new Error(loginErrorText(body))
  writeSession({ base, token: body.data.token, ts: Date.now() })
  return body.data.token
}

function loginErrorText(body) {
  const code = body && body.code
  const msg = String((body && body.msg) || '')
  if (code === 1201 || /password/i.test(msg)) return '账号或密码不正确'
  if (code === 1010 || /token/i.test(msg)) return '登录失败：' + (msg || '凭证无效')
  return `登录失败：${msg || '未知错误'}${code ? `（${code}）` : ''}`
}

async function ensureToken(cfg, force) {
  const c = cfg || getConfig()
  const base = baseUrl(c)
  const sess = readSession()
  if (!force && sess.token && sess.base === base && Date.now() - sess.ts < TOKEN_TTL) return sess.token
  return login(c)
}

async function test(force) {
  const c = getConfig()
  const head = { username: c.username, endpoint: c.endpoint }
  if (!c.username || !c.password) return Object.assign({ ok: false, error: '还没有填写绿联云账号或密码' }, head)
  try {
    await ensureToken(c, force)
    return Object.assign({ ok: true }, head)
  } catch (err) {
    return Object.assign({ ok: false, error: String(err.message || err) }, head)
  }
}

/* ---------------- 业务接口 ---------------- */

// 业务接口只认 URL 查询参数里的 token，放请求头会报 1010 Token cannot be empty
async function api(cfg, apiPath, { method = 'GET', query = {}, body, retry = true } = {}) {
  const c = cfg || getConfig()
  const token = await ensureToken(c)
  const u = new URL(baseUrl(c) + apiPath)
  u.searchParams.set('token', token)
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v))

  const res = body !== undefined
    ? await postJson(u.toString(), body)
    : await request(u.toString(), { method })
  const json = parseJson(res, apiPath)
  if (retry && (json.code === 1010 || json.code === 1114)) {
    clearSession()
    return api(c, apiPath, { method, query, body, retry: false })
  }
  return json
}

function checkOk(json, what) {
  if (json.code !== 200) {
    throw new Error(`${what}失败：${json.msg || '未知错误'}${json.code ? `（${json.code}）` : ''}`)
  }
  return json
}

async function listDir(dirPath) {
  const json = checkOk(
    await api(null, '/ugreen/v2/filemgr/getDirFileListV2', {
      method: 'POST',
      body: {
        limit: 500,
        page: 1,
        data_type: 2,
        left_no_page_show: false,
        left_count: 5500,
        show_dir: true,
        version: 1,
        path: dirPath
      }
    }),
    '读取目录'
  )
  const list = (json.data && json.data.right_files && json.data.right_files.files) || []
  const dirs = []
  const files = []
  for (const f of list) {
    if (f.file_type === 1) dirs.push({ name: f.name, path: f.path })
    else files.push({ name: f.name, path: f.path, size: Number(f.size) || 0 })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return { path: dirPath, dirs, files }
}

// 逐级创建，已存在不算失败
async function ensureDir(dirPath) {
  const parts = String(dirPath).split('/').filter(Boolean)
  for (let i = 2; i <= parts.length; i++) {
    const p = '/' + parts.slice(0, i).join('/')
    const json = await api(null, '/ugreen/v1/filemgr/createFolder', {
      method: 'POST',
      body: { path: p, action_type: 1 }
    })
    if (json.code !== 200 && json.code !== 1365 && !/exist/i.test(String(json.msg))) {
      throw new Error(`创建目录 ${p} 失败：${json.msg || json.code}`)
    }
  }
}

function uploadChunk(base, token, meta, piece) {
  return new Promise((resolve, reject) => {
    const ugParam = JSON.stringify({
      uuid: meta.uuid,
      file_name: encodeURIComponent(meta.name),
      action_type: 1,
      size: meta.size,
      current_size: piece.length,
      resume: true,
      dir: encodeURIComponent(meta.dir),
      change_time: meta.mtimeSec,
      is_live_photo: false,
      first_request: false,
      begin_size: meta.offset
    })
    const u = new URL(base + '/ugreen/v1/filemgr/fileUploadV2')
    u.searchParams.set('token', token)
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        timeout: 180000,
        agent: new https.Agent({ rejectUnauthorized: !isIpHost(u.hostname), keepAlive: false }),
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': piece.length,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(meta.name)}"`,
          'ug-param': ugParam
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (_) {
            reject(new Error(`上传响应异常（HTTP ${res.status}）`))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('上传超时')))
    req.on('error', (err) => reject(new Error(netErrText(err))))
    req.write(piece)
    req.end()
  })
}

// 按块上传单个文件；中途失败直接抛错，不静默重试以免产生重复文件
async function uploadFile(localPath, destDir, onProgress) {
  const cfg = getConfig()
  const base = baseUrl(cfg)
  const stat = fs.statSync(localPath)
  const name = path.basename(localPath)
  const token = await ensureToken(cfg)
  const meta = {
    uuid: crypto.randomUUID(),
    name,
    dir: destDir,
    size: stat.size,
    mtimeSec: Math.floor(stat.mtimeMs / 1000),
    offset: 0
  }

  if (stat.size === 0) {
    const empty = await uploadChunk(base, token, meta, Buffer.alloc(0))
    if (empty.code !== 200) throw new Error(`上传 ${name} 失败：${empty.msg || empty.code}`)
    if (onProgress) onProgress(0, 0)
    return 0
  }

  const fd = fs.openSync(localPath, 'r')
  let sent = 0
  try {
    while (sent < stat.size) {
      const want = Math.min(CHUNK, stat.size - sent)
      const buf = Buffer.allocUnsafe(want)
      fs.readSync(fd, buf, 0, want, sent)
      meta.offset = sent
      const res = await uploadChunk(base, token, meta, buf)
      if (res.code !== 200) throw new Error(`上传 ${name} 失败：${res.msg || res.code}`)
      sent += want
      if (onProgress) onProgress(sent, stat.size)
    }
  } finally {
    fs.closeSync(fd)
  }
  return sent
}

module.exports = {
  getConfig,
  publicConfig,
  saveConfig,
  clearSession,
  hasSession,
  test,
  listDir,
  ensureDir,
  uploadFile
}
