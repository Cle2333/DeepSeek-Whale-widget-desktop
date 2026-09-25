// 验证 lib/platform.js 的数据链路：应输出与平台页面一致的余额与今日消费
//   npx electron scripts/test-platform.js
//
// ★ 必须钉死 userData：`npx electron <script>` 运行时 app 名是 "Electron"，
//   不钉就会去 %APPDATA%\Electron 下找 persist:deepseek 分区 ——
//   那与应用（%APPDATA%\DeepSeekWhaleWidget）**不是同一份登录态**，
//   应用里明明已登录，这里却会报 NEED_LOGIN，容易被误判成取数链路坏了。
'use strict'
const { app } = require('electron')
const path = require('node:path')

const { createPlatformClient, APP_DATA_DIR_NAME } = require('../lib/platform.js')
app.setPath('userData', path.join(app.getPath('appData'), APP_DATA_DIR_NAME))

app.whenReady().then(async () => {
  const pc = createPlatformClient({ headless: true })
  // ★ 用 try/finally 保证清理：中途抛异常时若不销毁隐藏窗口，
  //   window-all-closed 不会触发，脚本会挂在后台不退出
  try {
    const t0 = Date.now()
    let snap
    try {
      snap = await pc.getSnapshot()
    } catch (err) {
      snap = { ok: false, code: 'THROW', error: String((err && err.message) || err) }
    }
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
    }
    // 今日消费失败时 todayError 才是排查线索，别只打印 null
    if (snap.todayError) console.log('今日消费失败:', snap.todayCode, snap.todayError)
    console.log('平台助手异常:', pc.lastError || '无')
    try {
      const st = await pc.pageState()
      console.log('页面状态  :', JSON.stringify(st))
    } catch (e) {
      console.log('页面状态读取失败:', e.message)
    }
    console.log('================================\n')
  } finally {
    pc.destroy()
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
