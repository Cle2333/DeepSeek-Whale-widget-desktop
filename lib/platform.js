// ============================================================================
// dsh-whale-widget 桌面版 —— 开放平台会话数据层
// ----------------------------------------------------------------------------
// 用「隐藏窗口 + 用户已登录的会话」读取 DeepSeek 开放平台数据，
// 因此**不需要 API key**，且能读到程序启动前的消费（平台侧按天分桶的真实账单）。
//
// 安全设计：凭据只在页面内存中流转
//   1. 首次加载 /usage，让平台 SPA 自己发起带 Authorization 的请求
//   2. 用 Page.addScriptToEvaluateOnNewDocument 在主世界注入助手，
//      被动截获 SPA 请求里的 Authorization 头；凭据存在助手**闭包**内，
//      **不以 window 属性暴露**（页面其他脚本读不到原文）
//   3. 我们自己的取数请求在**页面上下文内** fetch —— 凭据不落盘、
//      不写入 userdata.json、不返回给调用方
//
// 唯一的例外（已实测确认非必需，仅作兜底）：CDP 路径会在主进程内存里
// 短暂持有凭据原文并回注给页面助手；不会写盘。
//
// 实测接口（详见 Obsidian 项目笔记）：
//   GET /api/v0/users/get_user_summary        余额 / 赠送余额 / 生命周期总消费
//   GET /api/v0/usage/by_api_key/cost         按天分桶的消费金额（bucket=86400）
//
// 注意：token 由平台前端维护，可能随版本变化；任何一步失败都返回
// { ok:false, code, error }，由调用方降级处理，不抛到 UI。
// ============================================================================
'use strict'

const { BrowserWindow } = require('electron')

const PARTITION = 'persist:deepseek'
const BASE = 'https://platform.deepseek.com'
const USAGE_PATH = '/usage'
const USAGE_URL = BASE + USAGE_PATH
const LOGIN_PATH = '/sign_in'
// 会话目录名：main.js 与各测试脚本共用同一个常量，
// 任一处漏改都会出现「脚本能读到登录态、应用读不到」这类难查的问题
const APP_DATA_DIR_NAME = 'DeepSeekWhaleWidget'

const TZ_SEC = () => -new Date().getTimezoneOffset() * 60

// 请求节流：串行 + 最小间隔，避免给平台造成压力
const MIN_GAP_MS = 400

// ---------------------------------------------------------------------------
// 注入到页面主世界的助手（在页面脚本之前运行）
// ---------------------------------------------------------------------------
const PAGE_HELPER = `(() => {
  if (window.__dshApi) return
  // 凭据只保存在这个闭包里，**不挂到 window** ——
  // 页面主世界的其他脚本（第三方 SDK / 被注入的 XSS）读不到凭据原文，
  // 只能通过 get() 取数（而它们本来就持有自己那份凭据，不算扩大暴露面）
  let auth = null
  let source = null
  let hits = 0
  const errors = []
  let lastUrl = null

  const pickHeader = (h, name) => {
    if (!h) return null
    try {
      if (typeof h.get === 'function') return h.get(name)
      if (Array.isArray(h)) {
        for (const kv of h) if (kv && String(kv[0]).toLowerCase() === name) return kv[1]
        return null
      }
      for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k]
    } catch (e) { errors.push('pick:' + e.message) }
    return null
  }
  // 只认平台自己的接口请求：页面里的第三方 SDK / 埋点也会带 authorization 头，
  // 若不加区分地捕获，第一个撞上的长值会被当成凭据，整条取数链路报废
  const isApiUrl = (u) => {
    try {
      const x = new URL(u, location.href)
      if (x.origin !== location.origin) return false
      return x.pathname.indexOf('/api/') === 0 || x.pathname.indexOf('/auth-api/') === 0
    } catch (e) { return false }
  }
  const adopt = (v, src) => {
    // 允许新凭据覆盖旧凭据：换账号 / 会话过期后重登 / CDP 兜底回注时平台会下发
    // 新的 Authorization，只认第一次捕获的值会让助手一直拿失效凭据取数
    if (v && typeof v === 'string' && v.length > 8 && v !== auth) {
      auth = v
      source = src || null
      hits++
    }
  }

  // 1) 截获 window.fetch 的请求头（只在平台接口请求上生效）
  const origFetch = window.fetch
  window.fetch = function (input, init) {
    try {
      const target = new URL(input && input.url ? input.url : String(input), location.href)
      lastUrl = target.toString()
      if (isApiUrl(target)) {
        const fromInit = pickHeader(init && init.headers, 'authorization')
        const fromReq = input && typeof input === 'object' && input.headers
          ? pickHeader(input.headers, 'authorization') : null
        adopt(fromInit || fromReq, 'fetch')
      }
    } catch (e) { errors.push('fetch:' + e.message) }
    return origFetch.apply(this, arguments)
  }

  // 2) 截获 XMLHttpRequest 的请求头（同样只认平台接口，靠 open() 记下的 URL 判断）
  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__dshUrl = new URL(url, location.href).toString() } catch (e) { this.__dshUrl = null }
    return origOpen.apply(this, arguments)
  }
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (String(k).toLowerCase() === 'authorization' && this.__dshUrl && isApiUrl(this.__dshUrl)) {
        adopt(v, 'xhr')
      }
    } catch (e) {}
    return origSetHeader.apply(this, arguments)
  }

  // 3) 对外的唯一入口：只暴露「能不能用」与「取数」，
  //    **不暴露凭据本身**（读 window 属性拿不到 token）
  window.__dshApi = {
    ready: () => !!auth,
    info: () => ({ ready: !!auth, hits, source, errors: errors.slice(0, 5), lastUrl }),
    // CDP 兜底用：SPA 不走 fetch/XHR 包装时，由主进程把凭据回注进来
    setAuth: (v, src) => adopt(v, src),
    get: async (apiPath, query) => {
      if (!auth) throw new Error('NO_AUTH')
      let u = apiPath
      if (query) u += '?' + new URLSearchParams(query).toString()
      const r = await origFetch.call(window, u, {
        headers: { accept: 'application/json', authorization: auth },
        credentials: 'include',
      })
      const txt = await r.text()
      let json = null
      try { json = JSON.parse(txt) } catch (e) { json = { __raw: txt.slice(0, 300) } }
      return { status: r.status, json }
    },
  }
})()`

