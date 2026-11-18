'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const auth = require('../main/auth')
const dl = require('../main/downloader')

const BILI = 'https://www.bilibili.com/video/BV1xx411c7mD/'

test('formatCookies: HttpOnly 与 session cookie 写法正确', () => {
  const out = auth.formatCookies([
    { domain: '.bilibili.com', path: '/', secure: true, httpOnly: true, expirationDate: 1800000000.5, name: 'SESSDATA', value: 'abc%2C123' },
    { domain: '.bilibili.com', path: '/', secure: false, httpOnly: false, expirationDate: 0, name: 'buvid3', value: 'xyz' }
  ])
  const lines = out.split('\n')
  assert.strictEqual(lines[0], '# Netscape HTTP Cookie File')
  assert.ok(
    lines.includes(['#HttpOnly_.bilibili.com', 'TRUE', '/', 'TRUE', '1800000000', 'SESSDATA', 'abc%2C123'].join('\t')),
    'SESSDATA 行格式不对: ' + out
  )
  assert.ok(
    lines.includes(['.bilibili.com', 'TRUE', '/', 'FALSE', '0', 'buvid3', 'xyz'].join('\t')),
    'session cookie 行格式不对'
  )
  assert.ok(out.endsWith('\n'))
})

test('formatCookies: 空列表也能生成合法文件头', () => {
  const out = auth.formatCookies([])
  assert.match(out, /^# Netscape HTTP Cookie File/)
})

test('buildDownloadArgs: 参数齐全且 URL 在最后', () => {
  const outDir = path.join('D:', 'Dreamcatcher', 'downloads')
  const args = dl.buildDownloadArgs({ url: BILI, outDir, cookieFile: 'C:\\tmp\\c.txt', format: 'bv*[height<=1080]+ba/b[height<=1080]' })
  assert.strictEqual(args[args.length - 1], BILI)
  assert.ok(args.includes('--cookies'))
  assert.strictEqual(args[args.indexOf('--cookies') + 1], 'C:\\tmp\\c.txt')
  assert.ok(args.includes('--progress-template'))
  assert.ok(args.includes('--progress'), '缺少 --progress，--print 的 quiet 模式会吞掉进度')
  assert.ok(args.includes('--print'))
  assert.ok(args.includes('--merge-output-format'))
  assert.strictEqual(args[args.indexOf('-f') + 1], 'bv*[height<=1080]+ba/b[height<=1080]')
  const o = args[args.indexOf('-o') + 1]
  assert.ok(o.startsWith(outDir), '输出目录没带上: ' + o)
  assert.ok(o.includes('%(uploader)s_%(upload_date>%Y-%m-%d)s_%(title)s'), '缺少 UP 名+上传日期前缀: ' + o)
  assert.ok(o.includes('%(title)s'))
  assert.ok(!args.includes('--proxy'))
})

test('buildDownloadArgs: 有代理时追加 --proxy', () => {
  const args = dl.buildDownloadArgs({ url: BILI, outDir: 'D:\\out', proxy: 'socks5://127.0.0.1:7891' })
  assert.strictEqual(args[args.indexOf('--proxy') + 1], 'socks5://127.0.0.1:7891')
  assert.strictEqual(args[args.length - 1], BILI)
})

test('parseProgress: 正常进度行', () => {
  const line = 'PROG:' + JSON.stringify({ downloaded_bytes: 50, total_bytes: 200, speed: 1024, eta: 3 })
  const p = dl.parseProgress(line)
  assert.strictEqual(p.percent, 25)
  assert.strictEqual(p.speed, 1024)
  assert.strictEqual(p.bytes, 50)
  assert.strictEqual(p.total, 200)
})

test('parseProgress: 用估算总量、坏行返回 null', () => {
  const p = dl.parseProgress('PROG:' + JSON.stringify({ downloaded_bytes: 10, total_bytes_estimate: 40 }))
  assert.strictEqual(p.percent, 25)
  assert.strictEqual(dl.parseProgress('PROG:{oops'), null)
  assert.strictEqual(dl.parseProgress('[download] 50%'), null)
})

test('buildProbeArgs: 带 cookie 与代理', () => {
  const args = dl.buildProbeArgs(BILI, { cookieFile: 'C:\\tmp\\c.txt', proxy: 'http://127.0.0.1:7890' })
  assert.strictEqual(args[0], '-J')
  assert.strictEqual(args[args.length - 1], BILI)
  assert.strictEqual(args[args.indexOf('--proxy') + 1], 'http://127.0.0.1:7890')
})

test('parsePacResult: 各种 PAC 结果', () => {
  const proxy = require('../main/proxy')
  assert.strictEqual(proxy.parsePacResult('DIRECT'), null)
  assert.strictEqual(proxy.parsePacResult(''), null)
  assert.strictEqual(proxy.parsePacResult('PROXY 127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.strictEqual(proxy.parsePacResult('HTTPS 10.0.0.2:443'), 'http://10.0.0.2:443')
  assert.strictEqual(proxy.parsePacResult('SOCKS5 127.0.0.1:7891; DIRECT'), 'socks5://127.0.0.1:7891')
  assert.strictEqual(proxy.parsePacResult('SOCKS4 127.0.0.1:1080'), 'socks4://127.0.0.1:1080')
  assert.strictEqual(proxy.parsePacResult('garbage'), null)
})

test('store: 默认代理模式为 system', () => {
  const store = require('../main/store')
  assert.strictEqual(store.DEFAULTS.proxyMode, 'system')
  assert.strictEqual(store.DEFAULTS.concurrency, 2)
})
