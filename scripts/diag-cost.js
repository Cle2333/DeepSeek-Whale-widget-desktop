// 诊断：核对不同查询区间的分桶粒度与「今日」取值是否一致
'use strict'
const { app } = require('electron')
const { createPlatformClient } = require('../lib/platform.js')

const TZ = () => -new Date().getTimezoneOffset() * 60
const fmt = (ts) =>
  new Date((ts + TZ()) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' (UTC+8)'

app.whenReady().then(async () => {
  const pc = createPlatformClient({ headless: true })
  const now = new Date()
  const today0 = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
  console.log('now        :', fmt(Math.floor(Date.now() / 1000)))
  console.log('今日零点   :', today0, fmt(today0))
  console.log('tz 参数    :', TZ())

  const ranges = [
    ['1 天（今天）', today0, today0 + 86400],
    ['2 天（昨天起）', today0 - 86400, today0 + 86400],
    ['7 天', today0 - 6 * 86400, today0 + 86400],
    ['30 天', today0 - 29 * 86400, today0 + 86400],
  ]

  for (const [label, start, end] of ranges) {
    const r = await pc.rawCall('/api/v0/usage/by_api_key/cost', { start, end, tz: TZ() })
    if (!r.ok) {
      console.log(`\n=== ${label} → 失败: ${r.code} ${r.error}`)
      continue
    }
    const biz = r.biz || {}
    const blocks = Array.isArray(biz.data) ? biz.data : []
    // 看所有出现过的 bucket 时间
    const times = new Set()
    const perBucket = {}
    let seriesCount = 0
    for (const blk of blocks) {
      for (const s of (blk.series || [])) {
        seriesCount++
        for (const b of (s.buckets || [])) {
          times.add(Number(b.time))
          const c = Number(b.cost) || 0
          perBucket[Number(b.time)] = (perBucket[Number(b.time)] || 0) + c
        }
      }
    }
    const tl = [...times].sort((a, b) => a - b)
    console.log(`\n=== ${label}  start=${start} end=${end}`)
    console.log(`    bucket 粒度字段 = ${biz.bucket} 秒   series 数 = ${seriesCount}   桶数 = ${tl.length}`)
    if (tl.length) {
      const gaps = tl.length > 1 ? tl[1] - tl[0] : null
      console.log(`    首桶 ${tl[0]} ${fmt(tl[0])}`)
      console.log(`    末桶 ${tl[tl.length - 1]} ${fmt(tl[tl.length - 1])}`)
      console.log(`    相邻间隔 = ${gaps} 秒`)
      const hit = tl.filter((t) => t === today0)
      console.log(
        `    time===今日零点的桶: ${hit.length ? '有' : '无'}` +
          (hit.length ? `  金额合计 = ¥${perBucket[today0].toFixed(8)}` : '')
      )
      const inToday = tl.filter((t) => t >= today0 && t < today0 + 86400)
      const sumToday = inToday.reduce((a, t) => a + perBucket[t], 0)
      console.log(
        `    落在今日区间 [${today0}, ${today0 + 86400}) 内的桶 ${inToday.length} 个，合计 = ¥${sumToday.toFixed(8)}`
      )
      console.log('    非零桶明细:')
      for (const t of tl) {
        if (perBucket[t] > 0) console.log(`      ${t} ${fmt(t)}  ¥${perBucket[t].toFixed(8)}`)
      }
    }
  }

  pc.destroy()
  app.quit()
})

app.on('window-all-closed', () => app.quit())
