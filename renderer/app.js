'use strict'
const $ = (id) => document.getElementById(id)
const tasks = new Map()
const taskSpeeds = new Map()
let currentMeta = null
let settingsCache = {}
let currentModule = 'acquire'
const currentSub = { acquire: 'single', library: 'all', settings: 'download' }

/* ---------------- 通用 ---------------- */
function fmtDuration(sec) {
  if (!sec) return '未知时长'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(r).padStart(2, '0')}`
}

function fmtSpeed(bps) {
  if (!bps) return ''
  const mb = bps / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(2)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`
}

function fmtSize(bytes) {
  if (!bytes) return '0 B'
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

function fmtDate(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function cleanErr(msg) {
  return String(msg || '').replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

function humanizeError(msg) {
  const m = cleanErr(msg)
  if (/supporter-only/i.test(m)) return '该视频为充电专属，当前账号没有该 UP 主的充电权益（或尚未登录）'
  if (/login required|需要登录|sign in/i.test(m)) return '需要登录后才能访问这个视频'
  if (/-352|-799|412/.test(m)) return 'B 站风控拦截，请稍后重试或确认登录态'
  if (/-101/.test(m)) return '需要先登录 B 站'
  if (/EPERM|EACCES/i.test(m)) return '没有写入权限：配置目录或临时目录被拒绝访问，请换用户/关闭安全软件后重试'
  return m
}

/* ---------------- 模块与子模块 ---------------- */
const SUBBARS = {
  acquire: {
    title: '获取方式',
    items: [
      { id: 'single', label: '单资源获取' },
      { id: 'up', label: 'UP 主资源获取' }
    ]
  },
  library: {
    title: '分类',
    items: [
      { id: 'all', label: '全部' },
      { id: 'video', label: '视频' },
      { id: 'audio', label: '音频' }
    ]
  },
  settings: {
    title: '设置',
    items: [
      { id: 'download', label: '下载目录' },
      { id: 'account', label: '账号管理' },
      { id: 'network', label: '网络' },
      { id: 'update', label: '更新' }
    ]
  }
}
const MODULE_LABELS = { acquire: '资源获取', library: '资源管理', settings: '设置' }

function switchModule(name) {
  currentModule = name
  for (const btn of document.querySelectorAll('.rail-btn')) {
    btn.classList.toggle('active', btn.dataset.module === name)
  }
  for (const page of document.querySelectorAll('.page')) {
    page.classList.toggle('active', page.id === 'page-' + name)
  }
  const chip = $('topbarModule')
  if (chip) chip.textContent = MODULE_LABELS[name] || ''
  renderSubbar()
  onSubChange()
}

function renderSubbar() {
  const bar = $('subbar')
  const cfg = SUBBARS[currentModule]
  if (!cfg) {
    bar.classList.add('hidden')
    bar.innerHTML = ''
    return
  }
  bar.classList.remove('hidden')
  bar.innerHTML = ''
  const title = document.createElement('div')
  title.className = 'subbar-title'
  title.textContent = cfg.title
  bar.appendChild(title)
  for (const item of cfg.items) {
    const btn = document.createElement('button')
    btn.className = 'sub-btn' + (currentSub[currentModule] === item.id ? ' active' : '')
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      currentSub[currentModule] = item.id
      renderSubbar()
      onSubChange()
    })
    bar.appendChild(btn)
  }
}

function onSubChange() {
  if (currentModule === 'acquire') {
    for (const panel of document.querySelectorAll('#page-acquire .panel')) {
      panel.classList.toggle('hidden', panel.dataset.panel !== currentSub.acquire)
    }
  } else if (currentModule === 'settings') {
    for (const panel of document.querySelectorAll('#page-settings .panel')) {
      panel.classList.toggle('hidden', panel.dataset.panel !== currentSub.settings)
    }
    if (currentSub.settings === 'update') loadUpdateState()
  } else if (currentModule === 'library') {
    loadFiles(currentSub.library)
  }
}

/* ---------------- 账号 ---------------- */
async function refreshAuth() {
  try {
    const st = await window.api.authStatus()
    $('who').textContent = st.ok ? st.name : '未登录'
    $('loginBtn').textContent = st.ok ? '切换账号' : '登录 B 站'
    if (st.ok && st.face) {
      $('avatar').src = st.face
      $('avatar').classList.remove('hidden')
    } else {
      $('avatar').classList.add('hidden')
    }
  } catch (_) {
    $('who').textContent = '状态未知'
  }
}

/* ---------------- 资源获取 ---------------- */
function setStatus(text, ok) {
  const el = $('status')
  el.textContent = text || ''
  el.classList.toggle('ok', !!ok)
}

function buildFormats(meta) {
  const sel = $('format')
  sel.innerHTML = ''
  const heights = [...new Set(meta.formats.filter((f) => f.height).map((f) => f.height))].sort((a, b) => b - a)
  const add = (value, label) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    sel.appendChild(o)
  }
  add('best', '最佳画质')
  for (const h of heights) add(String(h), `${h}p`)
  add('audio', '仅音频')
}

