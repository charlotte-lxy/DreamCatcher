# Dreamcatcher —— 视频下载器 v1 开发计划

## 1. 目标与边界

**目标**：Windows 桌面应用，Electron + 原生 HTML/CSS/JS（无框架、无打包器）。
粘贴链接即可下载带登录态的视频（重点是 B 站充电视频、收藏夹内容），支持任务队列。

**已确认的决策**

| 项 | 选择 |
|---|---|
| 登录方式 | 应用内置登录窗口（独立 session 分区），Cookie 全量移交给 yt-dlp |
| 站点范围 | B 站（深度支持）+ yt-dlp 通用站点 |
| 技术栈 | 纯 JS + 原生 HTML/CSS，无 bundler、无 TypeScript |
| v1 功能 | 单链接下载 + 任务队列 |
| 代理 | 三分支配置 + 诊断工具（用户在用本地代理客户端，形态待实测确认） |

**v1 明确不做**：DRM 站点（Netflix/Widevine 等）、直播录制、弹幕/字幕、批量收藏夹、定时追更、多账号同时在线、YouTube 账号登录。

## 2. 为什么不用本地 Chrome

- Chrome 127+ 在 Windows 启用 App-Bound Encryption，第三方程序无法解密 Cookies 库
  （yt-dlp 报 `Failed to decrypt with DPAPI`，issue #10927）。
- Chrome 136 起 `--remote-debugging-port` 在默认用户数据目录下被忽略，必须配非标准
  `--user-data-dir`，即无法附加到你日常那份 Chrome。

结论：复用本地 Chrome 只剩"另开专用 profile 再登录一次"，收益不成立。
改为应用内登录，Cookie 从 Electron session 直接读，绕开一切解密问题。

## 3. 架构

```
renderer/index.html + style.css + app.js      ← 只负责 UI，无 fs / 无 spawn
        │  IPC（contextBridge 白名单）
preload/preload.js
        │
main/
  main.js        窗口与生命周期
  ipc.js         IPC 路由
  downloader.js  yt-dlp 子进程：拼参、解析进度、取消、重试
  auth.js        登录窗口、分区、登录态检测、Cookie 导出
  proxy.js       系统代理读取、代理诊断、按域名分流
  store.js       tasks.json / settings.json 原子读写
bin/             yt-dlp.exe、ffmpeg.exe（打包时 extraResources，不进 asar）
```

安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；
Cookie 与文件路径绝不回传渲染进程，只传展示所需字段。

## 4. 关键实现点

### 4.1 下载引擎
- `yt-dlp -J --no-playlist` 取元信息（标题/时长/封面/格式列表），预览与选画质都基于它。
- 下载：`-f bv*+ba/b --merge-output-format mp4 --ffmpeg-location bin/ffmpeg.exe`。
- 进度：`--newline --progress-template "download:%(progress)j"`，逐行解析 JSON。
- 完成路径：`--print after_move:filepath`。
- 取消：`taskkill /pid <pid> /T /F`（yt-dlp 会拉起 ffmpeg 子进程，必须杀进程树）。
- 输出模板：`-o "<下载目录>/%(uploader)s/%(title)s [%(id)s].%(ext)s"`，加 `--windows-filenames`。

### 4.2 登录与 Cookie 移交
- 登录窗口：`BrowserWindow` + `partition: 'persist:auth:bilibili'`，
  自定义 UA（去掉 Electron 标识）、代理跟随设置。
- 登录态检测：用该 session 请求 `https://api.bilibili.com/x/web-interface/nav`，
  `data.isLogin === true` 即成功，取 `uname` 显示在界面。
- Cookie 导出：`session.cookies.get({})` → 临时 Netscape 文件 → `--cookies` → `finally` 删除。
- **必须全量导出**：`SESSDATA`、`bili_jct`、`DedeUserID`、`buvid3`、`buvid4`、`b_nut`
  缺任一都可能触发 412 或反复验证。
- `persist:` 分区自身持久化登录态，重启应用无需重登。

### 4.3 代理
- 三档：直连 / 跟随系统 / 自定义（http、socks5）。
- 「跟随系统」：读 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
  的 `ProxyEnable` / `ProxyServer` 自动填充。
- 按域名分流（默认表两条）：`bilibili.com` → 直连；其余 → 代理。
  理由：B 站走境外代理既慢又容易触发风控。
- 作用范围必须三处一致：登录窗口 session、预览请求、yt-dlp `--proxy`。
- 「代理诊断」按钮输出：系统代理设置、常见本地端口（7890/7891/1080/10808/10809）探测、
  直连与代理两条路径访问 `api.bilibili.com` / `youtube.com` 的结果。
  用途：判定本地代理客户端是 TUN 还是系统代理。
- 若代理客户端是 TUN 全局：应用内选「直连」即可（系统层已接管），
  但此时 B 站也会走境外，需要在客户端切"规则/分流"模式，应用层无能为力——写进说明。

### 4.4 队列与持久化
- 并发上限 2，任务状态机：`queued → running → done / failed / canceled`。
- `tasks.json` 原子写入（写临时文件再 rename），启动时恢复未完成任务。
- 重试仅对 failed；已完成项记录 `--download-archive` 防重复。

## 5. 阶段与验收

