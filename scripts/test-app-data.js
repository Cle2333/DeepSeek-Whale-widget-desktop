// 验证应用真实数据链路：与 main.js 使用同一个 userData 目录与分区。
//   npx electron scripts/test-app-data.js          # 只读检查
//   npx electron scripts/test-app-data.js --show   # 未登录时弹出登录窗口
'use strict'
const { app } = require('electron')
const path = require('node:path')

// ★ 与 main.js 保持一致：钉死会话目录
app.setPath('userData', path.join(app.getPath('appData'), 'DeepSeekWhaleWidget'))

const { createPlatformClient } = require('../lib/platform.js')

const SHOW = process.argv.includes('--show')

app.whenReady().then(async () => {
  const pc = createPlatformClient({ headless: !SHOW })
  const t0 = Date.now()
  let snap = await pc.getSnapshot()

  if (!snap.ok && SHOW && (snap.code === 'NEED_LOGIN' || snap.code === 'NO_CREDENTIAL')) {
    console.log('\n⚠ 未登录 —— 已弹出登录窗口，请在其中完成登录（最多 10 分钟）…')
    await pc.openLogin()
    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000))
      const st = await pc.pageState()
      if (st && st.ready) {
        console.log('✔ 检测到登录，重新取数…')
        break
      }
    }
    snap = await pc.getSnapshot()
  }

  console.log('\n===== 应用真实数据链路 =====')
  console.log('userData  :', app.getPath('userData'))
  console.log('耗时(ms)  :', Date.now() - t0)
  console.log('ok        :', snap.ok)
  if (!snap.ok) {
    console.log('code      :', snap.code)
    console.log('error     :', snap.error)
  } else {
    console.log('币种      :', snap.currency)
    console.log('余额      :', snap.balance)
    console.log('赠送余额  :', snap.bonusBalance)
    console.log('今日消费  :', snap.todayCost)
    console.log('峰谷      :', snap.isPeak ? '高峰' : '谷时')
    console.log('今日明细  :', JSON.stringify(snap.todayByKey || {}))
  }
  const st = await pc.pageState()
  console.log('页面状态  :', JSON.stringify(st))
  console.log('============================\n')

  pc.destroy()
  app.quit()
})

app.on('window-all-closed', () => app.quit())
