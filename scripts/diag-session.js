// 诊断：会话分区落在哪、cookie 是否持久化、登录态是否还在
'use strict'
const { app, session } = require('electron')

app.whenReady().then(async () => {
  console.log('userData        :', app.getPath('userData'))
  console.log('appData         :', app.getPath('appData'))
  console.log('name            :', app.getName())

  for (const part of ['persist:deepseek', null]) {
    const label = part || '(默认分区)'
    const ses = part ? session.fromPartition(part) : session.defaultSession
    let sp = '(无 getStoragePath)'
    try { if (ses.getStoragePath) sp = ses.getStoragePath() } catch (e) { sp = 'ERR ' + e.message }
    console.log(`\n--- ${label} ---`)
    console.log('  storagePath:', sp)
    try {
      const ck = await ses.cookies.get({ domain: 'deepseek.com' })
      console.log('  deepseek 域 cookie 数:', ck.length)
      for (const c of ck) {
        console.log(`    ${c.domain}${c.path}  ${c.name}  httpOnly=${c.httpOnly}  session=${c.session}  expires=${c.expirationDate || '会话级'}`)
      }
    } catch (e) { console.log('  取 cookie 失败:', e.message) }
  }
  app.quit()
})
app.on('window-all-closed', () => app.quit())
