# Dreamcatcher

Windows 桌面视频下载器。Electron + 原生 HTML/CSS/JS，下载引擎是 yt-dlp + ffmpeg。

## 功能

- **资源获取**：粘贴链接 → 解析标题/封面/画质 → 下载，带进度、取消、任务历史、日志
- **Hanime1.me**：支持观看页链接，解析标题/封面/标签与 1080p/720p/480p 画质，默认最高画质；用 yt-dlp 下载解析出的直链
- **UP 主资源获取**：粘贴 B 站 UP 主空间链接，列出全部视频（封面/标题/上传时间/时长），支持按充电状态、上传月份、视频时长筛选；抓取时实时显示进度与已获取数量；勾选后批量加入下载队列；暂不支持 YouTube
- **订阅**：保存 B 站 UP 主订阅，添加或检查更新时自动拉取网页清单，按文件名中的 BV 号与下载目录比对；列出已下载/待下载清单，默认勾选待下载，确认后批量下载；下载完成自动重扫本地更新比对状态
- **下载命名**：文件名自动加 `UP名_上传日期_` 前缀，资源管理列表仍只显示原视频名
- **任务列表**：顶栏入口，旁边实时显示当前下载总速度；数量徽标只统计下载中/待下载任务，任务显示百分比进度和总体进度，可清除已完成记录；弹窗按队列顺序从上到下展示，历史记录独立在下方
- **软件更新**：启动时后台检查 GitHub，设置 → 更新可手动检查和安装；下载 `app.asar` 校验 sha256 后替换并自动重启，GitHub raw + jsDelivr 兜底
- **视频标签**：解析时显示 B 站/YouTube/Hanime 标签，下载完成后自动拉取并保存到 `data\tags.json`；资源管理按行展示标签，并提供「一键打标」给未打标文件补标签。一键打标只处理文件名中带 BVID / YouTube ID / Hanime 数字 ID 的文件，无法识别来源的会跳过
- **资源管理**：扫描下载目录（视频 + 音频），查看大小/时间/标签，打开位置，删除到回收站
- **设置**：下载目录、账号管理（B 站登录）、网络代理、最大并行下载/下载限速、更新（软件更新/下载引擎）
- 应用内置 B 站登录窗口，登录态持久化到程序目录 `data\`
- 下载后自动校验时长，识别「试看片段」；充电专属视频提前提示
- 任务队列并发可配置（默认 2）；限速单位 KB/s，留空不限；代理跟随系统/直连/自定义；B 站固定直连

## 启动

双击 **`Dreamcatcher.exe`**（启动器）。它会带上 `--no-sandbox` 启动真正的
`DreamcatcherApp.exe`——本机 Chromium 沙箱初始化会崩溃，必须这样启动。

首次运行 SmartScreen 可能拦截，点「更多信息 → 仍要运行」。

> 不要双击 `DreamcatcherApp.exe`，它需要启动器补的参数。

## 数据位置

- 登录态 / 缓存 / 日志：`程序目录\data\`
- 下载文件：默认 `程序目录\downloads\`，可在「设置 → 下载目录」修改

`data\` 保存着登录 Cookie，删掉就要重新扫码。

## 开发

```bash
npm install
npm start                        # 开发模式
npm run build:launcher           # 重新编译启动器（改了 launcher.cs 后）
npm test                         # 单元测试
npm run pack                     # 免安装目录（打包后自动修正 exe 完整性标签）
npm run pack:zip                 # 便携 zip（同上）
```

需要自备 `bin/yt-dlp.exe` 与 `bin/ffmpeg.exe`：

- yt-dlp: https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
- ffmpeg: https://www.gyan.dev/ffmpeg/builds/ （取 `bin/ffmpeg.exe`）

## 工作原理

```
renderer (无 Node 权限) ──IPC──> main
                                  ├─ auth.js       登录窗口 + Cookie 导出（Netscape）
                                  ├─ downloader.js yt-dlp 子进程 / 进度 / 时长探测 / JS 运行时
                                  ├─ bilibili.js   UP 主空间列表（WBI 签名 / 分页 / 封面时长）
                                  ├─ subscription.js 订阅与本地 BV 号比对
                                  ├─ hanime.js     Hanime 页面/画质/标签解析
                                  ├─ tags.js       B 站/YouTube/Hanime 标签抓取
                                  ├─ proxy.js      PAC 结果解析
                                  └─ store.js      设置与任务历史
```

- 登录：`persist:auth:bilibili` 分区扫码，Cookie 存 `data\Partitions\...`，
  退出时 `flushStore()` 刷盘；下载时导出临时文件交给 `yt-dlp --cookies`，用完即删。
- 必须全量导出（`SESSDATA`、`bili_jct`、`buvid3` 等），少一个都可能被风控。
- 无权益时 B 站会返回 3 分钟试看流且**不报错**，所以下载后会用 ffmpeg 读时长比对。
- YouTube 需要 JS 运行时，应用把 Electron 自带的 Node 交给 yt-dlp（`--js-runtimes node:<自身>`），
  不用额外装 Deno。

## 常见问题

**双击 Dreamcatcher.exe 弹「Windows 已保护你的电脑」**
没有代码签名。点「更多信息 → 仍要运行」。

**点「打开目录 / 位置」提示无法访问，或没反应**
应用已改为直接 `CreateProcess` 拉起 `explorer.exe`（绕过 ShellExecuteEx 的权限弹窗），
并且不再把 explorer 正常的退出码 1 当成失败，带空格的文件名也会正确 `/select`。
若仍提示无法打开：程序目录可能带「低完整性（Low）」标签（DSH `workspace-write` 沙箱
会故意给工作区打这个标签）——从该目录启动的 Electron 也是 Low，Low 进程无法启动资源
管理器。`npm run pack` / `pack:zip` 已自动调用 `scripts/relabel-exes.js` 修正应用 exe
以及 `resources/bin` 下 yt-dlp/ffmpeg 的标签；若打包是在沙箱内跑的，从普通终端再执行一次
`node scripts/relabel-exes.js`，或用管理员运行 `fix-integrity.cmd`。
不建议把整个工作区改回 Medium：下一次 `workspace-write` 会话会把工作区重新标回 Low，
而且会破坏沙箱对工作区的写入边界。

**下载报 Permission denied / Errno 13**
下载引擎（yt-dlp/ffmpeg）如果是从带 Low 完整性标签的工作区复制出来的，进程也会是 Low，
无法写入普通下载目录。应用会先把引擎复制到 `%LOCALAPPDATA%\Dreamcatcher\engine` 再运行；
更新到 v0.3.2 后重试即可。若仍失败，检查目标目录 ACL 或安全软件是否拦截。

**解析/下载报 EPERM**
配置目录不可写。应用会自动退到程序目录下的 `data\`、`downloads\`；若仍失败，
检查安全软件是否拦截了该目录。

**下载成功但只有几分钟**
多半没有该视频的权益（充电专属/大会员）。日志和任务条会标「时长校验未通过」。

**YouTube 偶发 403**
YouTube 反爬波动，重试即可；B 站不受影响。

## 合规

仅用于下载你本人有权访问的内容，供个人离线观看；不做二次分发，不内置账号，
不实现任何 DRM 绕过。