function renderMeta(meta) {
  currentMeta = meta
  $('meta').classList.remove('hidden')
  $('cover').src = meta.thumbnail || ''
  $('title').textContent = meta.title || '(无标题)'
  $('sub').textContent = `${meta.uploader || '未知作者'} · ${fmtDuration(meta.duration)}`
  const warn = $('warn')
  const list = (meta.warnings || []).filter((w) => !/^\[bilibili\]/i.test(w) || /supporter|试看/i.test(w))
  if (meta.upowerExclusive) list.unshift('充电专属视频：账号需有该 UP 主的充电权益，否则只会下到试看片段（下载后会自动校验时长）')
  if (list.length) {
    warn.textContent = '⚠ ' + list.join('；')
    warn.classList.remove('hidden')
  } else {
    warn.classList.add('hidden')
  }
  buildFormats(meta)
}

function setTaskInfo(ref, text) {
  ref.info.textContent = text
}

function updateTaskBadge() {
  const n = tasks.size
  const badge = $('taskCount')
  badge.textContent = String(n)
  badge.classList.toggle('hidden', n === 0)
  $('taskSummary').textContent = n ? `${n} 个任务` : '暂无任务'
}

function updateTopbarStatus() {
  const running = [...tasks.values()].some((r) => !r.bar.classList.contains('done') && !r.bar.classList.contains('fail'))
  $('topbarStatusBox').classList.toggle('busy', running)
  $('topbarStatus').textContent = running ? '下载中' : '就绪'
}

function renderTaskSpeed() {
  let total = 0
  for (const bps of taskSpeeds.values()) total += bps
  const el = $('taskSpeed')
  if (total > 0) {
    el.textContent = '↓ ' + fmtSpeed(total)
    el.classList.remove('hidden')
  } else {
    el.textContent = ''
    el.classList.add('hidden')
  }
}

function markTaskDone(ref, res) {
  ref.live = false
  if (res.canceled) {
    ref.bar.classList.add('fail')
    ref.pct.textContent = '已取消'
    setTaskInfo(ref, '已取消')
    return
  }
  ref.bar.classList.add('done')
  ref.fill.style.width = '100%'
  ref.pct.textContent = '100%'
  ref.info.textContent = res.warning ? '已完成（⚠ ' + res.warning + '）' : '已完成'
  ref.btn.textContent = '打开'
  ref.btn.dataset.act = 'open'
  ref.btn.dataset.path = res.file || ''
}

function markTaskFailed(ref, err) {
  ref.live = false
  ref.bar.classList.add('fail')
  ref.fill.style.width = '100%'
  ref.pct.textContent = '失败'
  setTaskInfo(ref, '失败：' + humanizeError(err.message))
}

function openTaskModal() {
  $('taskModal').classList.remove('hidden')
  $('taskToggle').classList.add('active')
}

function closeTaskModal() {
  $('taskModal').classList.add('hidden')
  $('taskToggle').classList.remove('active')
}

async function clearTaskHistory() {
  if (!window.confirm('清除已完成的下载记录？进行中的任务不会受影响。')) return
  const btn = $('taskClear')
  btn.disabled = true
  try {
    await window.api.clearTasks()
    for (const [id, ref] of [...tasks.entries()]) {
      if (ref.live) continue
      ref.el.remove()
      tasks.delete(id)
    }
    const box = $('tasks')
    if (!box.querySelector('.task') && !box.querySelector('.empty')) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '还没有任务'
      box.appendChild(empty)
    }
    updateTaskBadge()
    updateTopbarStatus()
  } catch (err) {
    window.alert('清除失败：' + humanizeError(err.message))
  } finally {
    btn.disabled = false
  }
}

