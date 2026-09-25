// ============================================================================
// dsh-whale-widget 桌面版 —— Electron 主进程
// ----------------------------------------------------------------------------
// 一个透明、无边框、置顶的桌面小鲸鱼挂件窗口。
//
// 数据来源：DeepSeek 开放平台会话（见 lib/platform.js）—— **不需要 API key**，
// 今日消费直接取平台侧按小时/天分桶的真实账单，因此包含程序启动前的消费。
// 用户设置（userdata.json）存放在 EXE 同目录；不再保存任何密钥。
// ============================================================================
'use strict'

const { app, BrowserWindow, ipcMain, screen, Menu, shell } = require('electron')
const path = require('node:path')
const { createWhaleCore, isPeakTime } = require('./lib/core.js')
const { createPlatformClient, BASE, USAGE_URL } = require('./lib/platform.js')

const isDev = !app.isPackaged
// portable 单文件版：PORTABLE_EXECUTABLE_DIR 指向便携 EXE 所在目录；
// 安装版 / 开发态回退到 exe 目录 / 项目目录。
const exeDir =
  process.env.PORTABLE_EXECUTABLE_DIR ||
  (isDev ? app.getAppPath() : path.dirname(app.getPath('exe')))

const core = createWhaleCore({ dataFile: path.join(exeDir, 'userdata.json') })
const platform = createPlatformClient({ headless: true })

// 固定会话目录：默认值随「包名」变化（开发态用 package.json 的 name、打包后用
// productName），会导致**开发时登录的会话在打包版里失效**。这里显式钉死，
// 让开发态与打包版共用同一份开放平台登录态（也便于定位问题）。
// 必须在 app ready 之前设置。
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'DeepSeekWhaleWidget'))
} catch (err) {}

let win = null
let dragState = null
let pendingMove = null
let moveTimer = null

const WINDOW_W = 560
const WINDOW_H = 840

// 平台数据缓存：避免 UI 频繁触发页面加载（平台侧请求本身也做了节流）
const DATA_TTL_MS = 30000
let dataCache = null // { at, payload }
let dataInFlight = null

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// ---------------------------------------------------------------------------
// 开机自启
// ---------------------------------------------------------------------------
// ★ portable 单文件版是自解压的：process.execPath 指向**临时解压目录**，
//   每次启动都不同，拿它注册自启必然失效。electron-builder 为此注入了
//   PORTABLE_EXECUTABLE_FILE（真 EXE 全路径，见其 portable.nsi 模板）。
function autoStartPath() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return process.env.PORTABLE_EXECUTABLE_FILE
  if (app.isPackaged) return app.getPath('exe')
  return null // 开发态：不能把 electron.exe 注册成自启项
}

function getAutoStart() {
  const p = autoStartPath()
  if (!p) return { supported: false, enabled: false, reason: '开发态不可用' }
  try {
    const s = app.getLoginItemSettings({ path: p })
    return { supported: true, enabled: !!s.openAtLogin, path: p }
  } catch (err) {
    return { supported: false, enabled: false, reason: String(err.message || err) }
  }
}

