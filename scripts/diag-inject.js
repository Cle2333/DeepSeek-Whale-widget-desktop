// 隔离诊断：逐步日志，定位注入/加载的挂点
'use strict'
const { app, BrowserWindow, session } = require('electron')

const P = 'persist:deepseek'
const t0 = Date.now()
const step = (m) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${m}`)

const HELPER = '(() => { window.__helperProbe = { ok: true } })()'

app.whenReady().then(async () => {
  try {
    step('session.fromPartition')
    session.fromPartition(P)

    step('new BrowserWindow')
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: { partition: P, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })

    step('debugger.attach 开始')
    win.webContents.debugger.attach('1.3')
    step('debugger.attach 完成')

    step('Page.enable 开始')
    await win.webContents.debugger.sendCommand('Page.enable')
    step('Page.enable 完成')

    step('addScriptToEvaluateOnNewDocument 开始')
    const r = await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: HELPER,
    })
    step('addScriptToEvaluateOnNewDocument 完成 ' + JSON.stringify(r))

    step('loadURL 开始')
    await win.loadURL('https://platform.deepseek.com/usage')
    step('loadURL 完成')

    step('等待 3s 让 SPA 跑起来')
    await new Promise((x) => setTimeout(x, 3000))

    step('读取注入结果')
    const v = await win.webContents.executeJavaScript(
      '({ helper: !!window.__helperProbe, path: location.pathname, title: document.title })',
      true
    )
    step('注入结果: ' + JSON.stringify(v))

    win.destroy()
    step('窗口已销毁')
  } catch (err) {
    step('✘ 异常: ' + (err && err.stack ? err.stack : err))
  } finally {
    step('app.quit')
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