function addTask(id, title) {
  const box = $('tasks')
  const empty = box.querySelector('.empty')
  if (empty) empty.remove()

  const el = document.createElement('div')
  el.className = 'task'
  el.innerHTML = `
    <div class="task-head">
      <div class="task-title"></div>
      <span class="task-pct"></span>
      <button class="btn ghost small" data-act="cancel">取消</button>
    </div>
    <div class="bar"><i></i></div>
    <div class="task-info">排队中…</div>`
  el.querySelector('.task-title').textContent = title
  box.prepend(el)

  const ref = {
    el,
    bar: el.querySelector('.bar'),
    fill: el.querySelector('.bar > i'),
    info: el.querySelector('.task-info'),
    pct: el.querySelector('.task-pct'),
    btn: el.querySelector('[data-act]'),
    live: true
  }
  tasks.set(id, ref)
  updateTaskBadge()
  updateTopbarStatus()
  return ref
}

function renderHistoryItem(t) {
  const ref = addTask(t.id, t.title || t.url)
  ref.live = false
  if (t.status === 'done' && t.file) {
    ref.bar.classList.add('done')
    ref.fill.style.width = '100%'
    ref.pct.textContent = '100%'
    ref.info.textContent = t.warning ? '已完成（⚠ ' + t.warning + '）' : '已完成'
    ref.btn.textContent = '打开'
    ref.btn.dataset.act = 'open'
    ref.btn.dataset.path = t.file
  } else if (t.status === 'failed') {
    ref.bar.classList.add('fail')
    ref.fill.style.width = '100%'
    ref.pct.textContent = '失败'
    ref.info.textContent = '失败：' + humanizeError(t.error || '')
  } else if (t.status === 'canceled') {
    ref.bar.classList.add('fail')
    ref.pct.textContent = '已取消'
    ref.info.textContent = '已取消'
    ref.btn.textContent = '记录'
    ref.btn.disabled = true
  } else if (t.status === 'interrupted') {
    ref.bar.classList.add('fail')
    ref.pct.textContent = '中断'
    ref.info.textContent = '上次退出时中断'
    ref.btn.textContent = '记录'
    ref.btn.disabled = true
  }
}

async function loadHistory() {
  try {
    const list = await window.api.listTasks()
    for (const t of list.slice().reverse().slice(-20)) renderHistoryItem(t)
  } catch (_) { /* 历史读不到不影响下载 */ } finally {
    updateTopbarStatus()
  }
}

async function startDownload() {
  const url = $('url').value.trim()
  if (!url) return setStatus('先粘贴一个链接')
  const id = 't' + Date.now().toString(36)
  const title = $('title').textContent || url
  const formatValue = $('format').value
  const audioOnly = formatValue === 'audio'
  const maxHeight = formatValue === 'best' || audioOnly ? 0 : Number(formatValue)
  const ref = addTask(id, title)
  openTaskModal()
  $('downloadBtn').disabled = true
  try {
    const res = await window.api.download({ id, title, url, maxHeight, audioOnly, expectedDuration: currentMeta ? currentMeta.duration : 0 })
    markTaskDone(ref, res)
    if (!res.canceled) {
      setStatus(res.warning ? '下载完成，但时长对不上：' + res.warning : '下载完成', !res.warning)
      if (currentModule === 'library') loadFiles(currentSub.library)
    }
  } catch (err) {
    markTaskFailed(ref, err)
  } finally {
    taskSpeeds.delete(id)
    renderTaskSpeed()
    $('downloadBtn').disabled = false
    updateTopbarStatus()
  }
}

/* ---------------- UP 主资源获取 ---------------- */
let upVideos = []
let upVisible = []
let upAuthor = ''
let upLoading = false
const DEFAULT_FILTERS = { charging: 'all', start: '', end: '', min: '', max: '' }
let upFilters = Object.assign({}, DEFAULT_FILTERS)

function filtersActive() {
  const f = upFilters
  return f.charging !== 'all' || !!f.start || !!f.end || f.min !== '' || f.max !== ''
}

function updateUpFilterButton() {
  $('upFilterBtn').classList.toggle('active', filtersActive())
}

function monthStart(ym) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).getTime()
}

function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m, 0, 23, 59, 59, 999).getTime()
}

function updateUpSummary() {
  const total = upVideos.length
  const shown = upVisible.length
  const base = shown === total ? `共 ${total} 个视频` : `共 ${shown} 个视频 / 全部 ${total}`
  $('upSummary').textContent = base + (upAuthor ? ' · ' + upAuthor : '')
}

function applyUpFilters() {
  const f = upFilters
  const start = f.start ? monthStart(f.start) : 0
  const end = f.end ? monthEnd(f.end) : Infinity
  const minSec = f.min !== '' ? Number(f.min) * 60 : 0
  const maxSec = f.max !== '' ? Number(f.max) * 60 : Infinity
  upVisible = upVideos.filter((v) => {
    if (f.charging === 'charging' && !v.charging) return false
    if (f.charging === 'non' && v.charging) return false
    if (f.start || f.end) {
      if (!v.created) return false
      if (v.created < start || v.created > end) return false
    }
    if (f.min !== '' || f.max !== '') {
      if (!v.duration) return false
      if (v.duration < minSec || v.duration > maxSec) return false
    }
    return true
  })
  for (const v of upVideos) v.selected = false
  renderUpList()
  updateUpSelection()
  updateUpSummary()
  updateUpFilterButton()
}

