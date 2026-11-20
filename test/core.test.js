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
  assert.strictEqual(store.DEFAULTS.maxSpeed, 0)
})

test('bvidFromFilename: 只识别文件名中的完整 BV 号', () => {
  const sub = require('../main/subscription')
  assert.strictEqual(sub.bvidFromFilename('UP_2026-01-01_标题 [BV1xx411c7mD].mp4'), 'BV1xx411c7mD')
  assert.strictEqual(sub.bvidFromFilename('标题 BV1xx411c7mD.mp4'), '')
  assert.strictEqual(sub.bvidFromFilename('太短的 [BV123].mp4'), '')
  assert.strictEqual(sub.bvidFromFilename(''), '')
})

test('buildComparison: 已下载的默认不勾选', () => {
  const sub = require('../main/subscription')
  const videos = [
    { id: 'BV1xx411c7mD', title: '已下载' },
    { id: 'BV1yy411c7mE', title: '待下载' }
  ]
  const local = new Map([['BV1xx411c7mD', 'D:\\downloads\\UP\\已下载 [BV1xx411c7mD].mp4']])
  const cmp = sub.buildComparison(videos, local)
  assert.strictEqual(cmp.downloaded, 1)
  assert.strictEqual(cmp.missing, 1)
  assert.strictEqual(cmp.videos[0].downloaded, true)
  assert.strictEqual(cmp.videos[0].selected, false)
  assert.strictEqual(cmp.videos[0].localPath, 'D:\\downloads\\UP\\已下载 [BV1xx411c7mD].mp4')
  assert.strictEqual(cmp.videos[1].downloaded, false)
  assert.strictEqual(cmp.videos[1].selected, true)
})

