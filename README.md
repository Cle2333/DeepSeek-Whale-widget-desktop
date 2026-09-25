# DeepSeek 余额小鲸鱼桌面版（Whale Widget Desktop）

![DeepSeek 余额小鲸鱼](assets/DSH2.png)

DeepSeek 余额小鲸鱼 —— **脱离 DSH 的独立桌面挂件**：小鲸鱼气泡图常驻桌面，实时显示 DeepSeek 开放平台**余额**与**今日已用消费**，支持拖拽/边缘吸附/按压音效/随机台词。打包为**单文件 EXE**。

> ## 本仓库与原版的差异
>
> 本仓库 fork 自 [comreade-123/DeepSeek-Whale-widget-desktop](https://github.com/comreade-123/DeepSeek-Whale-widget-desktop)（该仓库又是 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的 DSH 插件版改造而来）。MIT License，**版权归原作者所有**（见 [LICENSE](LICENSE)）：
>
> ```
> Copyright (c) 2026 MeteorNOX
> Copyright (c) 2026 EthanMaven
> ```
>
> ### 改了什么
>
> | 方面 | 原版 | 本 Fork |
> |---|---|---|
> | **凭据** | 必须填 `API_KEY`（AES 加密存 `userdata.json`） | **不需要任何 key**：登录一次开放平台，复用该会话 |
> | **今日已用** | 靠运行时观测余额差值记账，**漏掉程序未运行期间的消费** | 读平台侧真实账单，**含程序启动前的消费** |
> | **设置入口** | 悬停鲸鱼右上角的**三横线按钮** | 按钮已移除，改为**右键鲸鱼 → 设置…** |
> | **查看详情** | 无此功能 | **右键菜单 → 查看用量详情**，弹出应用内置窗口（非系统浏览器） |
> | **开机自启** | 无（需手动放 `shell:startup`） | 设置面板内开关，写 `HKCU\...\Run` |
> | **外链安全** | — | 持有登录态的窗口全部加导航围栏：禁开新窗口、禁跳站外 |
> | **数据文件** | 含加密的 `secrets` | **不再保存任何凭据** |
> | **依赖管理** | npm | pnpm |

## 特性

- 🐋 **独立桌面应用**：Electron 透明置顶窗口，不依赖 DSH / 浏览器
- 🔑 **零 API key**：登录一次 DeepSeek 开放平台即可（会话持久化，重启免登录）
- 💰 **余额**：60 秒自动刷新 + 点击鲸鱼手动刷新；余额变化数字**滚动动画**；网络抖动自动沿用最近值不报错
- 📊 **今日已用**：直接读**开放平台真实账单**（按小时/天分桶），
  **包含程序启动前产生的消费**——这是原版记账模式读不到的部分
- 🖱️ **拖拽 + 四分之一屏边缘吸附**（左/右/上/下，角落可组合），窗口位置记忆
- 🔄 左吸附时整体**水平镜像翻转**（文字同步反向、带动画）
- 🧸 **按压 Q 弹**玩偶效果 + 按压/松手音效（内置 mp3，缺失时静默降级）
- 💬 **随机台词**：点击气泡切换台词段，再点一次关闭；气泡总显示 5 秒自动收起
- 🖲️ **右键菜单**：查看用量详情（内置窗口）/ 设置… / 重新登录开放平台 / 退出
- ⚙️ **设置面板**：大小（0.6–2.5 倍）、音效、音量、峰谷文案、气泡开关、开放平台登录态、**开机自启**
- 🔒 **导航围栏**：能看到登录态的窗口禁止开新窗口、禁止跳转站外网页

## 快速开始

1. 获取 `DeepSeekWhaleWidget_<version>_win_x86.exe`（Release，或按下方「构建」自行打包），放到任意可写目录双击运行
2. 桌面出现小鲸鱼。**右键鲸鱼 → 设置… → 开放平台 → 去登录**，在弹出的窗口里登录开放平台
3. 余额与今日已用会自动显示；点击鲸鱼可立即刷新并弹气泡
4. 首次运行后 EXE 同目录自动生成 `userdata.json`（**只存界面设置与窗口位置，不含任何凭据**）

> 登录态保存在 `%APPDATA%\DeepSeekWhaleWidget\Partitions\deepseek`，**一次登录长期有效**。

## 使用说明

### 右键菜单（右键鲸鱼本体）

| 项 | 说明 |
|---|---|
| 查看用量详情 | 打开应用内置窗口显示开放平台用量页（已登录，无需再登） |
| 设置… | 打开设置面板 |
| 重新登录开放平台 | 打开登录窗口（换账号或登录态失效时用） |
| 退出小鲸鱼 | 退出应用（无边框窗口没有系统关闭按钮） |

### 设置面板

| 行 | 说明 |
|---|---|
| 大小 | 0.6–2.5 倍滑块 + 数字框（1–20） |
| 音效 / 音量 | 小黄鸭（Ya1/Ya2）/ 音效1（D1/D2） |
| 峰谷 | 提示文案风格：默认 / 梁文峰谷 / !?强强?! |
| 气泡 | 开关思考气泡 |
| 开放平台 | 显示登录态（未登录 / 已登录 ✓）+ 「去登录 / 重登」按钮 |
| 开机自启 | 开关；**仅打包版可用**（开发态禁用并提示原因） |

### 今日已用的口径

数据来自平台接口 `GET /api/v0/usage/by_api_key/cost`，传当日区间（本地零点 → +24h）。

⚠️ **注意分桶粒度会随查询区间变化**：查 1 天返回 **3600 秒（按小时）** 桶，查 2 天及以上返回 **86400 秒（按天）** 桶。因此实现里是**累加区间内全部桶**，而不是只取「今日零点」那一个（后者只会统计到当天第一个小时）。

不加 `api_key_tracking_id` 时接口返回账号下**所有 key 的汇总**，正是「今日总消费」。

## 构建 EXE（从源码）

环境要求：Windows 10/11 x64、Node.js ≥ 18、pnpm。

```powershell
pnpm install

# 国内网络建议设置镜像（electron 二进制与 electron-builder 工具链）
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

pnpm run dist
```

产物：`dist/DeepSeekWhaleWidget_<version>_win_x86.exe`

其他命令：

```powershell
pnpm start                # 开发模式运行
pnpm run smoke            # 冒烟自检：启动后打印真实数据与各功能状态并退出
pnpm run data             # 只验证数据链路（打印余额与今日消费）
pnpm run fix-electron     # 修复 electron 二进制解压（见下）
```

### 冒烟自检的两个开关

```powershell
pnpm run smoke                                  # 默认：自启项只读校验，不改动系统
electron . --smoke --smoke-autostart            # 额外验证自启写入（会真实写注册表，测完恢复初值）
```

**默认不写注册表**：冒烟测试不该改用户机器的真实状态。需要验证写入时才加
`--smoke-autostart`，且恢复逻辑放在 `finally`，即使中途出错也会把原值写回去。

打包版由 NSIS 启动器解压后独立拉启，**stdout 不会回传**，自检结果会写到
`%APPDATA%\DeepSeekWhaleWidget\smoke-result.txt`。

### 构建说明

- `pnpm run dist` = `node scripts/prepare-electron.mjs` + `electron-builder --win portable`
- **无需管理员权限**：配置了 `win.signAndEditExecutable: false`，改由 `prepare-electron.mjs`
  用 rcedit 给 `build/electron-dist/electron.exe` 打图标与版本信息（规避 winCodeSign 的符号链接权限要求）
- `build/electron-dist/`（约 300MB）与 `dist/win-unpacked/` 是中间产物，可随时删除

### electron 二进制解压（Node 26 环境必读）

在 Node 26 下，electron 自带的 postinstall 会**静默失败**：`@electron/get` 正常下载/命中缓存，
但随后 `extract-zip` 的 promise 永不 settle，Node 事件循环空转后直接退出（exit 0），
留下一个只含 `locales/` 的空 `dist/`（外加缺失的 `path.txt`），症状是：

```
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
```

本仓库用 `scripts/fix-electron-dist.mjs` 解决：跳过 `extract-zip`，改用系统解压工具
（Windows 用 `System32\tar.exe`，macOS/Linux 用 unzip/tar），并补齐 `path.txt`。
该脚本是**幂等**的，已挂到 `postinstall`，所以正常 `pnpm install` 后无需手动处理。

> ⚠️ 注意：Windows 上**必须用 `System32\tar.exe` 的完整路径**。若只写 `tar`，
> 在 git-bash 环境下会命中 GNU tar，它会把 `C:\...` 当成远程主机，报
> `Cannot connect to C: resolve failed`。

## 数据存储与安全

| 项 | 说明 |
|---|---|
| 设置文件 | `userdata.json` 与 EXE 同目录（目录只读时回退到用户主目录） |
| 内容 | **只有** `settings`（界面设置）、`pos`（吸附状态）、`winPos`（窗口位置） |
| 凭据 | **不落盘**。登录态由 Electron 会话分区保管（`%APPDATA%\DeepSeekWhaleWidget\Partitions\deepseek`） |
| 取数方式 | 在平台页面上下文内发请求；`Authorization` 由页面注入，**token 不进 Node 进程、不写文件** |
| 外链防护 | 持有登录态的窗口：`setWindowOpenHandler` 一律 deny；`will-navigate`/`will-redirect` 只放行 `https` + 平台同源；拒绝 `webview` |
| 开机自启 | 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（**用户级，无需管理员**）；默认关闭；关闭时显式清除 |

> 从旧版本升级时，`lib/core.js` 会在加载时**主动删除**遗留的 `secrets`（旧 API key / 平台令牌）与
> `usage` 记账数据 —— 新版本不再需要它们，留着只是把凭据白放在磁盘上。

### 为什么开机自启的路径不能随便取

portable 单文件 EXE 是**自解压**的：运行时把内容解到临时目录再执行，所以
`process.execPath` 指向的是**临时目录**（每次启动都不同、退出即删）。用它注册自启，
下次开机必然指向一个不存在的路径。

正确做法是用 electron-builder 注入的 `PORTABLE_EXECUTABLE_FILE`（真 EXE 全路径）。
实测对照：

```
PORTABLE_EXECUTABLE_FILE = C:\...\dist\DeepSeekWhaleWidget_2.0.0_win_x86.exe   ← 用它
process.execPath         = C:\Users\...\AppData\Local\Temp\3Jo97...\...exe     ← 临时目录
```

## 目录结构

```text
├── LICENSE                        # MIT（含两位原作者版权行）
├── README.md
├── whale-widget-prompt.md         # 原版完整规格提示词（保留作参考）
├── assets/DSH2.png                # README 展示图
├── package.json                   # Electron + electron-builder 配置
├── pnpm-workspace.yaml            # pnpm 构建脚本放行白名单
├── main.js                        # 主进程：窗口 / IPC / 右键菜单 / 详情窗口 / 开机自启 / 导航围栏
├── preload.js                     # contextBridge：window.whaleAPI（通道白名单）
├── lib/
│   ├── core.js                    # 设置存储（纯 Node，无 Electron 依赖）
│   └── platform.js                # 开放平台会话数据层（取余额 / 今日消费）
├── renderer/
│   ├── index.html
│   ├── widget.js                  # 挂件页面逻辑（气泡 / 拖拽 / 右键菜单 / 设置面板）
│   └── assets/                    # 鲸鱼图 / gif / 音效
├── scripts/
│   ├── prepare-electron.mjs       # 打包前给 electron 打图标/版本补丁
│   ├── fix-electron-dist.mjs      # 修复 Node 26 下 electron 二进制解压失败
│   ├── probe-platform.js          # 平台接口探测工具
│   └── test-app-data.js           # 数据链路验证
└── build/
    ├── icon.ico
    └── tools/rcedit-x64.exe       # 第三方工具（来源 electron-builder 官方 binaries 包）
```

## 常见问题

- **余额显示「需登录开放平台」**：右键鲸鱼 → 设置… → 开放平台 → 去登录。
  登录期间挂件提示「登录中…」，此窗口**不会被自动刷新打扰**（登录中会暂停导航该窗口，
  否则每 60 秒的轮询会把正在填写的表单刷掉）。
- **今日已用显示 --**：平台接口临时失败时会降级显示；下一次刷新（60 秒）会自动重试。
  注意此时气泡里也会显示 `--` 而**不是** `¥0.00` —— 两者含义不同（取数失败 vs 今天确实没消费）。
- **窗口拖不动**：按住鲸鱼本体（蓝色像素内）拖动；透明区域是穿透的。
- **点不到鲸鱼**：鼠标穿透默认开启，移入鲸鱼区域即恢复交互。
- **没有声音**：确认 `renderer/assets/*.mp3` 在包内；缺失时静默降级。
- **改不了开机自启**：开关仅在打包版可用；开发态（`electron .`）会禁用并提示原因。
- **打包后杀软报毒**：Electron 未签名应用的常见误报；可自行 `signtool` 签名。
- **想换鲸鱼图**：替换 `renderer/assets/DSniang1.png`（需透明背景 cut-out）；气泡由代码绘制。

## 已知限制

- **依赖非官方接口**：`/api/v0/users/get_user_summary`、`/api/v0/usage/by_api_key/cost` 未公开承诺兼容性，
  平台前端改版可能导致失效。失效时挂件会提示，不会崩溃。
- 接口失败时不做激进重试：请求串行 + 最小间隔 400 ms + 30 秒数据缓存，页面轮询 60 秒。
- 未做系统托盘；「最小化」即退出。
- 若平台将来改用第三方登录（Google/Apple），导航围栏会挡住跳转，需按需放宽。

## 许可证

本项目基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。

```
Copyright (c) 2026 MeteorNOX
Copyright (c) 2026 EthanMaven
```