function openFilterModal() {
  const f = upFilters
  document.querySelectorAll('input[name=filterCharge]').forEach((r) => { r.checked = r.value === f.charging })
  $('filterStart').value = f.start
  $('filterEnd').value = f.end
  $('filterMin').value = f.min
  $('filterMax').value = f.max
  $('filterError').textContent = ''
  $('filterModal').classList.remove('hidden')
}

function closeFilterModal() {
  $('filterModal').classList.add('hidden')
}

function readFilterInputs() {
  const charging = (document.querySelector('input[name=filterCharge]:checked') || {}).value || 'all'
  const start = $('filterStart').value
  const end = $('filterEnd').value
  const min = $('filterMin').value.trim()
  const max = $('filterMax').value.trim()
  if (start && end && start > end) throw new Error('开始月份不能晚于结束月份')
  if ((min !== '' && Number(min) < 0) || (max !== '' && Number(max) < 0)) throw new Error('时长不能为负数')
  if (min !== '' && max !== '' && Number(min) > Number(max)) throw new Error('最小时长不能大于最大时长')
  return { charging, start, end, min, max }
}

function applyFiltersFromModal() {
  try {
    upFilters = readFilterInputs()
    $('filterError').textContent = ''
    applyUpFilters()
    closeFilterModal()
  } catch (err) {
    $('filterError').textContent = err.message
  }
}

function updateUpSelection() {
  const n = upVideos.filter((v) => v.selected).length
  $('upSelected').textContent = `已选 ${n}`
  const btn = $('upDownload')
  btn.textContent = n ? `批量下载 (${n})` : '批量下载'
  btn.disabled = n === 0
}

function renderUpList() {
  const box = $('upList')
  box.innerHTML = ''
  if (!upVisible.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '没有符合条件的视频'
    box.appendChild(empty)
    return
  }
  const frag = document.createDocumentFragment()
  for (const v of upVisible) {
    const row = document.createElement('div')
    row.className = 'up-item' + (v.selected ? ' selected' : '')

    const check = document.createElement('input')
    check.type = 'checkbox'
    check.className = 'up-check'
    check.checked = !!v.selected
    check.addEventListener('change', () => {
      v.selected = check.checked
      row.classList.toggle('selected', check.checked)
      updateUpSelection()
    })

    const thumbWrap = document.createElement('div')
    thumbWrap.className = 'up-thumb-wrap'
    if (v.thumb) {
      const img = document.createElement('img')
      img.className = 'up-thumb'
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      img.alt = ''
      img.src = v.thumb
      img.addEventListener('error', () => { img.style.visibility = 'hidden' })
      thumbWrap.appendChild(img)
    } else {
      const ph = document.createElement('div')
      ph.className = 'up-thumb up-thumb-empty'
      ph.textContent = '无封面'
      thumbWrap.appendChild(ph)
    }
    const dur = document.createElement('span')
    dur.className = 'up-duration'
    dur.textContent = v.duration ? fmtDuration(v.duration) : '—'
    thumbWrap.appendChild(dur)

    const main = document.createElement('div')
    main.className = 'up-main'
    const title = document.createElement('div')
    title.className = 'up-title'
    title.textContent = v.title || '(无标题)'
    title.title = v.title || ''
    const meta = document.createElement('div')
    meta.className = 'up-meta'
    const upTime = document.createElement('span')
    upTime.textContent = v.created ? `上传于 ${fmtDate(v.created)}` : '上传时间未知'
    const len = document.createElement('span')
    len.textContent = v.duration ? `时长 ${fmtDuration(v.duration)}` : '时长未知'
    meta.append(upTime, len)
    if (v.charging) {
      const charge = document.createElement('span')
      charge.className = 'up-charge'
      charge.textContent = '充电'
      meta.appendChild(charge)
    }
    main.append(title, meta)

    row.append(check, thumbWrap, main)
    frag.appendChild(row)
  }
  box.appendChild(frag)
  box.scrollTop = 0
}

function setUpSelection(value) {
  for (const v of upVisible) v.selected = value
  for (const row of $('upList').querySelectorAll('.up-item')) {
    row.classList.toggle('selected', value)
    const check = row.querySelector('.up-check')
    if (check) check.checked = value
  }
  updateUpSelection()
}