function setAutoStart(enabled) {
  const p = autoStartPath()
  if (!p) return { ok: false, error: '开发态不支持开机自启' }
  try {
    if (enabled) {
      app.setLoginItemSettings({ openAtLogin: true, path: p })
    } else {
      // 显式清除，避免残留注册表项
      app.setLoginItemSettings({ openAtLogin: false, path: p })
    }
    const now = getAutoStart()
    return { ok: true, enabled: now.enabled }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
}

// ---------------------------------------------------------------------------
// 对外跳转（白名单）
// ---------------------------------------------------------------------------
// ★ 只允许打开平台自己的固定地址；绝不把渲染层传来的任意字符串交给系统打开
const ALLOWED_URLS = new Set([USAGE_URL, BASE + '/top_up', BASE + '/api_keys'])

function openAllowed(url) {
  if (!ALLOWED_URLS.has(url)) return { ok: false, error: 'URL 不在白名单内' }
  shell.openExternal(url).catch(() => {})
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 数据获取（带缓存与并发去重）
// ---------------------------------------------------------------------------
function fetchData(force) {
  const now = Date.now()
  if (!force && dataCache && now - dataCache.at < DATA_TTL_MS) {
    return Promise.resolve(dataCache.payload)
  }
  if (dataInFlight) return dataInFlight
  dataInFlight = platform
    .getSnapshot()
    .then((p) => {
      if (p && p.ok) {
        // 附上峰谷标记（气泡文案用），与数据源无关
        p.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
        dataCache = { at: Date.now(), payload: p }
      }
      return p
    })
    .catch((err) => ({
      ok: false,
      code: 'ERROR',
      error: String((err && err.message) || err).slice(0, 200),
    }))
    .finally(() => {
      dataInFlight = null
    })
  return dataInFlight
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
// Windows 透明（分层）窗口在 setPosition 时存在尺寸漂移的已知问题：
// 每次移动窗口都会“长大”几像素（连续拖动时肉眼可见地抽搐+放大）。
// 因此移动一律用 setBounds 显式钉住宽高；拖动位移用 16ms 帧合并节流。
function moveWindowTo(x, y) {
  if (!win) return
  try {
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: WINDOW_W, height: WINDOW_H })
  } catch (err) {}
}

function applyPendingMove() {
  if (!pendingMove) return
  const dx = pendingMove.dx
  const dy = pendingMove.dy
  pendingMove = null
  if (!win || !dragState) return
  moveWindowTo(dragState.baseX + dx, dragState.baseY + dy)
}

function createWindow() {
  win = new BrowserWindow({
    width: WINDOW_W,
    height: WINDOW_H,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setSkipTaskbar(true)

  // 恢复上次窗口位置（限制在工作区内；用 setBounds 钉住尺寸防漂移）
  const pos = core.getWinPos()
  if (pos) {
    try {
      const wa = screen.getPrimaryDisplay().workArea
      const x = clamp(pos.x, wa.x, wa.x + wa.width - WINDOW_W)
      const y = clamp(pos.y, wa.y, wa.y + wa.height - WINDOW_H)
      moveWindowTo(x, y)
    } catch (err) {}
  }

  win.on('close', () => {
    try {
      const [x, y] = win.getPosition()
      core.setWinPos({ x, y })
    } catch (err) {}
  })

  win.on('closed', () => {
    win = null
  })

  win.loadFile(path.join(app.getAppPath(), 'renderer', 'index.html'))

  // 冒烟测试：electron . --smoke —— 启动 5 秒后自动退出
  if (process.argv.includes('--smoke')) {
    win.webContents.on('console-message', (e, level, message) => {
      console.log('[renderer:' + level + ']', message)
    })
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(
          '({ api: !!window.whaleAPI, widget: !!window.__dshWhaleWidget, root: !!document.querySelector(".dshwv-root"), img: !!document.querySelector(".dshwv-img"), autostartRow: !!document.querySelector(".dshwv-autostart"), loginRow: !!document.querySelector(".dshwv-login") })'
        )
        console.log('SMOKE RENDERER: ' + JSON.stringify(r))
      } catch (err) {
        console.log('SMOKE RENDERER ERROR: ' + err.message)
      }
      console.log('SMOKE OK: window created, size=' + JSON.stringify(win.getSize()) + ' pos=' + JSON.stringify(win.getPosition()))
      app.quit()
    }, 5000)
  }
}

