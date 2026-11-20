#!/usr/bin/env node
// 绿联 NAS 文件上传 CLI（零依赖，走 NAS 官方 fileUploadV2 接口）
//
// 用法:
//   node scripts/ugnas-upload.mjs <本地文件或目录...> --dest <远端目录>
//                                 [--endpoint local|remote|<URL>] [--dry-run] [--no-skip]
//
// 配置: ~/.ugnas-upload.json
//   {
//     "username": "手机号",
//     "password": "密码",
//     "endpoint": "local",                        // 默认使用哪条链路
//     "local":  "http://192.168.31.9:9443",       // 局域网
//     "remote": "https://<设备>.cn66.ug.link"     // 公网中继
//   }
//
// 远端路径用 NAS 内部路径（/home/<用户名>/... ），不是 WebDAV 路径。

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { createPublicKey, publicEncrypt, constants, randomUUID } from 'node:crypto'

const CONFIG_PATH = join(homedir(), '.ugnas-upload.json')
const TOKEN_CACHE = join(homedir(), '.ugnas-upload.token.json')
const TOKEN_TTL_MS = 25 * 60 * 1000
const DEFAULT_CHUNK = 8 * 1024 * 1024

function die(msg) {
  console.error('错误: ' + msg)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { paths: [], dest: '', endpoint: '', dryRun: false, skip: true, chunk: DEFAULT_CHUNK }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dest') out.dest = argv[++i]
    else if (a === '--endpoint') out.endpoint = argv[++i]
    else if (a === '--chunk') out.chunk = Number(argv[++i]) * 1024 * 1024
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--no-skip') out.skip = false
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/ugnas-upload.mjs <文件或目录...> --dest <远端目录> [--endpoint local|remote|<URL>] [--dry-run] [--no-skip]')
      process.exit(0)
    } else if (a.startsWith('--')) die('未知参数 ' + a)
    else out.paths.push(a)
  }
  if (!out.paths.length) die('请给出要上传的本地路径')
  if (!out.dest) die('请用 --dest 指定远端目录，例如 /home/14759539177/backup')
  if (!out.dest.startsWith('/')) die('--dest 必须是绝对路径（以 / 开头）')
  return out
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    die('缺少配置文件 ' + CONFIG_PATH + '，需要 {"username","password","endpoint","local","remote"}')
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  if (!cfg.username || !cfg.password) die('配置文件缺少 username / password')
  return cfg
}

function resolveBase(cfg, override) {
  const pick = override || cfg.endpoint || 'local'
  if (/^https?:\/\//i.test(pick)) return pick.replace(/\/+$/, '')
  const url = cfg[pick]
  if (!url) die(`配置里没有 endpoint "${pick}" 的地址`)
  return String(url).replace(/\/+$/, '')
}

function loadTokenCache() {
  try {
    return JSON.parse(readFileSync(TOKEN_CACHE, 'utf8'))
  } catch {
    return {}
  }
}

function saveTokenCache(cache) {
  writeFileSync(TOKEN_CACHE, JSON.stringify(cache), { mode: 0o600 })
}

async function login(cfg, base) {
  const checkRes = await fetch(base + '/ugreen/v1/verify/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.username }),
  })
  const rsaB64 = checkRes.headers.get('x-rsa-token')
  if (!rsaB64) die('服务端没有返回 x-rsa-token（地址或版本不符）')

  const pem = Buffer.from(rsaB64, 'base64').toString('utf8')
  // 服务端 PEM 头部写的是 "RSA PUBLIC KEY"，但体内实际是 SPKI 结构，
  // 按 PEM 解析会报 wrong tag，所以取出 DER 后按两种结构依次尝试。
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
  let key = null
  for (const t of ['spki', 'pkcs1']) {
    try {
      key = createPublicKey({ key: der, format: 'der', type: t })
      break
    } catch {
      /* 换下一种结构 */
    }
  }
  if (!key) die('无法解析服务端返回的 RSA 公钥')
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(cfg.password, 'utf8'),
  ).toString('base64')

  const res = await fetch(base + '/ugreen/v1/verify/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: cfg.username,
      password: encrypted,
      keepalive: false,
      otp: false,
      is_simple: false,
    }),
  })
  const body = await res.json()
  if (body.code !== 200 || !body.data?.token) {
    die(`登录失败 code=${body.code} msg=${body.msg}`)
  }
  return body.data.token
}

async function getToken(cfg, base, force = false) {
  const cache = loadTokenCache()
  const hit = cache[base]
  if (!force && hit && Date.now() - hit.ts < TOKEN_TTL_MS) return hit.token
  const token = await login(cfg, base)
  cache[base] = { token, ts: Date.now() }
  saveTokenCache(cache)
  return token
}

// 所有业务接口都必须把 token 放 URL 查询参数，放请求头无效。
async function api(cfg, base, path, { method = 'GET', query = {}, body, token, retryAuth = true } = {}) {
  const tok = token || (await getToken(cfg, base))
  const url = new URL(base + path)
  url.searchParams.set('token', tok)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  const json = await res.json().catch(() => ({}))
  if ((json.code === 1010 || json.code === 1114) && retryAuth) {
    await getToken(cfg, base, true)
    return api(cfg, base, path, { method, query, body, retryAuth: false })
  }
  return json
}