async function loadUpList() {
  if ($('upLoad').disabled) return
  const url = $('upUrl').value.trim()
  if (!url) {
    $('upStatus').textContent = '先粘贴 UP 主空间链接'
    return
  }
  $('upLoad').disabled = true
  $('upLoad').textContent = '获取中…'
  $('upStatus').textContent = '正在获取 UP 主视频列表…'
  $('upStatus').classList.remove('ok')
  upLoading = true
  $('upProgress').classList.remove('hidden')
  $('upProgressFill').style.width = '0%'
  $('upProgressText').textContent = '已获取 0 个视频'
  $('upListWrap').classList.add('hidden')
  $('upList').innerHTML = ''
  upVideos = []
  upVisible = []
  upAuthor = ''
  upFilters = Object.assign({}, DEFAULT_FILTERS)
  $('upSummary').textContent = ''
  updateUpFilterButton()
  updateUpSelection()
  try {
    const r = await window.api.listUp(url)
    upVideos = (r.videos || []).map((v) => Object.assign({}, v, { selected: false }))
    if (!upVideos.length) {
      $('upStatus').textContent = '这个 UP 主没有可列出的视频'
      $('upProgress').classList.add('hidden')
      return
    }
    upVisible = upVideos
    upAuthor = r.author || ''
    renderUpList()
    updateUpSummary()
    updateUpFilterButton()
    $('upStatus').textContent = `已获取 ${upVideos.length} 个视频`
    $('upStatus').classList.add('ok')
    $('upProgress').classList.add('hidden')
    $('upListWrap').classList.remove('hidden')
    updateUpSelection()
  } catch (err) {
    $('upProgress').classList.add('hidden')
    $('upStatus').textContent = '获取失败：' + humanizeError(err.message)
  } finally {
    upLoading = false
    $('upLoad').disabled = false
    $('upLoad').textContent = '获取列表'
  }
}

function startBatchDownload() {
  const chosen = upVideos.filter((v) => v.selected)
  if (!chosen.length) return
  const count = chosen.length
  for (let i = 0; i < chosen.length; i++) {
    const v = chosen[i]
    const id = 'b' + Date.now().toString(36) + '_' + i.toString(36) + Math.random().toString(36).slice(2, 5)
    const ref = addTask(id, v.title || v.url)
    taskSpeeds.delete(id)
    window.api.download({
      id,
      title: v.title || v.url,
      url: v.url,
      maxHeight: 0,
      audioOnly: false,
      expectedDuration: Number(v.duration) || 0
    }).then((res) => markTaskDone(ref, res))
      .catch((err) => markTaskFailed(ref, err))
      .finally(() => {
        taskSpeeds.delete(id)
        renderTaskSpeed()
        updateTopbarStatus()
      })
  }
  setUpSelection(false)
  $('upStatus').textContent = `已加入下载队列：${count} 个视频`
  $('upStatus').classList.add('ok')
}

/* ---------------- 资源管理 ---------------- */
async function revealWithFallback(target) {
  const r = await window.api.revealPath(target)
  if (r && r.ok) return true
  const p = (r && r.path) || target || $('libPath').textContent
  await window.api.copyText(p)
  window.alert(`无法自动打开文件夹（当前进程没有调用资源管理器的权限）。\n路径已复制到剪贴板，手动粘贴到地址栏即可：\n\n${p}`)
  return false
}

function fileRow(f) {
  const row = document.createElement('div')
  row.className = 'file-row'

  const type = document.createElement('div')
  type.className = 'file-type' + (f.type === 'audio' ? ' audio' : '')
  type.textContent = f.type === 'audio' ? '音' : '视'

  const main = document.createElement('div')
  main.className = 'file-main'
  const name = document.createElement('div')
  name.className = 'file-name'
  name.textContent = f.name
  name.title = f.path
  const meta = document.createElement('div')
  meta.className = 'file-meta'
  meta.textContent = `${fmtSize(f.size)} · ${fmtDate(f.mtime)}`
  main.append(name, meta)

  const actions = document.createElement('div')
  actions.className = 'file-actions'
  const open = document.createElement('button')
  open.className = 'btn ghost small'
  open.textContent = '位置'
  open.addEventListener('click', () => revealWithFallback(f.path))
  const copy = document.createElement('button')
  copy.className = 'btn ghost small'
  copy.textContent = '复制路径'
  copy.addEventListener('click', async () => {
    await window.api.copyText(f.path)
    copy.textContent = '已复制'
    setTimeout(() => { copy.textContent = '复制路径' }, 1200)
  })
  const del = document.createElement('button')
  del.className = 'btn ghost small'
  del.textContent = '删除'
  del.addEventListener('click', async () => {
    if (!window.confirm(`把「${f.name}」移到回收站？`)) return
    del.disabled = true
    try {
      await window.api.trashFile(f.path)
      await loadFiles(currentSub.library)
    } catch (err) {
      window.alert('删除失败：' + humanizeError(err.message))
      del.disabled = false
    }
  })
  actions.append(open, copy, del)
  row.append(type, main, actions)
  return row
}

