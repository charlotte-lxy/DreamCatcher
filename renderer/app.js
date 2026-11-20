'use strict'
const $ = (id) => document.getElementById(id)
const tasks = new Map()
const taskSpeeds = new Map()
let taskGroup = 0
let currentMeta = null
let settingsCache = {}
let currentModule = 'acquire'
const currentSub = { acquire: 'single', subscribe: 'bili', library: 'all', settings: 'download' }

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
  subscribe: {
    title: '订阅',
    items: [
      { id: 'bili', label: 'B 站 UP' },
      { id: 'hanime', label: 'Hanime' },
      { id: 'summary', label: '更新汇总' }
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
function switchModule(name) {
  currentModule = name
  for (const btn of document.querySelectorAll('.rail-btn')) {
    btn.classList.toggle('active', btn.dataset.module === name)
  }
  for (const page of document.querySelectorAll('.page')) {
    page.classList.toggle('active', page.id === 'page-' + name)
  }
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
  } else if (currentModule === 'subscribe') {
    for (const panel of document.querySelectorAll('#page-subscribe .panel')) {
      panel.classList.toggle('hidden', panel.dataset.panel !== currentSub.subscribe)
    }
    updateSubCompareVisibility()
    if (currentSub.subscribe === 'summary') loadSummary()
    else loadSubscriptions()
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
  if (meta.audio !== false) add('audio', '仅音频')
}

function appendTags(box, tags, limit) {
  const list = (tags || []).slice(0, limit || 20)
  for (const t of list) {
    const chip = document.createElement('span')
    chip.className = 'tag-chip'
    chip.textContent = t
    chip.title = t
    box.appendChild(chip)
  }
  const rest = (tags || []).length - list.length
  if (rest > 0) {
    const more = document.createElement('span')
    more.className = 'tag-chip tag-chip-more'
    more.textContent = `+${rest}`
    box.appendChild(more)
  }
}

function renderMeta(meta) {
  currentMeta = meta
  $('meta').classList.remove('hidden')
  $('cover').src = meta.thumbnail || ''
  $('title').textContent = meta.title || '(无标题)'
  $('sub').textContent = `${meta.uploader || '未知作者'} · ${fmtDuration(meta.duration)}`
  const tagsBox = $('tags')
  tagsBox.innerHTML = ''
  const tagList = meta.tags || []
  appendTags(tagsBox, tagList, 20)
  tagsBox.classList.toggle('hidden', tagList.length === 0)
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
  const refs = [...tasks.values()]
  const active = refs.filter((r) => r.live).length
  const badge = $('taskCount')
  badge.textContent = String(active)
  badge.classList.toggle('hidden', active === 0)
  $('taskSummary').textContent = active
    ? `${active} 个进行中 · ${refs.length} 条记录`
    : (refs.length ? `${refs.length} 条记录` : '暂无任务')
}

function updateTopbarStatus() {
  const running = [...tasks.values()].some((r) => r.live)
  $('topbarStatusBox').classList.toggle('busy', running)
  $('topbarStatus').textContent = running ? '下载中' : '就绪'
}

function updateOverallProgress() {
  const refs = [...tasks.values()].filter((r) => r.session && r.group === taskGroup)
  const box = $('taskOverall')
  if (!refs.length) {
    box.classList.add('hidden')
    return
  }
  let sum = 0
  let settled = 0
  for (const r of refs) {
    sum += Math.max(0, Math.min(100, Number(r.percent) || 0))
    if (!r.live) settled++
  }
  const pct = Math.round(sum / refs.length)
  box.classList.remove('hidden')
  $('taskOverallFill').style.width = pct + '%'
  $('taskOverallText').textContent = `${pct}% · ${settled}/${refs.length} 个完成`
}

function refreshTaskEmpty() {
  const box = $('activeTasks')
  const empty = box.querySelector('.empty')
  if (tasks.size === 0) {
    if (!empty) {
      const el = document.createElement('div')
      el.className = 'empty'
      el.textContent = '还没有任务'
      box.appendChild(el)
    }
  } else if (empty) {
    empty.remove()
  }
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

// 失败/取消后按钮改为可点击的「清除」，否则会留下一个点了没反应的「取消」
function setTaskRemove(ref) {
  if (!ref) return
  ref.btn.textContent = '清除'
  ref.btn.dataset.act = 'remove'
  ref.btn.disabled = false
}

function markTaskDone(ref, res) {
  ref.live = false
  ref.percent = 100
  if (res.canceled) {
    ref.bar.classList.add('fail')
    ref.pct.textContent = '已取消'
    setTaskInfo(ref, '已取消')
    setTaskRemove(ref)
    updateTaskBadge()
    updateOverallProgress()
    updateTopbarStatus()
    return
  }
  ref.bar.classList.add('done')
  ref.fill.style.width = '100%'
  ref.pct.textContent = '100%'
  ref.info.textContent = res.warning ? '已完成（⚠ ' + res.warning + '）' : '已完成'
  ref.btn.textContent = '打开'
  ref.btn.dataset.act = 'open'
  ref.btn.dataset.path = res.file || ''
  updateTaskBadge()
  updateOverallProgress()
  updateTopbarStatus()
}

function markTaskFailed(ref, err) {
  ref.live = false
  ref.percent = 100
  ref.bar.classList.add('fail')
  ref.fill.style.width = '100%'
  ref.pct.textContent = '失败'
  setTaskInfo(ref, '失败：' + humanizeError(err.message))
  setTaskRemove(ref)
  updateTaskBadge()
  updateOverallProgress()
  updateTopbarStatus()
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
    refreshTaskEmpty()
    updateTaskBadge()
    updateOverallProgress()
    updateTopbarStatus()
  } catch (err) {
    window.alert('清除失败：' + humanizeError(err.message))
  } finally {
    btn.disabled = false
  }
}

async function removeTaskRecord(id) {
  const ref = tasks.get(id)
  if (!ref || ref.live) return
  try {
    const ok = await window.api.removeTask(id)
    if (!ok) return
    ref.el.remove()
    tasks.delete(id)
    refreshTaskEmpty()
    updateTaskBadge()
    updateOverallProgress()
    updateTopbarStatus()
  } catch (err) {
    window.alert('清除失败：' + humanizeError(err.message))
  }
}

function addTask(id, title, history = false) {
  const box = history ? $('tasks') : $('activeTasks')
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
  if (history) box.prepend(el)
  else box.appendChild(el)

  if (!history && ![...tasks.values()].some((r) => r.live)) taskGroup++
  const ref = {
    el,
    bar: el.querySelector('.bar'),
    fill: el.querySelector('.bar > i'),
    info: el.querySelector('.task-info'),
    pct: el.querySelector('.task-pct'),
    btn: el.querySelector('[data-act]'),
    live: true,
    session: !history,
    group: history ? 0 : taskGroup,
    percent: 0
  }
  tasks.set(id, ref)
  refreshTaskEmpty()
  updateTaskBadge()
  updateOverallProgress()
  updateTopbarStatus()
  return ref
}

function renderHistoryItem(t) {
  const ref = addTask(t.id, t.title || t.url, true)
  ref.live = false
  if (t.status === 'done' && t.file) {
    ref.percent = 100
    ref.bar.classList.add('done')
    ref.fill.style.width = '100%'
    ref.pct.textContent = '100%'
    ref.info.textContent = t.warning ? '已完成（⚠ ' + t.warning + '）' : '已完成'
    ref.btn.textContent = '打开'
    ref.btn.dataset.act = 'open'
    ref.btn.dataset.path = t.file
  } else if (t.status === 'failed') {
    ref.percent = 100
    ref.bar.classList.add('fail')
    ref.fill.style.width = '100%'
    ref.pct.textContent = '失败'
    ref.info.textContent = '失败：' + humanizeError(t.error || '')
    setTaskRemove(ref)
  } else if (t.status === 'canceled') {
    ref.percent = 100
    ref.bar.classList.add('fail')
    ref.pct.textContent = '已取消'
    ref.info.textContent = '已取消'
    setTaskRemove(ref)
  } else if (t.status === 'interrupted') {
    ref.bar.classList.add('fail')
    ref.pct.textContent = '中断'
    ref.info.textContent = '上次退出时中断'
    ref.btn.textContent = '记录'
    ref.btn.disabled = true
  }
  updateTaskBadge()
  updateOverallProgress()
  updateTopbarStatus()
}

async function loadHistory() {
  try {
    const list = await window.api.listTasks()
    for (const t of list.slice().reverse().slice(-20)) renderHistoryItem(t)
  } catch (_) { /* 历史读不到不影响下载 */ } finally {
    refreshTaskEmpty()
    updateTaskBadge()
    updateOverallProgress()
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
    updateTaskBadge()
    updateOverallProgress()
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

// UP 主列表和订阅比对清单共用一行视频的展示结构
function createVideoRow(v, onChange, onIgnore) {
  const row = document.createElement('div')
  row.className = 'up-item' + (v.selected ? ' selected' : '')

  const check = document.createElement('input')
  check.type = 'checkbox'
  check.className = 'up-check'
  check.checked = !!v.selected
  check.addEventListener('change', () => {
    v.selected = check.checked
    row.classList.toggle('selected', check.checked)
    onChange()
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
  upTime.textContent = v.dateText ? `上传于 ${v.dateText}` : (v.created ? `上传于 ${fmtDate(v.created)}` : '上传时间未知')
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
  if (onIgnore) {
    const ignore = document.createElement('button')
    ignore.className = 'btn ghost small up-ignore'
    ignore.textContent = '忽略'
    ignore.addEventListener('click', () => onIgnore(v))
    row.appendChild(ignore)
  }
  return row
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
  for (const v of upVisible) frag.appendChild(createVideoRow(v, updateUpSelection))
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

function downloadVideoItem(v, prefix, index) {
  const id = prefix + Date.now().toString(36) + '_' + index.toString(36) + Math.random().toString(36).slice(2, 5)
  const ref = addTask(id, v.title || v.url)
  taskSpeeds.delete(id)
  return window.api.download({
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
      updateTaskBadge()
      updateOverallProgress()
      updateTopbarStatus()
    })
}

function startBatchDownload() {
  const chosen = upVideos.filter((v) => v.selected)
  if (!chosen.length) return
  const count = chosen.length
  for (let i = 0; i < chosen.length; i++) downloadVideoItem(chosen[i], 'b', i)
  setUpSelection(false)
  $('upStatus').textContent = `已加入下载队列：${count} 个视频`
  $('upStatus').classList.add('ok')
}

/* ---------------- 订阅（B 站 / Hanime / 更新汇总） ---------------- */
let subsCache = []
let subVideos = []
let subCompare = null
let subBusy = false
let subSettingsTarget = null
let summaryGroups = []
let summaryBusy = false
let summaryLoaded = false

function siteOf(s) {
  return s && s.site === 'hanime' ? 'hanime' : 'bilibili'
}

function panelOf(s) {
  return siteOf(s) === 'hanime' ? 'hanime' : 'bili'
}

function subTypeLabel(s) {
  if (siteOf(s) === 'bilibili') return 'B 站 UP'
  if (s.type === 'playlist') return 'Hanime 播放清单'
  if (s.type === 'search') return 'Hanime 搜索'
  return 'Hanime 上传者'
}

function subFilterLabel(s) {
  if (s.filter === 'normal') return '仅普通视频'
  if (s.filter === 'charging') return '仅充电视频'
  return '全部视频'
}

function statusElFor(site) {
  return site === 'hanime' ? $('hnStatus') : $('subStatus')
}

function progressEls(site) {
  return site === 'hanime'
    ? { box: $('hnProgress'), fill: $('hnProgressFill'), text: $('hnProgressText') }
    : { box: $('subProgress'), fill: $('subProgressFill'), text: $('subProgressText') }
}

function setSubNotice(site, text, ok) {
  const el = statusElFor(site)
  el.textContent = text || ''
  el.classList.toggle('ok', !!ok)
}

function updateSubsCache(rec) {
  if (!rec) return
  const i = subsCache.findIndex((s) => s.key === rec.key)
  if (i >= 0) subsCache[i] = rec
  else subsCache.unshift(rec)
}

function renderSubscriptions() {
  renderSubList('subList', 'bilibili')
  renderSubList('hnList', 'hanime')
}

function renderSubList(boxId, site) {
  const box = $(boxId)
  box.innerHTML = ''
  const list = subsCache.filter((s) => siteOf(s) === site)
  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = site === 'hanime'
      ? '还没有订阅，先粘贴播放清单或上传者链接'
      : '还没有订阅，先粘贴主页链接添加'
    box.appendChild(empty)
    return
  }
  for (const s of list) box.appendChild(subRow(s))
}

function subRow(s) {
  const row = document.createElement('div')
  row.className = 'sub-item'

  const avatar = document.createElement('div')
  avatar.className = 'sub-avatar'
  const initial = String(s.name || '?').trim().slice(0, 1) || '?'
  if (s.face) {
    const img = document.createElement('img')
    img.src = s.face
    img.alt = ''
    img.referrerPolicy = 'no-referrer'
    img.addEventListener('error', () => {
      img.remove()
      avatar.textContent = initial
    })
    avatar.appendChild(img)
  } else {
    avatar.textContent = initial
  }

  const main = document.createElement('div')
  main.className = 'sub-main'
  const name = document.createElement('div')
  name.className = 'sub-name'
  name.textContent = s.name || (siteOf(s) === 'hanime' ? `Hanime ${s.id}` : `UP ${s.mid}`)
  name.title = name.textContent
  const meta = document.createElement('div')
  meta.className = 'sub-meta'
  const parts = [subTypeLabel(s)]
  if (siteOf(s) === 'bilibili') {
    parts.push(`UID ${s.mid}`, subFilterLabel(s))
  } else {
    const kind = s.type === 'playlist' ? '清单' : (s.type === 'search' ? '搜索词' : '上传者')
    parts.push(`${kind} ${s.id}`)
  }
  parts.push(`共 ${Number(s.lastCount) || 0} 个`, `未下载 ${Number(s.lastMissing) || 0} 个`)
  if (s.ignored && s.ignored.length) parts.push(`忽略 ${s.ignored.length} 个`)
  parts.push(s.lastCheckAt ? `上次检查 ${fmtDate(s.lastCheckAt)}` : '尚未检查')
  meta.textContent = parts.join(' · ')
  main.append(name, meta)

  const actions = document.createElement('div')
  actions.className = 'sub-actions'
  const check = document.createElement('button')
  check.className = 'btn ghost small sub-check'
  check.textContent = '检查更新'
  check.disabled = subBusy
  check.addEventListener('click', () => checkSubscription(s))
  const settings = document.createElement('button')
  settings.className = 'btn ghost small sub-settings'
  settings.textContent = '设置'
  settings.disabled = subBusy
  settings.addEventListener('click', () => openSubSettings(s))
  const del = document.createElement('button')
  del.className = 'btn ghost small sub-remove'
  del.textContent = '取消订阅'
  del.disabled = subBusy
  del.addEventListener('click', () => removeSubscription(s))
  actions.append(check, settings, del)

  row.append(avatar, main, actions)
  return row
}

function setSubBusy(busy) {
  subBusy = busy
  for (const id of ['subAdd', 'hnAdd']) {
    const btn = $(id)
    btn.disabled = busy
    btn.textContent = busy ? '获取中…' : '添加订阅'
  }
  for (const btn of document.querySelectorAll('#subList button, #hnList button')) btn.disabled = busy
}

function showSubProgress(site, show) {
  const els = progressEls(site)
  els.box.classList.toggle('hidden', !show)
  if (show) {
    els.fill.style.width = '0%'
    els.text.textContent = '已获取 0 个视频'
  } else {
    els.fill.style.width = '0%'
  }
}

async function loadSubscriptions() {
  try {
    subsCache = await window.api.listSubs()
    renderSubscriptions()
  } catch (err) {
    setSubNotice(currentSub.subscribe === 'hanime' ? 'hanime' : 'bilibili', '读取订阅失败：' + humanizeError(err.message))
  }
}

function updateSubCompareVisibility() {
  const visible = !!subCompare && ['bili', 'hanime'].includes(currentSub.subscribe) &&
    panelOf(subCompare.subscription) === currentSub.subscribe
  $('subCompareWrap').classList.toggle('hidden', !visible)
}

function updateSubSummary() {
  const total = subVideos.length
  const downloaded = subVideos.filter((v) => v.downloaded).length
  const ignored = subCompare && subCompare.subscription && subCompare.subscription.ignored
    ? subCompare.subscription.ignored.length
    : 0
  $('subCompareSummary').textContent = `网页 ${total} 个 · 已下载 ${downloaded} 个 · 待下载 ${total - downloaded} 个` +
    (ignored ? ` · 已忽略 ${ignored} 个` : '')
}

function updateSubSelection() {
  const n = subVideos.filter((v) => v.selected).length
  $('subSelected').textContent = `已选 ${n}`
  const download = $('subDownload')
  download.textContent = n ? `批量下载 (${n})` : '批量下载'
  download.disabled = n === 0
  const ignore = $('subIgnore')
  ignore.textContent = n ? `批量忽略 (${n})` : '批量忽略'
  ignore.disabled = n === 0
}

function renderSubItems() {
  const box = $('subItems')
  box.innerHTML = ''
  if (!subVideos.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '没有待显示的视频'
    box.appendChild(empty)
    return
  }
  const frag = document.createDocumentFragment()
  for (const v of subVideos) {
    const row = createVideoRow(v, updateSubSelection, (video) => {
      ignoreVideos(subCompare.subscription.key, [video], false)
    })
    if (v.downloaded) {
      row.classList.add('downloaded')
      const badge = document.createElement('span')
      badge.className = 'up-downloaded'
      badge.textContent = '已下载'
      if (v.localPath) badge.title = v.localPath
      row.querySelector('.up-meta').appendChild(badge)
    }
    frag.appendChild(row)
  }
  box.appendChild(frag)
  box.scrollTop = 0
}

function showSubCompare(res) {
  subCompare = res
  subVideos = res.videos || []
  $('subCompareTitle').textContent = `比对清单 · ${(res.subscription && res.subscription.name) || '订阅'}`
  updateSubSummary()
  renderSubItems()
  updateSubSelection()
  updateSubCompareVisibility()
}

function setSubSelection(missingOnly) {
  for (const v of subVideos) v.selected = missingOnly ? !v.downloaded : false
  renderSubItems()
  updateSubSelection()
}

async function addSubscription() {
  if (subBusy) return
  const url = $('subUrl').value.trim()
  if (!url) return setSubNotice('bilibili', '先粘贴 UP 主空间链接')
  setSubBusy(true)
  setSubNotice('bilibili', '正在获取网页清单并比对本地文件…')
  showSubProgress('bilibili', true)
  try {
    const res = await window.api.addSub(url)
    $('subUrl').value = ''
    updateSubsCache(res.subscription)
    renderSubscriptions()
    showSubCompare(res)
    setSubNotice('bilibili', `订阅成功：共 ${res.videos.length} 个视频，已下载 ${res.downloaded} 个，待下载 ${res.missing} 个`, true)
    summaryLoaded = false
  } catch (err) {
    setSubNotice('bilibili', '添加失败：' + humanizeError(err.message))
  } finally {
    showSubProgress('bilibili', false)
    setSubBusy(false)
  }
}

async function addHanimeSubscription() {
  if (subBusy) return
  const url = $('hnUrl').value.trim()
  if (!url) return setSubNotice('hanime', '先粘贴 Hanime 播放清单或上传者链接')
  setSubBusy(true)
  setSubNotice('hanime', '正在获取 Hanime 清单…')
  showSubProgress('hanime', true)
  try {
    const res = await window.api.addSubHanime(url)
    $('hnUrl').value = ''
    updateSubsCache(res.subscription)
    renderSubscriptions()
    showSubCompare(res)
    setSubNotice('hanime', `订阅成功：共 ${res.videos.length} 个视频，已下载 ${res.downloaded} 个，待下载 ${res.missing} 个`, true)
    summaryLoaded = false
  } catch (err) {
    setSubNotice('hanime', '添加失败：' + humanizeError(err.message))
  } finally {
    showSubProgress('hanime', false)
    setSubBusy(false)
  }
}

async function checkSubscription(s) {
  if (subBusy) return
  const site = siteOf(s)
  setSubBusy(true)
  setSubNotice(site, `正在检查「${s.name}」…`)
  showSubProgress(site, true)
  try {
    const res = await window.api.checkSub(s.key)
    updateSubsCache(res.subscription)
    renderSubscriptions()
    showSubCompare(res)
    setSubNotice(site, `检查完成：已下载 ${res.downloaded} 个，待下载 ${res.missing} 个`, true)
    summaryLoaded = false
  } catch (err) {
    setSubNotice(site, '检查失败：' + humanizeError(err.message))
  } finally {
    showSubProgress(site, false)
    setSubBusy(false)
  }
}

async function removeSubscription(s) {
  if (subBusy) return
  if (!window.confirm(`取消订阅「${s.name || s.id}」？已下载的文件不会删除，该订阅的忽略清单会一并移除。`)) return
  try {
    subsCache = await window.api.removeSub(s.key)
    renderSubscriptions()
    if (subCompare && subCompare.subscription.key === s.key) {
      subCompare = null
      subVideos = []
      $('subCompareWrap').classList.add('hidden')
    }
    summaryLoaded = false
    setSubNotice(siteOf(s), '已取消订阅', true)
  } catch (err) {
    setSubNotice(siteOf(s), '取消订阅失败：' + humanizeError(err.message))
  }
}

async function refreshSubLocal(key) {
  if (!subCompare || subCompare.subscription.key !== key) return
  try {
    const r = await window.api.compareSub({ key, ids: subVideos.map((v) => v.id) })
    for (const v of subVideos) {
      v.downloaded = !!r.map[v.id]
      v.localPath = r.map[v.id] || ''
      if (v.downloaded) v.selected = false
    }
    if (r.subscription) {
      subCompare.subscription = r.subscription
      updateSubsCache(r.subscription)
      renderSubscriptions()
    }
    renderSubItems()
    updateSubSummary()
    updateSubSelection()
    summaryLoaded = false
  } catch (_) { /* 本地重扫失败不影响已完成的下载 */ }
}

function startSubDownload() {
  if (!subCompare || !subCompare.subscription) return
  const chosen = subVideos.filter((v) => v.selected)
  if (!chosen.length) return
  const key = subCompare.subscription.key
  const site = siteOf(subCompare.subscription)
  const count = chosen.length
  const jobs = chosen.map((v, i) => downloadVideoItem(v, 's', i))
  for (const v of chosen) v.selected = false
  renderSubItems()
  updateSubSelection()
  setSubNotice(site, `已加入下载队列：${count} 个视频`, true)
  Promise.allSettled(jobs).then(() => refreshSubLocal(key))
}

function updateSummaryGroupSelection(group) {
  if (!group._selected) return
  const n = group.videos.filter((v) => v.selected).length
  group._selected.textContent = `已选 ${n}`
  group._ignoreBtn.disabled = n === 0
  group._downloadBtn.disabled = n === 0
}

function selectSummaryGroup(group, value) {
  for (const v of group.videos) v.selected = value
  if (group._list) {
    for (const row of group._list.querySelectorAll('.up-item')) {
      row.classList.toggle('selected', value)
      const check = row.querySelector('.up-check')
      if (check) check.checked = value
    }
  }
  updateSummaryGroupSelection(group)
}

function removeSummaryVideos(key, ids) {
  let changed = false
  summaryGroups = summaryGroups.map((g) => {
    if (g.key !== key) return g
    const before = g.videos.length
    g.videos = g.videos.filter((v) => !ids.has(String(v.id)))
    if (g.videos.length !== before) changed = true
    return g
  }).filter((g) => g.videos.length)
  if (changed && currentSub.subscribe === 'summary') {
    $('summaryStatus').textContent = `${summaryGroups.length} 个订阅有更新`
    renderSummary()
  }
}

async function ignoreVideos(key, videos, confirmFirst) {
  if (!key || !videos || !videos.length) return
  if (confirmFirst && !window.confirm(`忽略选中的 ${videos.length} 个视频？可在订阅设置 → 忽略清单中恢复。`)) return
  try {
    const updated = await window.api.ignoreSub({ key, videos })
    const missingIgnored = videos.filter((v) => !v.downloaded).length
    updated.lastMissing = Math.max(0, (Number(updated.lastMissing) || 0) - missingIgnored)
    updateSubsCache(updated)
    renderSubscriptions()
    const ids = new Set(videos.map((v) => String(v.id)))
    if (subCompare && subCompare.subscription.key === key) {
      subCompare.subscription = updated
      subVideos = subVideos.filter((v) => !ids.has(String(v.id)))
      subCompare.videos = subVideos
      renderSubItems()
      updateSubSummary()
      updateSubSelection()
    }
    removeSummaryVideos(key, ids)
    if (subSettingsTarget && subSettingsTarget.key === key) {
      subSettingsTarget = updated
      renderIgnoreList(updated)
    }
    setSubNotice(siteOf(updated), `已忽略 ${videos.length} 个视频`, true)
  } catch (err) {
    window.alert('忽略失败：' + humanizeError(err.message))
  }
}

function ignoreSelected() {
  if (!subCompare || !subCompare.subscription) return
  const chosen = subVideos.filter((v) => v.selected)
  if (!chosen.length) return
  ignoreVideos(subCompare.subscription.key, chosen, true)
}

/* ---------------- 订阅设置 / 忽略清单 ---------------- */

function openSubSettings(s) {
  subSettingsTarget = s
  $('subSettingsTitle').textContent = `订阅设置 · ${s.name || s.id}`
  $('subSettingsSub').textContent = subTypeLabel(s)
  $('subFilterRow').classList.toggle('hidden', siteOf(s) !== 'bilibili')
  for (const radio of document.querySelectorAll('input[name=subFilter]')) {
    radio.checked = radio.value === (s.filter || 'all')
  }
  renderIgnoreList(s)
  $('subSettingsModal').classList.remove('hidden')
}

function closeSubSettings() {
  $('subSettingsModal').classList.add('hidden')
  subSettingsTarget = null
}

function renderIgnoreList(s) {
  const box = $('subIgnoreList')
  box.innerHTML = ''
  const list = (s.ignored || []).slice().sort((a, b) => (Number(b.ignoredAt) || 0) - (Number(a.ignoredAt) || 0))
  $('subIgnoreCount').textContent = `共 ${list.length} 个`
  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '没有忽略的视频'
    box.appendChild(empty)
    return
  }
  for (const item of list) {
    const row = document.createElement('label')
    row.className = 'sub-ignore-item'
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.className = 'sub-ignore-check'
    check.value = String(item.id)
    const main = document.createElement('div')
    main.className = 'sub-ignore-main'
    const title = document.createElement('div')
    title.className = 'sub-ignore-title'
    title.textContent = item.title || item.id
    title.title = item.title || ''
    const meta = document.createElement('div')
    meta.className = 'sub-ignore-meta'
    meta.textContent = item.dateText || (item.created ? fmtDate(item.created) : '') || String(item.id)
    main.append(title, meta)
    row.append(check, main)
    box.appendChild(row)
  }
}

async function saveSubSettings() {
  if (!subSettingsTarget) return
  const target = subSettingsTarget
  const checked = document.querySelector('input[name=subFilter]:checked')
  const filter = checked ? checked.value : (target.filter || 'all')
  const btn = $('subSettingsSave')
  btn.disabled = true
  try {
    const updated = await window.api.saveSubSettings({ key: target.key, filter })
    updateSubsCache(updated)
    renderSubscriptions()
    closeSubSettings()
    summaryLoaded = false
    if (siteOf(target) === 'bilibili' && subCompare && subCompare.subscription.key === target.key) {
      await checkSubscription(updated)
    }
    setSubNotice(siteOf(updated), '订阅设置已保存', true)
  } catch (err) {
    window.alert('保存设置失败：' + humanizeError(err.message))
  } finally {
    btn.disabled = false
  }
}

async function removeIgnoredSelected() {
  if (!subSettingsTarget) return
  const target = subSettingsTarget
  const ids = [...document.querySelectorAll('#subIgnoreList .sub-ignore-check:checked')].map((c) => c.value)
  if (!ids.length) return
  const btn = $('subIgnoreRemove')
  btn.disabled = true
  try {
    const updated = await window.api.unignoreSub({ key: target.key, ids })
    updateSubsCache(updated)
    renderSubscriptions()
    subSettingsTarget = updated
    renderIgnoreList(updated)
    summaryLoaded = false
    if (subCompare && subCompare.subscription.key === target.key) {
      closeSubSettings()
      await checkSubscription(updated)
    }
  } catch (err) {
    window.alert('移除忽略失败：' + humanizeError(err.message))
  } finally {
    btn.disabled = false
  }
}

/* ---------------- 更新汇总 ---------------- */

function summaryTypeLabel(g) {
  if (g.site === 'bilibili') return 'B 站 UP'
  if (g.type === 'playlist') return 'Hanime 播放清单'
  if (g.type === 'search') return 'Hanime 搜索'
  return 'Hanime 上传者'
}

function summaryBaseText(g) {
  if (!g.hasLocal) return '本地暂无该站视频，列出全部'
  const when = g.latestLocalDateText || (g.latestLocalCreated ? fmtDate(g.latestLocalCreated) : '')
  return `本地最新：${when}${g.latestLocalTitle ? ' · ' + g.latestLocalTitle : ''}`
}

function summaryGroupEl(g) {
  const card = document.createElement('div')
  card.className = 'card summary-group'

  const bar = document.createElement('div')
  bar.className = 'up-toolbar'
  const title = document.createElement('span')
  title.className = 'sub-compare-title'
  title.textContent = g.name
  const meta = document.createElement('span')
  meta.className = 'muted'
  meta.textContent = `${summaryTypeLabel(g)} · ${g.videos.length} 个更新 · ${summaryBaseText(g)}`
  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  const selected = document.createElement('span')
  selected.className = 'up-selected'
  selected.textContent = '已选 0'
  const all = document.createElement('button')
  all.className = 'btn ghost small'
  all.textContent = '全选'
  all.addEventListener('click', () => selectSummaryGroup(g, true))
  const none = document.createElement('button')
  none.className = 'btn ghost small'
  none.textContent = '取消选择'
  none.addEventListener('click', () => selectSummaryGroup(g, false))
  const ignore = document.createElement('button')
  ignore.className = 'btn ghost small'
  ignore.textContent = '批量忽略'
  ignore.disabled = true
  ignore.addEventListener('click', () => {
    const chosen = g.videos.filter((v) => v.selected)
    ignoreVideos(g.key, chosen, true)
  })
  const download = document.createElement('button')
  download.className = 'btn primary small'
  download.textContent = '批量下载'
  download.disabled = true
  download.addEventListener('click', () => {
    const chosen = g.videos.filter((v) => v.selected)
    if (!chosen.length) return
    const jobs = chosen.map((v, i) => downloadVideoItem(v, 's', i))
    const ids = new Set(chosen.map((v) => String(v.id)))
    summaryGroups = summaryGroups.map((x) => x.key === g.key
      ? Object.assign({}, x, { videos: x.videos.filter((v) => !ids.has(String(v.id))) })
      : x).filter((x) => x.videos.length)
    summaryLoaded = false
    $('summaryStatus').textContent = `${summaryGroups.length} 个订阅有更新`
    renderSummary()
    Promise.allSettled(jobs)
  })

  bar.append(title, meta, spacer, selected, all, none, ignore, download)

  const list = document.createElement('div')
  list.className = 'up-list'
  const frag = document.createDocumentFragment()
  for (const v of g.videos) {
    frag.appendChild(createVideoRow(v, () => updateSummaryGroupSelection(g), (video) => {
      ignoreVideos(g.key, [video], false)
    }))
  }
  list.appendChild(frag)

  g._selected = selected
  g._ignoreBtn = ignore
  g._downloadBtn = download
  g._list = list
  updateSummaryGroupSelection(g)

  card.append(bar, list)
  return card
}

function renderSummary() {
  const box = $('summaryGroups')
  box.innerHTML = ''
  if (!summaryGroups.length) {
    const card = document.createElement('div')
    card.className = 'card'
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '暂无更新'
    card.appendChild(empty)
    box.appendChild(card)
    return
  }
  for (const g of summaryGroups) box.appendChild(summaryGroupEl(g))
}

async function loadSummary(force) {
  if (summaryBusy) return
  if (summaryLoaded && !force) {
    renderSummary()
    return
  }
  summaryBusy = true
  summaryLoaded = true
  $('summaryRefresh').disabled = true
  $('summaryStatus').textContent = '正在检查订阅…'
  $('summaryGroups').innerHTML = '<div class="card"><div class="empty">正在检查订阅…</div></div>'
  $('summaryProgress').classList.remove('hidden')
  $('summaryProgressFill').style.width = '0%'
  $('summaryProgressText').textContent = '正在检查订阅…'
  try {
    const r = await window.api.summary()
    summaryGroups = r.groups || []
    renderSummary()
    const errors = r.errors && r.errors.length ? `，${r.errors.length} 个订阅检查失败` : ''
    $('summaryStatus').textContent = `${summaryGroups.length} 个订阅有更新${errors}`
    $('summaryStatus').title = (r.errors || []).map((e) => `${e.name}：${e.error}`).join('\n')
  } catch (err) {
    summaryGroups = []
    summaryLoaded = false
    renderSummary()
    $('summaryStatus').textContent = '汇总失败：' + humanizeError(err.message)
  } finally {
    summaryBusy = false
    $('summaryRefresh').disabled = false
    $('summaryProgress').classList.add('hidden')
  }
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
  const tagBox = document.createElement('div')
  tagBox.className = 'file-tags'
  if (f.tags && f.tags.length) {
    appendTags(tagBox, f.tags, 8)
  } else if (f.tagged) {
    const none = document.createElement('span')
    none.className = 'file-tag-empty'
    none.textContent = '无标签'
    tagBox.appendChild(none)
  } else if (f.taggable) {
    const none = document.createElement('span')
    none.className = 'file-tag-empty'
    none.textContent = '未打标'
    tagBox.appendChild(none)
  }
  if (tagBox.childNodes.length) main.appendChild(tagBox)

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

let tagRefreshTimer = null

async function startTagAll() {
  const btn = $('libTag')
  const status = $('libTagStatus')
  btn.disabled = true
  btn.textContent = '打标中…'
  status.textContent = '正在扫描文件…'
  status.classList.remove('ok')
  try {
    const r = await window.api.tagAll()
    const parts = [`共扫描 ${r.total} 个文件`, `新打标 ${r.tagged}`]
    if (r.empty) parts.push(`无标签 ${r.empty}`)
    if (r.failed) parts.push(`失败 ${r.failed}`)
    if (r.already) parts.push(`已打标跳过 ${r.already}`)
    if (r.unrecognized) parts.push(`无法识别 ${r.unrecognized}`)
    status.textContent = parts.join(' · ')
    status.classList.toggle('ok', !r.failed)
    await loadFiles(currentSub.library)
  } catch (err) {
    status.textContent = '打标失败：' + humanizeError(err.message)
    status.classList.remove('ok')
  } finally {
    btn.disabled = false
    btn.textContent = '一键打标'
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
    $('maxConcurrent').value = settingsCache.concurrency || 2
    $('maxSpeed').value = settingsCache.maxSpeed ? settingsCache.maxSpeed : ''
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

$('subAdd').addEventListener('click', addSubscription)
$('subUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSubscription()
})
$('hnAdd').addEventListener('click', addHanimeSubscription)
$('hnUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addHanimeSubscription()
})
$('subSelectMissing').addEventListener('click', () => setSubSelection(true))
$('subSelectNone').addEventListener('click', () => setSubSelection(false))
$('subIgnore').addEventListener('click', ignoreSelected)
$('subDownload').addEventListener('click', startSubDownload)
$('summaryRefresh').addEventListener('click', () => loadSummary(true))

$('subSettingsClose').addEventListener('click', closeSubSettings)
$('subSettingsCancel').addEventListener('click', closeSubSettings)
$('subSettingsSave').addEventListener('click', saveSubSettings)
$('subIgnoreSelectAll').addEventListener('click', () => {
  for (const check of document.querySelectorAll('#subIgnoreList .sub-ignore-check')) check.checked = true
})
$('subIgnoreRemove').addEventListener('click', removeIgnoredSelected)
$('subSettingsModal').addEventListener('click', (e) => {
  if (e.target === $('subSettingsModal')) closeSubSettings()
})

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
  if (!$('subSettingsModal').classList.contains('hidden')) closeSubSettings()
  else if (!$('filterModal').classList.contains('hidden')) closeFilterModal()
  else if (!$('taskModal').classList.contains('hidden')) closeTaskModal()
})

$('taskModal').addEventListener('click', async (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  const task = btn.closest('.task')
  const id = [...tasks.entries()].find(([, r]) => r.el === task)?.[0]
  if (!id) return
  if (btn.dataset.act === 'cancel') {
    const ref = tasks.get(id)
    btn.disabled = true
    try {
      const ok = await window.api.cancel(id)
      // 任务已经结束时 cancel 返回 false，不能把按钮留在禁用状态
      if (!ok && ref) {
        setTaskInfo(ref, '任务已结束')
        setTaskRemove(ref)
      }
    } catch (err) {
      btn.disabled = false
      if (ref) setTaskInfo(ref, '取消失败：' + humanizeError(err.message))
    }
  } else if (btn.dataset.act === 'remove') {
    await removeTaskRecord(id)
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

$('libTag').addEventListener('click', startTagAll)
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
  const concurrency = Number($('maxConcurrent').value || 2)
  const speedRaw = $('maxSpeed').value.trim()
  const maxSpeed = speedRaw === '' ? 0 : Number(speedRaw)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    $('netStatus').textContent = '最大并行下载需为 1–10 的整数'
    $('netStatus').classList.remove('ok')
    return
  }
  if (!Number.isFinite(maxSpeed) || maxSpeed < 0) {
    $('netStatus').textContent = '下载限速需为非负数字，留空表示不限速'
    $('netStatus').classList.remove('ok')
    return
  }
  $('saveProxy').disabled = true
  try {
    settingsCache = await window.api.setSettings(Object.assign({}, settingsCache, {
      proxyMode: $('proxyMode').value,
      proxyUrl: $('proxyUrl').value.trim(),
      concurrency,
      maxSpeed
    }))
    $('maxConcurrent').value = settingsCache.concurrency || 2
    $('maxSpeed').value = settingsCache.maxSpeed ? settingsCache.maxSpeed : ''
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

window.api.onSubProgress((p) => {
  if (!subBusy) return
  const site = p.site === 'hanime' ? 'hanime' : 'bilibili'
  const els = progressEls(site)
  const loaded = Number(p.loaded) || 0
  const total = Number(p.total) || 0
  els.fill.style.width = (total ? Math.min(100, (loaded / total) * 100) : 0) + '%'
  els.text.textContent = total ? `已获取 ${loaded} / ${total} 个视频` : `已获取 ${loaded} 个视频`
})

window.api.onSummaryProgress((p) => {
  if (!summaryBusy) return
  const done = Number(p.done) || 0
  const total = Number(p.total) || 0
  $('summaryProgressFill').style.width = (total ? Math.min(100, (done / total) * 100) : 0) + '%'
  $('summaryProgressText').textContent = total
    ? `正在检查 ${done}/${total}${p.current ? '：' + p.current : ''}`
    : '正在检查订阅…'
})

window.api.onTagProgress((p) => {
  if (!p) return
  const status = $('libTagStatus')
  const extra = []
  if (p.tagged) extra.push(`已打标 ${p.tagged}`)
  if (p.empty) extra.push(`无标签 ${p.empty}`)
  if (p.failed) extra.push(`失败 ${p.failed}`)
  status.textContent = `正在打标 ${p.done}/${p.total}${p.current ? '（' + p.current + '）' : ''}` + (extra.length ? ' · ' + extra.join(' · ') : '')
  status.classList.remove('ok')
})

window.api.onTagsUpdated(() => {
  if (currentModule !== 'library' || $('libTag').disabled) return
  clearTimeout(tagRefreshTimer)
  tagRefreshTimer = setTimeout(() => loadFiles(currentSub.library), 600)
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
    ref.percent = Number(ev.percent) || 0
    updateOverallProgress()
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
window.api.appVersion().then((v) => {
  $('ver').textContent = v
  $('topbarVersion').textContent = 'v' + v
}).catch(() => { $('topbarVersion').textContent = 'v-' })
