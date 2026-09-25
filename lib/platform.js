// ============================================================================
// dsh-whale-widget 桌面版 —— 开放平台会话数据层
// ----------------------------------------------------------------------------
// 用「隐藏窗口 + 用户已登录的会话」读取 DeepSeek 开放平台数据，
// 因此**不需要 API key**，且能读到程序启动前的消费（平台侧按天分桶的真实账单）。
//
// 安全设计：token 全程不出页面
//   1. 首次加载 /usage，让平台 SPA 自己发起带 Authorization 的请求
//   2. 用 Page.addScriptToEvaluateOnNewDocument 在主世界注入助手，
//      被动截获 SPA 请求里的 Authorization 头（存在页面内存里）
//   3. 我们自己的取数请求在**页面上下文内** fetch —— token 不进 Node 进程、
//      不落盘、不写入 userdata.json
//
// 实测接口（详见 Obsidian 项目笔记）：
//   GET /api/v0/users/get_user_summary        余额 / 赠送余额 / 生命周期总消费
//   GET /api/v0/usage/by_api_key/cost         按天分桶的消费金额（bucket=86400）
//
// 注意：token 由平台前端维护，可能随版本变化；任何一步失败都返回
// { ok:false, code, error }，由调用方降级处理，不抛到 UI。
// ============================================================================
'use strict'

const { BrowserWindow, session } = require('electron')
const path = require('node:path')

const PARTITION = 'persist:deepseek'
const BASE = 'https://platform.deepseek.com'
const USAGE_PATH = '/usage'
const USAGE_URL = BASE + USAGE_PATH
const LOGIN_PATH = '/sign_in'

const TZ_SEC = () => -new Date().getTimezoneOffset() * 60

// 请求节流：串行 + 最小间隔，避免给平台造成压力
const MIN_GAP_MS = 400

// ---------------------------------------------------------------------------
// 注入到页面主世界的助手（在页面脚本之前运行）
// ---------------------------------------------------------------------------
const PAGE_HELPER = `(() => {
  if (window.__dshPlatform) return
  const S = { auth: null, ready: false, hits: 0, errors: [], lastUrl: null }
  window.__dshPlatform = S

  const pickHeader = (h, name) => {
    if (!h) return null
    try {
      if (typeof h.get === 'function') return h.get(name)
      if (Array.isArray(h)) {
        for (const kv of h) if (kv && String(kv[0]).toLowerCase() === name) return kv[1]
        return null
      }
      for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k]
    } catch (e) { S.errors.push('pick:' + e.message) }
    return null
  }
  const note = (v, where) => {
    if (v && typeof v === 'string' && v.length > 8) {
      if (!S.auth) S.hits++
      S.auth = v
      S.ready = true
    }
  }

  // 1) 截获 window.fetch 的请求头
  const origFetch = window.fetch
  window.fetch = function (input, init) {
    try {
      const fromInit = pickHeader(init && init.headers, 'authorization')
      const fromReq = input && typeof input === 'object' && input.headers
        ? pickHeader(input.headers, 'authorization') : null
      const fromAll = new URL(input && input.url ? input.url : String(input), location.href)
      S.lastUrl = fromAll.toString()
      note(fromInit || fromReq, 'fetch')
    } catch (e) { S.errors.push('fetch:' + e.message) }
    return origFetch.apply(this, arguments)
  }

  // 2) 截获 XMLHttpRequest 的请求头
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (String(k).toLowerCase() === 'authorization') note(v, 'xhr') } catch (e) {}
    return origSetHeader.apply(this, arguments)
  }

  // 3) 用截获到的凭据在页面内发请求（token 不出页面）
  S.get = async function (apiPath, query) {
    if (!S.auth) throw new Error('NO_AUTH')
    let u = apiPath
    if (query) u += '?' + new URLSearchParams(query).toString()
    const r = await origFetch.call(window, u, {
      headers: { accept: 'application/json', authorization: S.auth },
      credentials: 'include',
    })
    const txt = await r.text()
    let json = null
    try { json = JSON.parse(txt) } catch (e) { json = { __raw: txt.slice(0, 300) } }
    return { status: r.status, json }
  }
})()`

// ---------------------------------------------------------------------------
function createPlatformClient({ headless = true } = {}) {
  let win = null
  let ready = false
  let lastCallAt = 0
  let lastError = null
  let helperInstalled = false

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function throttle() {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt)
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
  }

  // -------------------------------------------------------------------------
  // 窗口生命周期
  // -------------------------------------------------------------------------
  function createWindow({ show = false } = {}) {
    session.fromPartition(PARTITION)
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
      wc.debugger.attach('1.3')
    } catch (err) {
      lastError = 'debugger 附加失败: ' + err.message
      return false
    }
    try {
      // 1) 主世界注入助手（token 捕获 + 页面内取数）
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
                // 把凭据送进页面助手的闭包 —— 之后所有请求都在页面内发出
                wc.executeJavaScript(
                  `(() => { const S = window.__dshPlatform; if (S && !S.auth) { S.auth = ${JSON.stringify(v)}; S.ready = true; S.source = 'cdp' } })()`,
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
      return false
    }
  }

  async function pageState() {
    if (!win || win.isDestroyed()) return { path: '', href: '' }
    try {
      return await win.webContents.executeJavaScript(
        `({ path: location.pathname, href: location.href, title: document.title,
            hasHelper: !!window.__dshPlatform,
            ready: !!(window.__dshPlatform && window.__dshPlatform.ready),
            source: (window.__dshPlatform && window.__dshPlatform.source) || null,
            hits: (window.__dshPlatform && window.__dshPlatform.hits) || 0,
            errs: (window.__dshPlatform && window.__dshPlatform.errors) || [],
            lastUrl: (window.__dshPlatform && window.__dshPlatform.lastUrl) || null })`,
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
    return loadAndWait({ show: !headless })
  }

  // 打开登录窗口（用户手动登录用）
  async function openLogin() {
    if (!win || win.isDestroyed()) createWindow({ show: true })
    win.show()
    win.focus()
    if (!win.webContents.getURL()) await win.loadURL(BASE + LOGIN_PATH)
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // 取数（在页面上下文内执行，token 不出页面）
  // -------------------------------------------------------------------------
  async function pageCall(apiPath, query) {
    const r = await ensureReady()
    if (!r.ok) return { ok: false, code: r.code, error: '平台会话不可用（' + r.code + '）' }
    await throttle()
    try {
      const res = await win.webContents.executeJavaScript(
        `window.__dshPlatform.get(${JSON.stringify(apiPath)}, ${JSON.stringify(query || null)})`,
        true
      )
      if (!res || typeof res !== 'object') return { ok: false, code: 'BAD_RESULT', error: '页面返回异常' }
      const j = res.json || {}
      if (j.code !== 0) {
        const code = j.code === 40002 || j.code === 40003 ? 'AUTH_EXPIRED' : 'API_ERROR'
        return { ok: false, code, error: j.msg || ('code ' + j.code), apiCode: j.code }
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
    const gift = pick(bonus)
    const tot = pick(costs)
    return {
      ok: true,
      currency: (main && main.currency) || 'CNY',
      balance: main ? Number(main.balance) : NaN,
      bonusBalance: gift ? Number(gift.balance) : 0,
      totalCost: tot ? Number(tot.amount) : NaN,
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

module.exports = { createPlatformClient, PARTITION, BASE, USAGE_URL }