async function loadFiles(filter) {
  const list = $('libList')
  list.innerHTML = '<div class="empty">扫描中…</div>'
  try {
    const { root, files } = await window.api.listFiles(filter)
    $('libPath').textContent = root
    $('libPath').title = root
    const total = files.reduce((sum, f) => sum + f.size, 0)
    $('libSummary').textContent = files.length ? `${files.length} 个文件 · ${fmtSize(total)}` : ''
    if (!files.length) {
      list.innerHTML = '<div class="empty">这个目录里还没有下载好的文件</div>'
      return
    }
    list.innerHTML = ''
    for (const f of files) list.appendChild(fileRow(f))
  } catch (err) {
    list.innerHTML = `<div class="empty">扫描失败：${humanizeError(err.message)}</div>`
  }
}

/* ---------------- 设置 ---------------- */
let updateState = null

function showUpdateToast(st) {
  $('updateToastVersion').textContent = `v${st.remoteVersion}`
  $('updateToast').classList.remove('hidden')
}

function hideUpdateToast() {
  $('updateToast').classList.add('hidden')
}

function renderUpdateNotes(st) {
  const box = $('updateNotes')
  box.innerHTML = ''
  const notes = st.notes || []
  if (!notes.length) {
    const p = document.createElement('div')
    p.className = 'muted'
    p.textContent = '暂无更新说明'
    box.appendChild(p)
  } else {
    for (const rel of notes) {
      const block = document.createElement('div')
      block.className = 'update-note'
      const h = document.createElement('h4')
      h.textContent = `v${rel.version}${rel.date ? ' · ' + rel.date : ''}`
      const ul = document.createElement('ul')
      for (const item of rel.items || []) {
        const li = document.createElement('li')
        li.textContent = item
        ul.appendChild(li)
      }
      block.append(h, ul)
      box.appendChild(block)
    }
  }
  box.classList.remove('hidden')
}

function renderUpdateState(st) {
  const status = $('updateStatus')
  const notes = $('updateNotes')
  const actions = $('updateActions')
  if (!st) {
    status.textContent = '尚未检查更新'
    status.classList.remove('ok')
    notes.classList.add('hidden')
    actions.classList.add('hidden')
    return
  }
  if (!st.ok) {
    status.textContent = '检查失败：' + (st.error || '未知错误')
    status.classList.remove('ok')
    notes.classList.add('hidden')
    actions.classList.add('hidden')
    return
  }
  if (st.updateAvailable) {
    status.textContent = `发现新版本 v${st.remoteVersion}（当前 v${st.localVersion}）`
    status.classList.add('ok')
    renderUpdateNotes(st)
    actions.classList.remove('hidden')
    $('installUpdate').disabled = false
    $('updateHint').textContent = '更新会替换 app.asar 并自动重启应用'
  } else {
    status.textContent = `已是最新版本（v${st.localVersion}）`
    status.classList.add('ok')
    notes.classList.add('hidden')
    actions.classList.add('hidden')
  }
}

async function loadUpdateState() {
  if (updateState) {
    renderUpdateState(updateState)
    return
  }
  try {
    const st = await window.api.getUpdateState()
    if (st) {
      updateState = st
      renderUpdateState(st)
    } else {
      renderUpdateState(null)
    }
  } catch (_) {
    renderUpdateState(null)
  }
}

async function checkForUpdate() {
  const btn = $('checkUpdate')
  btn.disabled = true
  btn.textContent = '检查中…'
  $('updateStatus').textContent = '正在检查更新…'
  $('updateStatus').classList.remove('ok')
  $('updateNotes').classList.add('hidden')
  $('updateActions').classList.add('hidden')
  try {
    const st = await window.api.checkUpdate()
    updateState = st
    renderUpdateState(st)
    if (st && st.ok && st.updateAvailable) showUpdateToast(st)
  } catch (err) {
    renderUpdateState({ ok: false, error: humanizeError(err.message) })
  } finally {
    btn.disabled = false
    btn.textContent = '检查更新'
  }
}

