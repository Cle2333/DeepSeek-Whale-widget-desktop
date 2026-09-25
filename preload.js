// ============================================================================
// dsh-whale-widget 桌面版 —— preload（contextBridge）
// ----------------------------------------------------------------------------
// 渲染层只能通过 window.whaleAPI 与主进程通信，拿不到 Node / Electron 能力。
// 通道是**白名单**：渲染层无法请求任意 URL、无法读写任意文件。
// ============================================================================
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whaleAPI', {
  // 设置
  getConfig: () => ipcRenderer.invoke('whale:getConfig'),
  saveConfig: (cfg) => ipcRenderer.invoke('whale:saveConfig', cfg),

  // 数据（走开放平台会话，无需 API key）
  fetchData: (force) => ipcRenderer.invoke('whale:fetchData', force),
  openLogin: () => ipcRenderer.invoke('whale:openLogin'),

  // 开机自启
  setAutoStart: (enabled) => ipcRenderer.invoke('whale:setAutoStart', enabled),

  // 右键菜单（主进程原生菜单）
  contextMenu: (pos) => ipcRenderer.invoke('whale:contextMenu', pos),

  // 窗口
  moveWindow: (dx, dy) => ipcRenderer.invoke('whale:moveWindow', dx, dy),
  dragEnd: () => ipcRenderer.invoke('whale:dragEnd'),
  quit: () => ipcRenderer.invoke('whale:quit'),
  setIgnore: (ignore) => ipcRenderer.send('whale:setIgnore', ignore),

  // 主进程 → 渲染层
  onOpenSettings: (cb) => ipcRenderer.on('whale:openSettings', () => cb()),
})