async function ensureDir(cfg, base, path) {
  // 逐级创建，parent 不存在时服务端报 1365，所以从浅到深
  const parts = path.split('/').filter(Boolean)
  for (let i = 2; i <= parts.length; i++) {
    const p = '/' + parts.slice(0, i).join('/')
    const res = await api(cfg, base, '/ugreen/v1/filemgr/createFolder', {
      method: 'POST',
      body: { path: p, action_type: 1 },
    })
    const ok = res.code === 200 || res.code === 1365 || /exist/i.test(String(res.msg))
    if (!ok) die(`建目录 ${p} 失败: ${res.code} ${res.msg}`)
  }
}

async function listDir(cfg, base, path) {
  const res = await api(cfg, base, '/ugreen/v2/filemgr/getDirFileListV2', {
    method: 'POST',
    body: {
      limit: 500,
      page: 1,
      data_type: 2,
      left_no_page_show: false,
      left_count: 5500,
      show_dir: true,
      version: 1,
      path,
    },
  })
  if (res.code !== 200) die(`列目录 ${path} 失败: ${res.code} ${res.msg}`)
  return res.data?.right_files?.files || []
}

// 目录递归时保留相对结构：rel 形如 "子目录/文件.txt"
function collectFiles(input, root = resolve(input), prefix = '') {
  const st = statSync(input)
  if (st.isDirectory()) {
    const out = []
    for (const name of readdirSync(input)) {
      out.push(...collectFiles(join(input, name), root, prefix ? `${prefix}/${name}` : name))
    }
    return out
  }
  return [{ local: resolve(input), rel: prefix || basename(input), size: st.size, mtimeMs: st.mtimeMs }]
}

async function uploadOne(cfg, base, token, file, remoteDir, chunkSize) {
  const size = file.size
  const name = basename(file.rel)
  const uuid = randomUUID()
  const fd = openSync(file.local, 'r')
  const buf = Buffer.alloc(Math.min(chunkSize, Math.max(size, 1)))
  let sent = 0
  try {
    do {
      const want = Math.min(buf.length, size - sent)
      const got = readSync(fd, buf, 0, want, sent)
      const piece = buf.subarray(0, got)
      const ugParam = {
        uuid,
        file_name: encodeURIComponent(name),
        action_type: 1,
        size,
        current_size: piece.length,
        resume: true,
        dir: encodeURIComponent(remoteDir),
        change_time: Math.floor(file.mtimeMs / 1000),
        is_live_photo: false,
        first_request: false,
        begin_size: sent,
      }
      let res
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await fetch(`${base}/ugreen/v1/filemgr/fileUploadV2?token=${token}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
              'ug-param': JSON.stringify(ugParam),
            },
            body: piece,
          })
          res = await r.json()
          if (res.code === 200) break
        } catch (e) {
          res = { code: -1, msg: String(e.message || e) }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
      if (res.code !== 200) die(`上传 ${file.rel} 失败于 ${sent}+${piece.length}: ${res.code} ${res.msg || ''}`)
      sent += piece.length
      if (size > chunkSize) process.stdout.write(`  ${file.rel}  ${((sent / size) * 100).toFixed(0)}%\n`)
    } while (sent < size)
  } finally {
    closeSync(fd)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadConfig()
  const base = resolveBase(cfg, args.endpoint)

  const files = args.paths.flatMap((p) => collectFiles(resolve(p)))
  if (!files.length) die('没有可上传的文件')

  const total = files.reduce((n, f) => n + f.size, 0)
  console.log(`目标 ${base}${args.dest}`)
  console.log(`文件 ${files.length} 个，共 ${(total / 1048576).toFixed(1)} MB`)
  if (args.dryRun) {
    for (const f of files) console.log(`  ${f.rel}  ${f.size}`)
    return
  }

  const token = await getToken(cfg, base)
  const dirsReady = new Set()
  const listings = new Map()

  let done = 0
  let skipped = 0
  const started = Date.now()
  for (const f of files) {
    const slash = f.rel.lastIndexOf('/')
    const sub = slash >= 0 ? f.rel.slice(0, slash) : ''
    const remoteDir = sub ? `${args.dest.replace(/\/+$/, '')}/${sub}` : args.dest
    if (!dirsReady.has(remoteDir)) {
      await ensureDir(cfg, base, remoteDir)
      dirsReady.add(remoteDir)
    }
    if (args.skip) {
      if (!listings.has(remoteDir)) listings.set(remoteDir, await listDir(cfg, base, remoteDir))
      const hit = listings.get(remoteDir).find((i) => i.name === basename(f.rel) && i.file_type !== 1)
      if (hit && hit.size === f.size) {
        console.log(`SKIP  ${f.rel}（远端已存在同尺寸文件）`)
        skipped++
        continue
      }
    }
    const t0 = Date.now()
    await uploadOne(cfg, base, token, f, remoteDir, args.chunk)
    done++
    const secs = Math.max((Date.now() - t0) / 1000, 0.001)
    console.log(
      `OK    ${f.rel}  ${(f.size / 1048576).toFixed(1)} MB  ${(f.size / 1048576 / secs).toFixed(1)} MB/s`,
    )
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`完成: 上传 ${done} 个，跳过 ${skipped} 个，用时 ${elapsed}s`)
}

main().catch((e) => die(e?.stack || String(e)))