async function installUpdate() {
  if (!window.confirm('下载并安装更新？应用会自动重启。')) return
  const btn = $('installUpdate')
  btn.disabled = true
  $('updateStatus').textContent = '正在下载更新…'
  $('updateStatus').classList.remove('ok')
  try {
    await window.api.installUpdate()
    $('updateStatus').textContent = '正在安装，应用即将重启…'
  } catch (err) {
    $('updateStatus').textContent = '安装失败：' + humanizeError(err.message)
    btn.disabled = false
  }
}

function syncProxyInput() {
  $('proxyUrl').disabled = $('proxyMode').value !== 'custom'
}

async function loadSettings() {
  try {
    settingsCache = await window.api.getSettings()
    $('proxyMode').value = settingsCache.proxyMode || 'system'
    $('proxyUrl').value = settingsCache.proxyUrl || ''
    $('downloadDir').value = settingsCache.downloadDir || ''
    syncProxyInput()
  } catch (_) { /* 读取失败沿用默认值 */ }
}

/* ---------------- 事件绑定 ---------------- */
for (const btn of document.querySelectorAll('.rail-btn')) {
  btn.addEventListener('click', () => switchModule(btn.dataset.module))
}

$('probeBtn').addEventListener('click', async () => {
  const url = $('url').value.trim()
  if (!url) return setStatus('先粘贴一个链接')
  $('probeBtn').disabled = true
  setStatus('解析中…')
  $('meta').classList.add('hidden')
  try {
    const meta = await window.api.probe(url)
    renderMeta(meta)
    setStatus('', true)
  } catch (err) {
    setStatus('解析失败：' + humanizeError(err.message))
  } finally {
    $('probeBtn').disabled = false
  }
})

$('downloadBtn').addEventListener('click', startDownload)

$('upLoad').addEventListener('click', loadUpList)
$('upUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadUpList()
})
$('upSelectAll').addEventListener('click', () => setUpSelection(true))
$('upSelectNone').addEventListener('click', () => setUpSelection(false))
$('upDownload').addEventListener('click', startBatchDownload)

$('upFilterBtn').addEventListener('click', openFilterModal)
$('filterClose').addEventListener('click', closeFilterModal)
$('filterCancel').addEventListener('click', closeFilterModal)
$('filterApply').addEventListener('click', applyFiltersFromModal)
$('filterReset').addEventListener('click', () => {
  upFilters = Object.assign({}, DEFAULT_FILTERS)
  applyUpFilters()
  closeFilterModal()
})
$('filterModal').addEventListener('click', (e) => {
  if (e.target === $('filterModal')) closeFilterModal()
})

$('taskToggle').addEventListener('click', openTaskModal)
$('taskClose').addEventListener('click', closeTaskModal)
$('taskClear').addEventListener('click', clearTaskHistory)
$('taskModal').addEventListener('click', (e) => {
  if (e.target === $('taskModal')) closeTaskModal()
})
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!$('filterModal').classList.contains('hidden')) closeFilterModal()
  else if (!$('taskModal').classList.contains('hidden')) closeTaskModal()
})

$('tasks').addEventListener('click', async (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  const task = btn.closest('.task')
  const id = [...tasks.entries()].find(([, r]) => r.el === task)?.[0]
  if (!id) return
  if (btn.dataset.act === 'cancel') {
    btn.disabled = true
    await window.api.cancel(id)
  } else if (btn.dataset.act === 'open') {
    await revealWithFallback(btn.dataset.path)
  }
})

$('loginBtn').addEventListener('click', async () => {
  $('loginBtn').disabled = true
  $('loginBtn').textContent = '登录中…'
  try {
    await window.api.openLogin()
  } finally {
    $('loginBtn').disabled = false
    refreshAuth()
  }
})

$('libRefresh').addEventListener('click', () => loadFiles(currentSub.library))
$('libOpen').addEventListener('click', () => revealWithFallback(''))
$('libCopy').addEventListener('click', async () => {
  await window.api.copyText($('libPath').textContent)
  $('libCopy').textContent = '已复制'
  setTimeout(() => { $('libCopy').textContent = '复制目录' }, 1200)
})

$('pickDir').addEventListener('click', async () => {
  $('pickDir').disabled = true
  try {
    const dir = await window.api.pickDir()
    if (!dir) return
    settingsCache = await window.api.setSettings(Object.assign({}, settingsCache, { downloadDir: dir }))
    $('downloadDir').value = settingsCache.downloadDir
    $('dirStatus').textContent = '已保存：' + dir
    $('dirStatus').classList.add('ok')
  } catch (err) {
    $('dirStatus').textContent = '保存失败：' + humanizeError(err.message)
  } finally {
    $('pickDir').disabled = false
  }
})