| 阶段 | 内容 | 验收标准 | 估时 |
|---|---|---|---|
| 0 | 命令行 spike：登录 → 导 Cookie → yt-dlp 下 ①公开视频 ②大会员 1080P+ ③真实充电视频 | 文件可播放；充电视频**时长等于正片**（排除试看片段） | 0.5d |
| 1 | 骨架 + 单任务下载 + 元信息预览 + 进度 + 打开文件夹 | 公开视频下完，进度 0→100，exit code 0 | 1d |
| 2 | 登录窗口 + 登录态检测 + Cookie 移交 | 未登录下会员画质失败并提示；登录后成功；重启保持登录 | 1d |
| 3 | 代理三档 + 诊断 + 分流 | 三档各完成一次下载；诊断能判定代理客户端形态 | 0.5d |
| 4 | 队列、取消、重试、持久化 | 3 任务并发 2，进度独立；杀进程重启后状态正确 | 0.5d |
| 5 | electron-builder 打包 + yt-dlp 自更新 | 干净 Win11 安装即用，无需 Node/Python | 1d |

合计约 4.5–5 个工作日。

## 6. 风险

1. **B 站风控**（中）：全量 Cookie + UA 一致 + `--sleep-requests 1` 可大幅降低；
   阶段 0 若失败，回退到"手动粘贴单个视频链接"，暂不做空间页枚举。
2. **代理客户端形态未知**（中）：靠阶段 3 诊断结论定默认值，不猜。
3. **YouTube 账号态**（已知）：内嵌窗口被 Google 拒绝，v1 不支持，v2 补。
4. **打包体积/Defender 误报**（低）：ffmpeg 约 80MB；可换 LGPL 精简构建。

## 7. 合规

仅用于下载用户本人有权访问的内容，供个人离线观看；不做二次分发，不内置账号，
不实现任何 DRM 绕过。

## 8. 进展（2026-11-17）

已完成并验证（不含真实登录）：
- 主界面 + IPC + yt-dlp 子进程 + 进度解析 + 任务队列（并发 2 已验证）
- 内置登录窗口（独立分区）、Cookie 全量导出（Netscape，`#HttpOnly_` 前缀已用假 Cookie 验证读取成功）
- 代理三档 + bilibili 固定直连（日志确认 `proxy=direct`）；「测试连接」按钮实测直连 B 站 53ms、经系统代理访问 YouTube 1169ms
- 下载后时长校验（识别试看片段）
- 任务历史持久化（重启后仍显示；上次运行中的任务标记为「中断」）
- yt-dlp 自更新按钮（已验证）
- electron-builder 免安装包与便携 zip（`dist/win-unpacked`、`dist/Dreamcatcher-0.1.0-win.zip`，均已启动验证）

已修复的坑：
1. yt-dlp 输出中文文件名被按 UTF-8 解码成乱码 → 统一加 `--encoding utf-8`
2. 无权益时静默下载 3 分钟试看片段且不报错 → ffmpeg 读实际时长与原视频比对
3. 系统「下载」目录被重定向到外部盘且不可写 → 候选目录降级，启动不再崩
4. B 站流量被系统代理带出境→ bilibili 直连
5. 部分视频没有低分辨率格式导致 `-f` 报错 → 格式串追加兜底 `/bv*+ba/b`

阶段 0 已验证通过（2026-11-17，测试账号）：

- 日志：`cookie 导出 16 条 (含 SESSDATA)`
- 解析：可选 360/480/720/1080，`upowerExclusive=true`
- 成片：**1920×1080，时长 1517.24s（25:17），49MB，时长校验无警告**
- 打包版（`dist/win-unpacked/Dreamcatcher.exe`）用同一测试账号复测，结果一致

补充修复：yt-dlp 发现同名文件会直接跳过，把旧的试看文件当成下载结果 → 加 `--force-overwrites`。

补充修复（YouTube）：新版 yt-dlp 取 YouTube 必须带 JS 运行时，否则报
`No supported JavaScript runtime could be found` 且缺失部分格式。做法是把 Electron 自带的 Node
（`--js-runtimes node:<process.execPath>` + `ELECTRON_RUN_AS_NODE=1`）交给 yt-dlp，
不额外打包 Deno（省 40MB）。实测格式数 48 → 49，警告消失，打包版同样有效。

已知环境限制：NSIS 安装包无法在当前构建环境生成（electron-builder 需要执行生成的安装器来产出卸载程序，本环境禁止启动 GUI 安装器），改用 zip 分发；可在普通终端执行 `npx electron-builder --win nsis` 生成安装包。

补充修复（双击启动崩溃）：本机 Chromium 沙箱初始化失败，直接运行 `Dreamcatcher.exe` 会以 `0x80000003` 崩溃。
改为「启动器 + 真身」结构：`Dreamcatcher.exe`（C# 启动器，自动补 `--no-sandbox`）拉起 `DreamcatcherApp.exe`，
双击即可运行；同时 `store.write` 改为失败不抛异常，避免配置目录写入异常把启动流程一起带崩。

v1.1（2026-11-17 晚）：
- 界面重构：左侧主模块（资源获取 / 资源管理 / 设置）+ 子模块栏（设置：下载目录/账号管理/网络/维护；资源管理：全部/视频/音频）
- 新增资源管理：递归扫描下载目录、显示大小与时间、打开位置、删除到回收站
- 新增设置项：下载目录可选（默认 `程序目录\downloads`）、账号管理、网络、维护
- 登录态持久化：配置目录固定到 `程序目录\data`（原先 `%APPDATA%` 在该机器上不可写），退出前 `flushStore()`
- 已用自动化验证：模块切换、资源列表（5 个文件/85.2MB）、解析下载、打包版启动与落盘