// ---------------------------------------------------------------------------
// 导航围栏（详情窗口与平台隐藏窗口共用同一份实现，避免安全策略双份维护分叉）
// ---------------------------------------------------------------------------
// hostname 用 URL 解析比对，**不能用字符串 includes** ——
// 否则 https://platform.deepseek.com.evil.com 会骗过判断
function isPlatformUrl(u) {
  try {
    const x = new URL(u)
    return x.protocol === 'https:' && x.hostname === new URL(BASE).hostname
  } catch (err) {
    return false
  }
}

// 给「能看到登录态」的窗口统一加围栏：
//   1. 不允许页面开新窗口（window.open / target=_blank / 弹窗）
//   2. 不允许顶层导航到站外（点站内链接仍可正常用）
//   3. 不允许挂 webview
function lockDownWindow(wc, label, onBlocked) {
  try {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  } catch (err) {}
  const guard = (e, url) => {
    if (!isPlatformUrl(url)) {
      e.preventDefault()
      const msg = '[' + (label || 'window') + '] 已拦截站外导航: ' + String(url).slice(0, 160)
      if (typeof onBlocked === 'function') onBlocked(msg)
      else console.log(msg)
    }
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
  wc.on('will-attach-webview', (e) => e.preventDefault())
}

// ---------------------------------------------------------------------------
function createPlatformClient({ headless = true } = {}) {
  let win = null
  let ready = false
  let lastCallAt = 0
  let lastError = null
  let helperInstalled = false
  // 用户正在登录窗口里填写时置真：期间**禁止**任何导航该窗口的操作，
  // 否则 60 秒轮询会把用户正填的表单刷掉（首次登录几乎无法完成）
  let userLoggingIn = false
  let loginPollTimer = null

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function throttle() {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt)
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
  }

  // -------------------------------------------------------------------------
  // 安全围栏：本窗口持有登录态，绝不允许页面开新窗口或导航到站外
  // （实现见模块顶部的 lockDownWindow，与 main.js 的详情窗口共用）
  // -------------------------------------------------------------------------
  function lockDown(wc) {
    lockDownWindow(wc, 'platform', (msg) => {
      lastError = msg
    })
  }

  // -------------------------------------------------------------------------
  // 窗口生命周期
  // -------------------------------------------------------------------------
  function createWindow({ show = false } = {}) {
    // 会话分区由 webPreferences.partition 建立，无需显式 fromPartition
    win = new BrowserWindow({
      width: 1180,
      height: 820,
      show,
      title: 'DeepSeek 开放平台',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win.on('closed', () => {
      win = null
      ready = false
      helperInstalled = false
    })
    lockDown(win.webContents)
    return win
  }

  // 在页面脚本之前注入助手。
  // ★ 两个必须遵守的顺序约束：
  //   1. Page.enable 在「尚无文档」的 webContents 上会**永久挂起**（实测），
  //      所以先 loadURL('about:blank') 让 Page 域可用；
  //   2. addScriptToEvaluateOnNewDocument 只对**随后加载**的文档生效，
  //      因此注入必须在目标页 loadURL 之前 await 完成。
  async function ensureHelper(wc) {
    if (helperInstalled) return true
    try {
      await wc.loadURL('about:blank') // 给 Page 域一个可用文档
      // 已附加时再 attach 会抛错，且会让该窗口此后永久 HELPER_FAILED
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    } catch (err) {
      lastError = 'debugger 附加失败: ' + err.message
      return false
    }
    try {
      // 1) 主世界注入助手（凭据捕获 + 页面内取数）
      await wc.debugger.sendCommand('Page.enable')
      await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPER })
      // 2) CDP 兜底：万一 SPA 不走 fetch/XHR 包装，仍能从请求头拿到 Authorization
      await wc.debugger.sendCommand('Network.enable')
      wc.debugger.on('message', (event, method, params) => {
        if (method !== 'Network.requestWillBeSent') return
        try {
          const url = (params.request && params.request.url) || ''
          if (!url.includes('/api/')) return
          const hs = (params.request && params.request.headers) || {}
          for (const k of Object.keys(hs)) {
            if (k.toLowerCase() === 'authorization') {
              const v = String(hs[k])
              if (v.length > 8) {
                // 把凭据回注给页面助手（存进它的闭包），之后所有请求都在页面内发出
                wc.executeJavaScript(
                  `(() => { const A = window.__dshApi; if (A) A.setAuth(${JSON.stringify(v)}, 'cdp') })()`,
                  true
                ).catch(() => {})
              }
              break
            }
          }
        } catch (e) {}
      })
      helperInstalled = true
      return true
    } catch (err) {
      lastError = '注入助手失败: ' + err.message
      // 失败要回滚 attach：否则 helperInstalled 仍为 false，下次再 attach 会抛错，
      // 该窗口此后永久 HELPER_FAILED（只能关窗恢复）
      try {
        if (wc.debugger.isAttached()) wc.debugger.detach()
      } catch (e) {}
      return false
    }
  }

  async function pageState() {
    if (!win || win.isDestroyed()) return { path: '', href: '' }
    try {
      return await win.webContents.executeJavaScript(
        `(() => {
            const A = window.__dshApi
            const i = A ? A.info() : null
            return { path: location.pathname, href: location.href, title: document.title,
                     hasHelper: !!A,
                     ready: !!(i && i.ready),
                     source: (i && i.source) || null,
                     hits: (i && i.hits) || 0,
                     errs: (i && i.errors) || [],
                     lastUrl: (i && i.lastUrl) || null }
          })()`,
        true
      )
    } catch (err) {
      return { path: '', href: '', error: err.message }
    }
  }

  // 加载页面并等待助手截获到凭据
  async function loadAndWait({ url = USAGE_URL, waitMs = 15000, show = false } = {}) {
    if (!win || win.isDestroyed()) createWindow({ show })
    const injected = await ensureHelper(win.webContents)
    if (!injected) return { ok: false, code: 'HELPER_FAILED', error: lastError }
    await win.loadURL(url)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(700)
      const st = await pageState()
      if (st.path && st.path.startsWith(LOGIN_PATH)) return { ok: false, code: 'NEED_LOGIN', state: st }
      if (st.ready) {
        ready = true
        return { ok: true, state: st }
      }
    }
    const st = await pageState()
    return { ok: false, code: 'NO_CREDENTIAL', state: st }
  }

  async function ensureReady() {
    if (ready && win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      const st = await pageState()
      if (st.ready) return { ok: true }
    }
    // 用户正在登录窗口里填写：绝不导航那个窗口（否则表单会被刷掉）
    if (userLoggingIn) return { ok: false, code: 'LOGGING_IN' }
    return loadAndWait({ show: !headless })
  }

  function stopLoginWatch() {
    if (loginPollTimer) {
      clearInterval(loginPollTimer)
      loginPollTimer = null
    }
    userLoggingIn = false
  }

  // 打开登录窗口（用户手动登录用）
  async function openLogin() {
    if (!win || win.isDestroyed()) createWindow({ show: true })
    win.show()
    win.focus()
    // 判断是否已在平台站点：不能只看 getURL() 真值 ——
    // ensureHelper 会把窗口停在 'about:blank'，那是真值但没有任何页面
    const cur = win.webContents.getURL() || ''
    let onPlatform = false
    try {
      onPlatform = new URL(cur).hostname === new URL(BASE).hostname
    } catch (err) {}
    if (!onPlatform) {
      try {
        await win.loadURL(BASE + LOGIN_PATH)
      } catch (err) {
        return { ok: false, error: '登录页加载失败: ' + String((err && err.message) || err).slice(0, 160) }
      }
    }
    // 标记登录中：期间 ensureReady 只读不导航；轮询到凭据就解除
    userLoggingIn = true
    if (loginPollTimer) clearInterval(loginPollTimer)
    loginPollTimer = setInterval(async () => {
      if (!win || win.isDestroyed()) {
        stopLoginWatch()
        return
      }
      const st = await pageState()
      if (st && st.ready) {
        ready = true
        stopLoginWatch()
        return
      }
      // 已离开登录页也视为流程结束（登录成功或被取消）
      if (st && st.path && !st.path.startsWith(LOGIN_PATH)) stopLoginWatch()
    }, 2000)
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // 取数（在页面上下文内执行，token 不出页面）
  // -------------------------------------------------------------------------
  async function pageCall(apiPath, query) {
    // ensureReady → loadAndWait 内部的 loadURL 可能 reject（离线 / DNS / 证书 /
    // 被导航围栏拦下），必须一并兜住，否则异常穿透到调用方，与文件头
    // 「任何一步失败都返回 { ok:false, code, error }」的约定不符
    let r
    try {
      r = await ensureReady()
    } catch (err) {
      return { ok: false, code: 'SESSION_FAILED', error: String((err && err.message) || err).slice(0, 200) }
    }
    if (!r.ok) {
      // 保留具体失败原因（HELPER_FAILED 时 r.error 里有 debugger/注入的细节），
      // 与文件头「任何一步失败都返回 { ok:false, code, error }」一致
      return {
        ok: false,
        code: r.code,
        error: '平台会话不可用（' + r.code + '）' + (r.error ? ': ' + r.error : ''),
      }
    }
    await throttle()
    try {
      const res = await win.webContents.executeJavaScript(
        `window.__dshApi.get(${JSON.stringify(apiPath)}, ${JSON.stringify(query || null)})`,
        true
      )
      if (!res || typeof res !== 'object') return { ok: false, code: 'BAD_RESULT', error: '页面返回异常' }
      const j = res.json || {}
      if (j.code !== 0) {
        const code = j.code === 40002 || j.code === 40003 ? 'AUTH_EXPIRED' : 'API_ERROR'
        // 带上 HTTP status 与原始片段：非 JSON 响应（WAF 挑战页 / 登录页 HTML）时
        // j.code 是 undefined，只报 "code undefined" 排障毫无线索
        const detail = j.msg || (j.__raw ? String(j.__raw).slice(0, 120) : 'code ' + j.code)
        return {
          ok: false,
          code,
          error: 'HTTP ' + res.status + ' ' + detail,
          apiCode: j.code,
          httpStatus: res.status,
        }
      }
      return { ok: true, biz: (j.data && j.data.biz_data) || null }
    } catch (err) {
      return { ok: false, code: 'CALL_FAILED', error: String(err && err.message || err).slice(0, 200) }
    }
  }

  // 余额 + 赠送余额 + 生命周期总消费
  async function getSummary() {
    const r = await pageCall('/api/v0/users/get_user_summary')
    if (!r.ok) return r
    const biz = r.biz || {}
    const wallets = Array.isArray(biz.normal_wallets) ? biz.normal_wallets : []
    const bonus = Array.isArray(biz.bonus_wallets) ? biz.bonus_wallets : []
    const costs = Array.isArray(biz.total_costs) ? biz.total_costs : []
    const pick = (arr) => arr.find((w) => w && w.currency === 'CNY') || arr[0] || null
    const main = pick(wallets)
    if (!main) {
      // 字段改名 / 账号无钱包 / 接口结构变化：必须显式失败。
      // 否则调用方按「成功」处理，界面只显示 ¥ -- 且没有任何提示，问题被静默吞掉
      return { ok: false, code: 'SHAPE', error: 'get_user_summary 缺少 normal_wallets' }
    }
    const balance = Number(main.balance)
    if (!isFinite(balance)) {
      return { ok: false, code: 'SHAPE', error: 'normal_wallets.balance 不是有效数值' }
    }
    const gift = pick(bonus)
    const tot = pick(costs)
    const totalCost = tot ? Number(tot.amount) : NaN
    return {
      ok: true,
      currency: main.currency || 'CNY',
      balance,
      bonusBalance: gift ? Number(gift.balance) || 0 : 0,
      // 总消费仅用于展示，非法值给 0 而不是 NaN（避免界面出现 ¥ NaN）
      totalCost: isFinite(totalCost) ? totalCost : 0,
    }
  }

  // 今日消费（平台侧真实账单，含程序启动前的部分）
  // 不加 api_key_tracking_id 时返回账号下所有 key 的汇总
  //
  // ★ 关键陷阱：接口的分桶粒度会**随查询区间自动变化**——
  //   查询 1 天 → 返回 3600 秒（按小时）桶，共 24 个；
  //   查询 2 天及以上 → 返回 86400 秒（按天）桶。
  //   所以必须【累加区间内所有桶】，不能只取 time === 今日零点 的那一个，
  //   否则等于只统计今天第一个小时（实测 ¥2.72 vs 正确的 ¥7.92）。
  async function getTodayCost() {
    const now = new Date()
    const today0 = Math.floor(
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
    )
    const end = today0 + 86400
    const r = await pageCall('/api/v0/usage/by_api_key/cost', {
      start: today0,
      end,
      tz: TZ_SEC(),
    })
    if (!r.ok) return r
    const biz = r.biz || {}
    const blocks = Array.isArray(biz.data) ? biz.data : []
    let total = 0
    let currency = 'CNY'
    let found = false
    let bucketCount = 0
    const byKey = {}
    for (const blk of blocks) {
      if (!blk || !Array.isArray(blk.series)) continue
      if (blk.currency) currency = blk.currency
      for (const s of blk.series) {
        const name = (s && s.api_key && s.api_key.name) || '(未命名)'
        const model = (s && s.model) || ''
        for (const b of (s && Array.isArray(s.buckets) ? s.buckets : [])) {
          if (!b) continue
          const t = Number(b.time)
          if (!(t >= today0 && t < end)) continue // 只算落在今日区间内的桶
          const c = Number(b.cost) || 0
          bucketCount++
          total += c
          if (c > 0) found = true
          const k = name + ' · ' + model
          byKey[k] = (byKey[k] || 0) + c
        }
      }
    }
    // 去掉全为 0 的 key/model 组合，减少 UI 噪声
    const byKeyNonZero = {}
    for (const k of Object.keys(byKey)) if (byKey[k] > 0) byKeyNonZero[k] = byKey[k]
    return {
      ok: true,
      todayCost: total,
      currency,
      found,
      dayStart: today0,
      dayEnd: end,
      granularitySec: Number(biz.bucket) || null, // 1 天区间通常为 3600
      bucketCount,
      byKey: byKeyNonZero,
    }
  }

  // 一次性取齐（UI 用）
  async function getSnapshot() {
    const s = await getSummary()
    if (!s.ok) return s
    const t = await getTodayCost()
    if (!t.ok) {
      // 余额拿到了，今日消费失败 → 部分成功，UI 可降级显示
      return { ...s, todayCost: null, todayError: t.error, todayCode: t.code }
    }
    return { ...s, todayCost: t.todayCost, todayByKey: t.byKey, todayFound: t.found }
  }

  function destroy() {
    if (win && !win.isDestroyed()) win.destroy()
    win = null
    ready = false
  }

  return {
    getSummary,
    getTodayCost,
    getSnapshot,
    openLogin,
    pageState,
    rawCall: pageCall, // 诊断用：返回未加工的 {ok, biz}
    destroy,
    get lastError() { return lastError },
  }
}

module.exports = {
  createPlatformClient,
  PARTITION,
  BASE,
  USAGE_URL,
  APP_DATA_DIR_NAME,
  isPlatformUrl,
  lockDownWindow,
}