$('proxyMode').addEventListener('change', syncProxyInput)

$('saveProxy').addEventListener('click', async () => {
  $('saveProxy').disabled = true
  try {
    settingsCache = await window.api.setSettings(Object.assign({}, settingsCache, {
      proxyMode: $('proxyMode').value,
      proxyUrl: $('proxyUrl').value.trim()
    }))
    $('netStatus').textContent = '已保存'
    $('netStatus').classList.add('ok')
  } catch (err) {
    $('netStatus').textContent = '保存失败：' + humanizeError(err.message)
  } finally {
    $('saveProxy').disabled = false
  }
})

$('testProxy').addEventListener('click', async () => {
  $('testProxy').disabled = true
  $('netStatus').textContent = '测试中…'
  try {
    const r = await window.api.testProxy()
    const line = (name, x) => `${name} ${x.ok ? 'OK ' + x.ms + 'ms' : '失败(' + (x.error || x.status) + ')'}`
    const via = r.resolved ? `代理 ${r.resolved}` : '直连'
    $('netStatus').textContent = `${line('B站', r.bilibili)} · ${line('YouTube', r.youtube)} · ${via}`
    $('netStatus').classList.toggle('ok', r.bilibili.ok)
  } catch (err) {
    $('netStatus').textContent = '测试失败：' + humanizeError(err.message)
  } finally {
    $('testProxy').disabled = false
  }
})

$('checkUpdate').addEventListener('click', checkForUpdate)
$('installUpdate').addEventListener('click', installUpdate)
$('updateToastClose').addEventListener('click', hideUpdateToast)
$('updateToastView').addEventListener('click', () => {
  currentSub.settings = 'update'
  switchModule('settings')
  hideUpdateToast()
  if (updateState) renderUpdateState(updateState)
})

$('updateEngine').addEventListener('click', async () => {
  $('updateEngine').disabled = true
  $('updateEngine').textContent = '更新中…'
  try {
    const r = await window.api.updateEngine()
    window.alert(r.ok ? '下载引擎已是最新版本' : '更新失败：\n' + r.output)
  } catch (err) {
    window.alert('更新失败：' + humanizeError(err.message))
  } finally {
    $('updateEngine').disabled = false
    $('updateEngine').textContent = '更新下载引擎'
  }
})

window.api.onUpProgress((p) => {
  if (!upLoading) return
  const loaded = Number(p.loaded) || 0
  const total = Number(p.total) || 0
  $('upProgressFill').style.width = (total ? Math.min(100, (loaded / total) * 100) : 0) + '%'
  $('upProgressText').textContent = total ? `已获取 ${loaded} / ${total} 个视频` : `已获取 ${loaded} 个视频`
})

window.api.onUpdateChecked((st) => {
  updateState = st
  renderUpdateState(st)
  if (st && st.ok && st.updateAvailable) showUpdateToast(st)
})

window.api.onTask((ev) => {
  const ref = tasks.get(ev.id)
  if (!ref) return
  if (ev.type === 'warning') {
    ref.bar.classList.remove('done')
    ref.bar.classList.add('fail')
    setTaskInfo(ref, '⚠ ' + ev.message)
    updateTopbarStatus()
    return
  }
  if (ev.type === 'file') {
    taskSpeeds.delete(ev.id)
    renderTaskSpeed()
    return
  }
  if (ev.type === 'progress') {
    ref.fill.style.width = Math.max(1, ev.percent) + '%'
    const parts = [ev.percent.toFixed(1) + '%']
    if (ev.bytes && ev.total) parts.push(`${(ev.bytes / 1048576).toFixed(1)}/${(ev.total / 1048576).toFixed(1)} MB`)
    if (ev.speed) parts.push(fmtSpeed(ev.speed))
    if (ev.eta) parts.push('剩余 ' + fmtDuration(ev.eta))
    setTaskInfo(ref, parts.join(' · '))
    ref.pct.textContent = Math.round(ev.percent) + '%'
    if (ev.speed) taskSpeeds.set(ev.id, ev.speed)
    else taskSpeeds.delete(ev.id)
    renderTaskSpeed()
  }
})

window.api.onLog((line) => {
  const el = $('log')
  el.textContent += line.replace(/^\[[^\]]+\]\s*/, '') + '\n'
  el.scrollTop = el.scrollHeight
})

/* ---------------- 启动 ---------------- */
refreshAuth()
loadSettings()
loadHistory()
renderSubbar()
window.api.appVersion().then((v) => { $('ver').textContent = v }).catch(() => {})
