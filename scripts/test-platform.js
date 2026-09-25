// 验证 lib/platform.js：应输出与平台页面一致的余额与今日消费
'use strict'
const { app } = require('electron')
const { createPlatformClient } = require('../lib/platform.js')

app.whenReady().then(async () => {
  const pc = createPlatformClient({ headless: true })
  const t0 = Date.now()
  const snap = await pc.getSnapshot()
  const ms = Date.now() - t0

  console.log('\n===== lib/platform.js 实测 =====')
  console.log('耗时(ms):', ms)
  console.log('ok        :', snap.ok)
  if (!snap.ok) {
    console.log('code      :', snap.code)
    console.log('error     :', snap.error)
  } else {
    console.log('币种      :', snap.currency)
    console.log('余额      :', snap.balance)
    console.log('赠送余额  :', snap.bonusBalance)
    console.log('总消费    :', snap.totalCost)
    console.log('今日消费  :', snap.todayCost, snap.todayFound === false ? '(当日无桶)' : '')
    console.log('今日明细  :', JSON.stringify(snap.todayByKey || {}, null, 2))
    console.log('todayError:', snap.todayError || '无')
  }
  console.log('平台助手异常:', pc.lastError || '无')
  try {
    const st = await pc.pageState()
    console.log('页面状态  :', JSON.stringify(st))
  } catch (e) { console.log('页面状态读取失败:', e.message) }
  console.log('================================\n')

  pc.destroy()
  app.quit()
})

app.on('window-all-closed', () => app.quit())