function animateWindowTo(tx, ty) {
  if (!win) return
  const [x, y] = win.getPosition()
  const steps = 8
  let i = 0
  const timer = setInterval(() => {
    i++
    const t = i / steps
    const ease = 1 - Math.pow(1 - t, 3)
    moveWindowTo(x + (tx - x) * ease, y + (ty - y) * ease)
    if (i >= steps) clearInterval(timer)
  }, 18)
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------
function showContextMenu(pos) {
  if (!win) return
  const auto = getAutoStart()
  const items = [
    { label: '查看用量详情', click: () => openAllowed(USAGE_URL) },
    {
      label: auto.supported && auto.enabled ? '开机自启 ✓' : '开机自启',
      enabled: auto.supported,
      click: () => {
        const next = !(auto.supported && auto.enabled)
        const r = setAutoStart(next)
        if (win && !win.isDestroyed()) {
          win.webContents.send('whale:autostartChanged', { enabled: !!(r && r.enabled) })
        }
      },
    },
    { label: '设置…', click: () => win && !win.isDestroyed() && win.webContents.send('whale:openSettings') },
    { label: '重新登录开放平台', click: () => platform.openLogin().catch(() => {}) },
    { type: 'separator' },
    { label: '退出小鲸鱼', click: () => app.quit() },
  ]
  const menu = Menu.buildFromTemplate(items)
  const opts = { window: win }
  if (pos && isFinite(pos.x) && isFinite(pos.y)) {
    opts.x = Math.round(pos.x)
    opts.y = Math.round(pos.y)
  }
  menu.popup(opts)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('whale:getConfig', () => {
  const cfg = core.getConfig()
  return { ...cfg, autoStart: getAutoStart() }
})
ipcMain.handle('whale:saveConfig', (e, cfg) => core.saveConfig(cfg))
ipcMain.handle('whale:fetchData', (e, force) => fetchData(!!force))
ipcMain.handle('whale:openLogin', () => platform.openLogin().catch((err) => ({ ok: false, error: String(err) })))
ipcMain.handle('whale:openDetails', () => openAllowed(USAGE_URL))
ipcMain.handle('whale:contextMenu', (e, pos) => {
  showContextMenu(pos)
  return { ok: true }
})
ipcMain.handle('whale:setAutoStart', (e, enabled) => setAutoStart(!!enabled))
ipcMain.handle('whale:getAutoStart', () => getAutoStart())
ipcMain.handle('whale:quit', () => app.quit())

// 鼠标穿透：透明区域忽略鼠标事件（forward 保留 mousemove 供渲染层检测悬停）
ipcMain.on('whale:setIgnore', (e, ignore) => {
  if (win) {
    try {
      win.setIgnoreMouseEvents(!!ignore, { forward: true })
    } catch (err) {}
  }
})

// 拖拽窗口：渲染层上报相对起点位移，主进程按 16ms 帧合并节流移动窗口
ipcMain.handle('whale:moveWindow', (e, dx, dy) => {
  if (!win) return null
  const px = Number(dx)
  const py = Number(dy)
  if (!isFinite(px) || !isFinite(py)) return null
  pendingMove = { dx: px, dy: py }
  if (!dragState) {
    try {
      const [wx, wy] = win.getPosition()
      dragState = { baseX: wx, baseY: wy }
    } catch (err) {
      return null
    }
  }
  if (!moveTimer) {
    moveTimer = setInterval(applyPendingMove, 16)
  }
  return null
})

// 拖拽结束：四分之一屏边缘吸附 + 限制在工作区内
ipcMain.handle('whale:dragEnd', () => {
  if (!win) return { h: null, v: null }
  if (moveTimer) {
    clearInterval(moveTimer)
    moveTimer = null
  }
  applyPendingMove() // 应用最后一次位移，保证吸附计算基于最终位置
  dragState = null
  try {
    const [wx, wy] = win.getPosition()
    const [ww, wh] = win.getSize()
    const bounds = win.getBounds()
    const disp = screen.getDisplayMatching(bounds)
    const wa = disp.workArea
    const centerX = wx + ww / 2
    const centerY = wy + wh / 2
    let hSnap = null
    let vSnap = null
    if (centerX < wa.x + wa.width / 4) hSnap = 'left'
    else if (centerX > wa.x + (wa.width * 3) / 4) hSnap = 'right'
    if (centerY < wa.y + wa.height / 4) vSnap = 'top'
    else if (centerY > wa.y + (wa.height * 3) / 4) vSnap = 'bottom'
    let tx = clamp(wx, wa.x, wa.x + wa.width - ww)
    let ty = clamp(wy, wa.y, wa.y + wa.height - wh)
    if (hSnap === 'left') tx = wa.x
    else if (hSnap === 'right') tx = wa.x + wa.width - ww
    if (vSnap === 'top') ty = wa.y
    else if (vSnap === 'bottom') ty = wa.y + wa.height - wh
    animateWindowTo(tx, ty)
    core.setWinPos({ x: tx, y: ty })
    return { h: hSnap, v: vSnap }
  } catch (err) {
    return { h: null, v: null }
  }
})

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    try {
      platform.destroy()
    } catch (err) {}
    app.quit()
  })
}
