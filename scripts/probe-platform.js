// ============================================================================
// scripts/probe-platform.js —— P0 可行性验证
// ----------------------------------------------------------------------------
// 验证「用 Electron 持久化会话窗口读取开放平台数据」是否可行。
//   1. 复用 persist:deepseek 分区 —— 登录一次长期有效
//   2. 用 CDP(Network 域) 截获 SPA 自己发出的接口响应
//      （不自己拼 Authorization、不碰 token，WAF 挑战由页面自动完成）
//
// 两处关键实现细节（踩过坑）：
//   a. 响应体必须在 Network.loadingFinished 之后取 —— 在 responseReceived
//      （仅响应头到达）就取会报 "No data found for resource with given
//      identifier"，usage/* 这类接口必失败。
//   b. 不在页面里发探测请求 —— 自己的请求会被 CDP 一并截获、污染结果。
//      登录判定改成看页面 URL（平台未登录会跳 /sign_in），零请求。
//
// 运行：
//   npx electron scripts/probe-platform.js           # 已登录则静默取数
//   npx electron scripts/probe-platform.js --show    # 需要登录时显示窗口
//
// 输出：控制台 + probe-out.json（接口数据与结构；**不含凭据类接口的响应体**）
// 注意：用 `npx electron <script>` 运行时 app 名是 "Electron"，
//       故 userData 落在 %APPDATA%\Electron（打包后才会用本包名）。
// ============================================================================
'use strict'

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 复用 lib/platform.js 的常量：各自硬编码一份的话，lib 里改了分区名或路径后
// 探测脚本仍跑在旧值上，而「截获 0 条」这类结果很难被发现是分区不一致导致的
const { PARTITION, BASE, USAGE_URL } = require('../lib/platform.js')
const OUT = path.join(__dirname, '..', 'probe-out.json')

const SHOW = process.argv.includes('--show')
const LOGIN_WAIT_MS = 12 * 60 * 1000

// 从平台前端 chunk 中提取的真实接口
const TARGET_API = /\/api\/v0\/(users\/get_user_summary|users\/get_api_keys|usage\/by_api_key\/(cost|amount))(\?|$)/

const collected = []
let win = null

