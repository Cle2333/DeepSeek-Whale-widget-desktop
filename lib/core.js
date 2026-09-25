// ============================================================================
// dsh-whale-widget 桌面版核心逻辑（无 Electron 依赖，可独立单元测试）
// ----------------------------------------------------------------------------
// 职责：userdata.json 读写（EXE 同目录）—— 只存界面设置与窗口位置。
//
// 注意：本版本已不再保存任何凭据（API key / 平台令牌）。数据改由
// lib/platform.js 通过开放平台会话获取，凭据留在 Electron 会话分区内，
// 不进 userdata.json。加载旧数据时会**主动清除**遗留的 secrets / usage 字段。
// ============================================================================
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 峰谷时段（北京时间）：高峰 9:00–12:00 与 14:00–18:00；周末全天按谷价
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

// bucket time 是 epoch 秒；换算成北京时间的小时来判定高峰 / 谷时
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const date = new Date(Number(timeSec) * 1000 + 8 * 3600 * 1000)
  const day = date.getUTCDay() // 0=周日, 6=周六
  if (day === 0 || day === 6) return false // 周末全天谷价
  const hour = date.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 数据存储
// ---------------------------------------------------------------------------
function defaultData() {
  return {
    version: 3,
    settings: {
      scale: 1.5,
      sound: true,
      vol: 0.9,
      soundSet: 'duck',
      peakMode: 'default',
      bubbleOn: true,
      scrollGapOn: false,
      scrollGapPx: 17,
    },
    pos: { hAnchor: 'right', vAnchor: 'bottom' },
    winPos: null,
  }
}

function createWhaleCore({ dataFile }) {
  const file = path.resolve(dataFile)

  function readData() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (err) {
      return null
    }
  }

  function writeData(obj) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
      return true
    } catch (err) {
      return false
    }
  }

  const data = Object.assign(defaultData(), readData() || {})
  if (!data.settings) data.settings = defaultData().settings
  if (!data.pos) data.pos = defaultData().pos

  // 迁移：清除旧版本遗留的密钥与记账数据
  // （本版本不再需要；留着只是把凭据白放在磁盘上）
  let purged = false
  if (data.secrets !== undefined) {
    delete data.secrets
    purged = true
  }
  if (data.usage !== undefined) {
    delete data.usage
    purged = true
  }
  if (data.settings && data.settings.usageMode !== undefined) {
    delete data.settings.usageMode
    purged = true
  }

  function save() {
    if (writeData(data)) return
    // 写失败（例如 EXE 目录只读）时回退到用户目录，保证功能可用
    try {
      const fallback = path.join(os.homedir(), '.dsh-whale-widget-userdata.json')
      fs.writeFileSync(fallback, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {}
  }

  if (purged) save() // 首次加载即把清理结果落盘

  // ------------------------- settings -------------------------
  function getConfig() {
    const s = data.settings
    return {
      scale: typeof s.scale === 'number' ? s.scale : 1.5,
      sound: s.sound !== false,
      vol: typeof s.vol === 'number' ? s.vol : 0.9,
      soundSet: s.soundSet === 'fx1' ? 'fx1' : 'duck',
      peakMode: s.peakMode === 'liangwen' || s.peakMode === 'qiangqiang' ? s.peakMode : 'default',
      bubbleOn: s.bubbleOn !== false,
      scrollGapOn: s.scrollGapOn === true,
      scrollGapPx: typeof s.scrollGapPx === 'number' ? Math.round(s.scrollGapPx) : 17,
      pos: {
        hAnchor: data.pos && (data.pos.hAnchor === 'left' || data.pos.hAnchor === 'right') ? data.pos.hAnchor : 'right',
        vAnchor: data.pos && (data.pos.vAnchor === 'top' || data.pos.vAnchor === 'bottom') ? data.pos.vAnchor : 'bottom',
      },
    }
  }

  function saveConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'bad config' }
    const s = data.settings
    if (typeof cfg.scale === 'number' && isFinite(cfg.scale)) s.scale = cfg.scale
    if (typeof cfg.sound === 'boolean') s.sound = cfg.sound
    if (typeof cfg.vol === 'number' && isFinite(cfg.vol)) s.vol = cfg.vol
    if (typeof cfg.soundSet === 'string') s.soundSet = cfg.soundSet === 'fx1' ? 'fx1' : 'duck'
    if (typeof cfg.peakMode === 'string') {
      s.peakMode = cfg.peakMode === 'liangwen' || cfg.peakMode === 'qiangqiang' ? cfg.peakMode : 'default'
    }
    if (typeof cfg.bubbleOn === 'boolean') s.bubbleOn = cfg.bubbleOn
    if (typeof cfg.scrollGapOn === 'boolean') s.scrollGapOn = cfg.scrollGapOn
    if (typeof cfg.scrollGapPx === 'number') {
      s.scrollGapPx = Math.round(cfg.scrollGapPx) > 0 ? Math.round(cfg.scrollGapPx) : 0
    }
    if (cfg.pos && typeof cfg.pos === 'object') {
      const h = cfg.pos.hAnchor
      const v = cfg.pos.vAnchor
      if (h === 'left' || h === 'right' || h === null) data.pos.hAnchor = h === null ? 'right' : h
      if (v === 'top' || v === 'bottom') data.pos.vAnchor = v
    }
    save()
    return { ok: true }
  }

  // ------------------------- window pos -------------------------
  function getWinPos() {
    return data.winPos && typeof data.winPos.x === 'number' && typeof data.winPos.y === 'number'
      ? { x: data.winPos.x, y: data.winPos.y }
      : null
  }

  function setWinPos(pos) {
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      data.winPos = { x: Math.round(pos.x), y: Math.round(pos.y) }
      save()
    }
  }

  return {
    getConfig,
    saveConfig,
    getWinPos,
    setWinPos,
    // 测试 / 调试用
    _data: () => data,
  }
}

module.exports = { createWhaleCore, isPeakTime, PEAK_HOURS }