test('scanLocalBvids: 递归扫描音视频，忽略非媒体与无 BV 号文件', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const sub = require('../main/subscription')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-subs-'))
  try {
    fs.mkdirSync(path.join(root, 'UP'), { recursive: true })
    fs.writeFileSync(path.join(root, 'UP', 'x_2026-01-01_标题 [BV1xx411c7mD].mp4'), '')
    fs.writeFileSync(path.join(root, 'UP', 'y [BV1yy411c7mE].m4a'), '')
    fs.writeFileSync(path.join(root, 'z [BV1zz411c7mF].txt'), '')
    fs.writeFileSync(path.join(root, 'artist_2026-01-01_标题 [409270].mp4'), '')
    fs.writeFileSync(path.join(root, 'no-id.mp4'), '')
    const map = await sub.scanLocalBvids(root)
    assert.strictEqual(map.size, 2)
    assert.ok(map.has('BV1xx411c7mD'))
    assert.ok(map.has('BV1yy411c7mE'))
    assert.ok(!map.has('BV1zz411c7mF'))
    const media = await sub.scanLocalMedia(root)
    assert.strictEqual(media.bilibili.size, 2)
    assert.ok(media.hanime.has('409270'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('filterVideos: B 站普通/充电/全部', () => {
  const sub = require('../main/subscription')
  const videos = [{ id: 'a', charging: false }, { id: 'b', charging: true }]
  assert.strictEqual(sub.filterVideos(videos, 'all').length, 2)
  assert.deepStrictEqual(sub.filterVideos(videos, 'normal').map((v) => v.id), ['a'])
  assert.deepStrictEqual(sub.filterVideos(videos, 'charging').map((v) => v.id), ['b'])
})

test('hanime: 播放清单/上传者卡片与订阅链接', () => {
  const hanime = require('../main/hanime')
  const html = `
    <div class="user-tab-item-wrapper">
      <div class="video-item-container" title="测试标题">
        <a href="https://hanime1.me/watch?v=123456" class="video-link">
          <img class="main-thumb" src="https://example.com/t.jpg">
          <div class="duration">01:02</div>
          <div class="title">测试标题</div>
        </a>
        <span class="subtitle-time">• 2個月前</span>
      </div>
    </div>`
  const list = hanime.parseListCards(html, 'artist')
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].id, '123456')
  assert.strictEqual(list[0].title, '测试标题')
  assert.strictEqual(list[0].duration, 62)
  assert.strictEqual(list[0].dateText, '2個月前')
  assert.deepStrictEqual(hanime.parseSubscriptionUrl('https://hanime1.me/playlist?list=985664&sort=latest'), {
    type: 'playlist', id: '985664', url: 'https://hanime1.me/playlist?list=985664&sort=latest'
  })
  assert.strictEqual(hanime.parseSubscriptionUrl('https://hanime1.me/user/367303').type, 'uploader')
})

test('signedSearchUrl: 充电专属参数参与 WBI 签名', () => {
  const bili = require('../main/bilibili')
  const url = bili.signedSearchUrl('123', 2, 'mixin', 'charging')
  assert.match(url, /[?&]special_type=charging/)
  assert.match(url, /[?&]w_rid=[0-9a-f]{32}/)
  assert.match(url, /[?&]pn=2/)
  const normal = bili.signedSearchUrl('123', 1, 'mixin')
  assert.ok(!normal.includes('special_type'), '默认列表不该带 special_type')
})

test('isChargingVideo: 合作视频不算充电，elec_arc_type 也算', () => {
  const bili = require('../main/bilibili')
  assert.strictEqual(bili.isChargingVideo({ is_charging_arc: true }), true)
  assert.strictEqual(bili.isChargingVideo({ is_union_video: true }), false)
  assert.strictEqual(bili.isChargingVideo({ elec_arc_type: 1 }), true)
  assert.strictEqual(bili.isChargingVideo({ elec_arc_type: 2 }), true)
  assert.strictEqual(bili.isChargingVideo({ elec_arc_type: 0 }), false)
})

test('listUpVideos: 默认列表与充电专属列表合并去重', async () => {
  const auth = require('../main/auth')
  const bili = require('../main/bilibili')
  const original = auth.getSession
  const calls = []
  const video = (id, created, charging) => ({
    bvid: id,
    title: '视频 ' + id,
    pic: '',
    length: '01:00',
    created,
    author: '测试 UP',
    is_charging_arc: charging
  })
  auth.getSession = () => ({
    fetch: async (url) => {
      calls.push(String(url))
      if (url.includes('/x/web-interface/nav')) {
        return { ok: true, json: async () => ({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/' + 'a'.repeat(32) + '.png', sub_url: 'https://i0.hdslb.com/' + 'b'.repeat(32) + '.png' } } }) }
      }
      const u = new URL(url)
      const special = u.searchParams.get('special_type')
      const pn = Number(u.searchParams.get('pn'))
      let body
      if (!special && pn === 1) {
        body = { code: 0, data: { page: { count: 2 }, list: { slist: [{ special_type: 'charging', count: 2 }], vlist: [video('BV1xx411c7mD', 1, false), video('BV1yy411c7mE', 2, true)] } } }
      } else if (special === 'charging' && pn === 1) {
        body = { code: 0, data: { page: { count: 2 }, list: { vlist: [video('BV1yy411c7mE', 2, true), video('BV1zz411c7mF', 3, true)] } } }
      } else {
        body = { code: 0, data: { page: { count: 2 }, list: { vlist: [] } } }
      }
      return { ok: true, json: async () => body }
    }
  })
  try {
    const r = await bili.listUpVideos('https://space.bilibili.com/123', () => {})
    assert.strictEqual(r.mid, '123')
    assert.strictEqual(r.videos.length, 3, '两个列表中的重复 BV 号应合并')
    assert.deepStrictEqual(r.videos.map((v) => v.id), ['BV1zz411c7mF', 'BV1yy411c7mE', 'BV1xx411c7mD'])
    assert.strictEqual(r.videos.find((v) => v.id === 'BV1yy411c7mE').charging, true)
    assert.ok(calls.some((u) => u.includes('special_type=charging')), '没有请求充电专属列表')
  } finally {
    auth.getSession = original
  }
})

test('hanime: 页面元数据、标签与多画质解析', () => {
  const hanime = require('../main/hanime')
  const html = `
    <meta property="og:title" content="[artist] Demo Title - Hanime1.me">
    <meta property="og:image" content="https://example.com/cover.jpg">
    <meta property="og:video:duration" content="42">
    <meta name="keywords" content="Tag A, Tag B, 1080p, 無碼">
    <a href="https://hanime1.me/user/123">artist</a>
    <a href="https://hanime1.me/search?genre=3DCG">3DCG</a>
    <div>2026-11-19</div>
    <source src="https://vdownload.hembed.com/123-720p.mp4?secure=x">
    <source src="https://vdownload.hembed.com/123-1080p.mp4?secure=y">
    <div>tags%5B%5D=1080p</div>
  `
  const info = hanime.parsePage(html, '123')
  assert.strictEqual(info.title, '[artist] Demo Title')
  assert.strictEqual(info.uploader, 'artist')
  assert.strictEqual(info.uploadDate, '2026-11-19')
  assert.strictEqual(info.duration, 42)
  assert.deepStrictEqual(info.formats.map((f) => f.height), [1080, 720])
  assert.deepStrictEqual(info.tags, ['Tag A', 'Tag B', '無碼', '3DCG'])
  assert.strictEqual(hanime.pickFormat(info.formats, 0).height, 1080)
  assert.strictEqual(hanime.pickFormat(info.formats, 720).height, 720)
  assert.ok(hanime.outputPath('D:\\out', info).endsWith('artist_2026-11-19_Demo Title [123].mp4'))
})

test('tags: 三站点链接与文件名识别', () => {
  const tags = require('../main/tags')
  assert.deepStrictEqual(tags.detectSite('https://www.bilibili.com/video/BV1kYsW6NE6E'), {
    site: 'bilibili', id: 'BV1kYsW6NE6E', url: 'https://www.bilibili.com/video/BV1kYsW6NE6E'
  })
  assert.strictEqual(tags.detectSite('https://youtu.be/dQw4w9WgXcQ').site, 'youtube')
  assert.strictEqual(tags.detectSite('https://www.youtube.com/shorts/dQw4w9WgXcQ').site, 'youtube')
  assert.strictEqual(tags.detectSite('https://hanime1.me/watch?v=409270').site, 'hanime')
  assert.strictEqual(tags.detectFilename('UP_2026-11-19_标题 [BV1kYsW6NE6E].mp4').site, 'bilibili')
  assert.strictEqual(tags.detectFilename('标题 [dQw4w9WgXcQ].mp4').site, 'youtube')
  assert.strictEqual(tags.detectFilename('artist_2026-11-19_Title [409270].mp4').site, 'hanime')
  assert.strictEqual(tags.detectFilename('没有编号.mp4'), null)
})

test('tags: YouTube keywords 解析', () => {
  const tags = require('../main/tags')
  assert.deepStrictEqual(tags.parseYouTubeKeywords('"keywords":["a","b","a"]'), ['a', 'b'])
  assert.deepStrictEqual(tags.parseYouTubeKeywords('<meta name="keywords" content="x, y, z">'), ['x', 'y', 'z'])
})

test('buildDownloadArgs: Hanime 直链使用固定输出且不选格式', () => {
  const args = dl.buildDownloadArgs({
    url: 'https://vdownload.hembed.com/409270-1080p.mp4?secure=x',
    direct: true,
    output: 'D:\\out\\artist\\file.mp4',
    outDir: 'D:\\out\\artist'
  })
  assert.strictEqual(args[args.indexOf('-o') + 1], 'D:\\out\\artist\\file.mp4')
  assert.ok(!args.includes('-f'), '直链不该再传 -f')
  assert.ok(!args.includes('--merge-output-format'), '直链不该再要求合并')
})

test('buildDownloadArgs: 限速参数', () => {
  const args = dl.buildDownloadArgs({ url: BILI, outDir: 'D:\\out', rateLimit: 512 })
  assert.strictEqual(args[args.indexOf('--limit-rate') + 1], '512K')
  const noLimit = dl.buildDownloadArgs({ url: BILI, outDir: 'D:\\out' })
  assert.ok(!noLimit.includes('--limit-rate'))
})