function log(...a) {
  console.log('[probe]', ...a)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// CDP 截获：responseReceived 登记 → loadingFinished 后取体
// ---------------------------------------------------------------------------
function attachNetworkCapture(wc) {
  const dbg = wc.debugger
  try {
    dbg.attach('1.3')
  } catch (err) {
    log('✘ debugger.attach 失败:', err.message)
    return false
  }
  const pending = new Map() // requestId -> {url,status}

  dbg.on('message', (event, method, params) => {
    if (method === 'Network.responseReceived') {
      const res = params.response || {}
      const url = res.url || ''
      if (TARGET_API.test(url)) {
        pending.set(params.requestId, { url, status: res.status, fromCache: !!res.fromDiskCache })
      }
    } else if (method === 'Network.loadingFinished') {
      const info = pending.get(params.requestId)
      if (!info) return
      pending.delete(params.requestId)
      // 到这一步响应体才完整
      dbg
        .sendCommand('Network.getResponseBody', { requestId: params.requestId })
        .then(({ body }) => {
          let json = null
          let rawHead = null
          try {
            json = JSON.parse(body)
          } catch (err) {
            rawHead = String(body).slice(0, 300)
          }
          collected.push({ ...info, bytes: body.length, json, rawHead })
          log(`✔ ${info.url.replace(BASE, '')} → HTTP ${info.status}, ${body.length} 字节, ${json ? 'code=' + json.code : '非JSON'}`)
        })
        .catch((err) => {
          collected.push({ ...info, bytes: 0, error: err.message })
          log(`✘ 取体失败 ${info.url.replace(BASE, '')} → ${err.message}`)
        })
    } else if (method === 'Network.loadingFailed') {
      pending.delete(params.requestId)
    }
  })

  // 放大缓冲，避免大响应被逐出
  dbg
    .sendCommand('Network.enable', {
      maxTotalBufferSize: 200 * 1024 * 1024,
      maxResourceBufferSize: 100 * 1024 * 1024,
      maxPostDataSize: 1024 * 1024,
    })
    .catch(() => dbg.sendCommand('Network.enable'))
  log('✔ CDP Network 已启用（大缓冲）')
  return true
}

// 只读页面状态，不发请求（避免污染截获）
async function pageState(wc) {
  try {
    return await wc.executeJavaScript(
      '({ href: location.href, path: location.pathname, title: document.title })',
      true
    )
  } catch (err) {
    return { href: '', path: '', title: '', error: err.message }
  }
}

// 平台未登录会跳转到 /sign_in
function isLoggedIn(st) {
  return !!st && !!st.path && !st.path.startsWith('/sign_in') && !st.path.startsWith('/login')
}

// ---------------------------------------------------------------------------
async function run() {
  session.fromPartition(PARTITION) // 确保分区存在
  log(`分区 ${PARTITION}；show=${SHOW}`)

  win = new BrowserWindow({
    width: 1280,
    height: 880,
    show: false,
    title: 'DeepSeek 平台数据探测',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 截获启用失败就直接终止：否则会继续跑完（未登录时还会在 --show 下白等 12 分钟），
  // 最后写出一个「截获 0 条」的结果文件，容易被误读成「接口没有数据」
  if (!attachNetworkCapture(win.webContents)) {
    log('✘ 无法启用 CDP 截获，终止探测')
    win.destroy()
    return finish('capture-failed')
  }

  log('加载', USAGE_URL)
  await win.loadURL(USAGE_URL)
  await sleep(5000)

  let st = await pageState(win.webContents)
  log('当前页:', st.path)

  if (!isLoggedIn(st)) {
    log('⚠ 未登录（被重定向到 ' + st.path + '）')
    if (!SHOW) {
      log('请加 --show 重跑以显示登录窗口')
      win.destroy()
      return finish('logged-out')
    }
    log('已显示窗口，请在窗口内登录（最多 12 分钟）…')
    win.show()
    win.focus()
    const deadline = Date.now() + LOGIN_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(3000)
      if (win.isDestroyed()) break
      st = await pageState(win.webContents)
      if (isLoggedIn(st)) {
        log('✔ 检测到已登录:', st.path)
        break
      }
    }
  } else {
    log('✔ 已是登录态（会话持久化生效）')
  }

  if (!isLoggedIn(st)) {
    win.destroy()
    return finish('logged-out-timeout')
  }

  // 干净地重新加载用量页，触发 SPA 自身的接口请求
  collected.length = 0
  log('重新加载用量页以截获 SPA 请求…')
  await win.loadURL(USAGE_URL + '?p=' + Date.now())
  await sleep(14000)

  st = await pageState(win.webContents)
  log('当前页:', st.path, '|', st.title)

  win.destroy()
  return finish('logged-in', st)
}

// ---------------------------------------------------------------------------
function finish(state, st) {
  const okList = collected.filter((c) => c.json && c.json.code === 0)
  const summary = {
    at: new Date().toISOString(),
    loginState: state,
    page: st || null,
    totalCaptured: collected.length,
    successCaptured: okList.length,
    endpoints: collected.map((c) => ({
      path: c.url.replace(BASE, ''),
      http: c.status,
      bytes: c.bytes,
      code: c.json ? c.json.code : null,
      bizKeys: c.json && c.json.data && c.json.data.biz_data ? Object.keys(c.json.data.biz_data) : null,
      error: c.error || null,
    })),
    // ★ 落盘时排除 users/get_api_keys 的响应体：它含 API key 名称与掩码 id，
    //   属凭据相关信息（文件头承诺「不含凭据类接口的响应体」，这里要真的做到）
    data: collected
      .filter((c) => c.json && !/users\/get_api_keys/.test(c.url))
      .map((c) => ({ path: c.url.replace(BASE, ''), json: c.json })),
  }
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8')

  console.log('\n============ 结果汇总 ============')
  console.log('登录态:', state)
  console.log('截获总数:', collected.length, '| 成功(code=0):', okList.length)
  for (const e of summary.endpoints) {
    console.log(`  • ${e.path}`)
    console.log(`      HTTP ${e.http} · ${e.bytes} 字节 · code=${e.code}${e.error ? ' · ' + e.error : ''}`)
    if (e.bizKeys) console.log(`      biz_data: ${e.bizKeys.join(', ')}`)
  }
  console.log('明细已写入:', OUT)
  console.log('==================================\n')
}

app.whenReady().then(() =>
  run()
    .catch((err) => console.error('[probe] 异常:', err))
    .finally(() => app.quit())
)
app.on('window-all-closed', () => app.quit())
