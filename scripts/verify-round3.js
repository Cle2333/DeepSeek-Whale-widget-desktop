// 针对性验证第三轮评审的两条关键修复：
//   A) get() 的 apiPath 白名单（security · high）—— 合法路径要放行，站外绝对 URL 必须拦住
//   B) LOGIN_WAIT_MS / isLoginPath 统一后，正常取数链路不受影响
// 运行：npx electron <此文件>
'use strict'
const { app } = require('electron')
const path = require('node:path')
const { createPlatformClient, APP_DATA_DIR_NAME, isLoginPath, LOGIN_WAIT_MS } = require('../lib/platform.js')
app.setPath('userData', path.join(app.getPath('appData'), APP_DATA_DIR_NAME))

app.whenReady().then(async () => {
  const pc = createPlatformClient({ headless: true })
  let fail = 0
  let pass = 0
  const check = (name, cond, detail) => {
    console.log((cond ? '  ✔ ' : '  ✘ ') + name + (detail ? ' → ' + detail : ''))
    if (cond) pass++
    else fail++
  }
  try {
    console.log('\n===== 静态判定 =====')
    check('isLoginPath(/sign_in)', isLoginPath('/sign_in') === true)
    check('isLoginPath(/login)', isLoginPath('/login') === true) // ★ 平台若改跳 /login
    check('isLoginPath(/usage) 为假', isLoginPath('/usage') === false)
    check('isLoginPath("") 为假', isLoginPath('') === false)
    check('LOGIN_WAIT_MS = 10 分钟', LOGIN_WAIT_MS === 10 * 60 * 1000, LOGIN_WAIT_MS + 'ms')

    // 先用一次真实取数把页面与助手建立起来
    const snap = await pc.getSnapshot()
    console.log('\n===== 真实取数（确认白名单没误伤）=====')
    check('取数成功', snap.ok === true, snap.ok ? '' : snap.code + ' / ' + snap.error)
    if (snap.ok) console.log('    余额 =', snap.balance, '| 今日消费 =', snap.todayCost)

    console.log('\n===== A) get() 白名单：站外绝对 URL 必须拦住 =====')
    // 逐条试各种绕过姿势，全部必须抛 BAD_PATH（不能带 authorization 头出站）
    const attacks = [
      ['绝对 URL 指向站外', 'https://attacker.example/collect'],
      ['协议相对 //', '//attacker.example/collect'],
      ['子域名伪装（includes 会骗过）', 'https://platform.deepseek.com.attacker.example/api/x'],
      ['路径穿越逃出 /api/ 前缀', '/api/../evil'],
      ['完全无关的相对路径', '/usage'],
      ['HTTP 降级（非同 https 源）', 'http://platform.deepseek.com/api/v0/users/get_user_summary'],
    ]
    for (const [label, evil] of attacks) {
      let r
      try {
        r = await pc.rawCall(evil)
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) }
      }
      const blocked = !r || r.ok === false
      check('拦住: ' + label, blocked, blocked ? String(r && r.error).slice(0, 70) : JSON.stringify(r).slice(0, 70))
    }

    console.log('\n===== B) 合法路径仍放行 =====')
    const good = await pc.rawCall('/api/v0/users/get_user_summary')
    check('合法接口通过', !!(good && good.ok !== false), JSON.stringify(good).slice(0, 90))

    console.log('\n===== 结果 =====')
    console.log(
      fail === 0
        ? '✔ 全部通过（' + pass + ' 项）'
        : '✘ 通过 ' + pass + ' 项 / 未通过 ' + fail + ' 项'
    )
    console.log('平台助手异常:', pc.lastError || '无')
  } catch (err) {
    console.log('✘ 脚本异常:', (err && err.stack) || err)
    fail++
  } finally {
    pc.destroy()
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
