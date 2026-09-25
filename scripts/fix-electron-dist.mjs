// ============================================================================
// scripts/fix-electron-dist.mjs —— 修复 electron 二进制未被正确解压的问题
// ----------------------------------------------------------------------------
// 背景：electron 自带的 postinstall（node install.js）在 Node 26 上**静默失败**——
//   @electron/get 会把 zip 正常下载/命中缓存，但随后用 extract-zip 解压时，
//   其 promise 永不 settle，Node 事件循环空转后直接退出（exit 0），
//   留下一个只含 locales/ 的空 dist/ 和缺失的 path.txt，
//   症状是 `electron .` 报 "Electron failed to install correctly"。
//
// 做法：跳过 extract-zip，改用系统自带解压工具（Windows 10+ 的 tar 即 bsdtar
//   可解 zip；macOS/Linux 的 tar/unzip 同样可用），然后补齐 install.js 的
//   其余步骤（path.txt、electron.d.ts）。
//
// 幂等：已装好则直接退出，可安全挂到 postinstall。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// 脚本自身所在的包根目录。兜底判断必须基于它，**不能用 process.cwd()** ——
// cwd 不是包根时（CI 的 --prefix、monorepo 子目录、从别处执行
// `node scripts/fix-electron-dist.mjs`）会把「包存在但解析失败」误判成
// 「未安装」并 exit(0)，把安装异常伪装成「无需修复」
const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function log(...a) {
  console.log('[fix-electron]', ...a)
}

// --- 定位 electron 包（pnpm 下 node_modules/electron 是指向 .pnpm 的软链）---
let pkgDir
try {
  pkgDir = path.dirname(require.resolve('electron/package.json'))
} catch (err) {
  log('解析 electron 包路径失败：', (err && err.message) || err)
  // 包目录明明在却解析不到 = 真异常（软链损坏、exports 限制等），
  // 不能当成「未安装」静默 exit(0) —— 那会把「修复失败」伪装成「无需修复」，
  // 与文末专门强调的「必须非零退出」自相矛盾
  if (fs.existsSync(path.join(desktopRoot, 'node_modules', 'electron', 'package.json'))) {
    log('node_modules/electron 存在但无法解析，视为安装异常。')
    process.exit(1)
  }
  log('未找到 electron 包，跳过。')
  process.exit(0)
}
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const version = pkg.version

// 平台白名单：不认识的平台不能静默回落（否则会去找 linux 包，报错也误导）
const PLATFORMS = {
  win32: { platName: 'win32', binPath: 'electron.exe' },
  darwin: { platName: 'darwin', binPath: 'Electron.app/Contents/MacOS/Electron' },
  linux: { platName: 'linux', binPath: 'electron' },
}
const curPlatform = PLATFORMS[process.platform]
if (!curPlatform) {
  log(`不支持的系统 ${process.platform}，请手动解压 electron 二进制。`)
  process.exit(1)
}
const platformPath = curPlatform.binPath
const distDir = path.join(pkgDir, 'dist')
const exePath = path.join(distDir, platformPath)
const pathTxt = path.join(pkgDir, 'path.txt')

// 主程序体积下限**必须按平台区分**：macOS 的 Contents/MacOS/Electron 只是加载
// Electron Framework 的薄壳（几 MB），统一用 20MB 会让 macOS 上 ①幂等检查永远
// 判定 dist 不完整、每次安装重复解压，②解压成功后 tmpOk 仍为 false 而 exit(1)，
// postinstall 必然失败（package.json 已声明 dist:mac，darwin 也在 PLATFORMS 白名单里）
const MIN_BIN_SIZE = process.platform === 'darwin' ? 1024 * 1024 : 20 * 1024 * 1024

// 判定某个 dist 目录里的二进制是否真的可用（幂等检查与解压结果校验共用同一份逻辑，
// 避免两处各写一套阈值后出现「幂等通过但解压校验不过」的自相矛盾）
function binLooksUsable(dir) {
  try {
    if (fs.statSync(path.join(dir, platformPath)).size <= MIN_BIN_SIZE) return false
    if (process.platform === 'darwin') {
      // 薄壳的体积下限不足以证明解压完整，额外要求 framework 目录在位
      const fw = path.join(dir, 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework')
      if (!fs.existsSync(fw)) return false
    }
    return true
  } catch (err) {
    return false
  }
}

// --- 已就绪则跳过（幂等）---
// 只查「文件在」不够：上次解压中断可能留下**截断的** electron.exe，
// 而末尾的存在性校验照样通过 → 永远无法自愈。加版本文件与体积校验。
if (fs.existsSync(exePath) && fs.existsSync(pathTxt)) {
  const size = (() => { try { return fs.statSync(exePath).size } catch (e) { return 0 } })()
  const verOk = (() => {
    try { return fs.readFileSync(path.join(distDir, 'version'), 'utf8').trim() === version } catch (e) { return false }
  })()
  // 体积/完整性判定与解压后校验共用 binLooksUsable（含 macOS 的 framework 检查）
  const sizeOk = binLooksUsable(distDir)
  if (verOk && sizeOk) {
    log(`electron ${version} 二进制已就绪，跳过。`)
    process.exit(0)
  }
  log(`检测到不完整或损坏的 dist（${platformPath} ${size} 字节，版本校验=${verOk}），重新解压。`)
}

// 用户主动跳过 / 覆盖二进制时不该报错
if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  log('ELECTRON_SKIP_BINARY_DOWNLOAD 已设置：属于主动跳过，无需修复。')
  process.exit(0)
}
if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
  log('ELECTRON_OVERRIDE_DIST_PATH 已设置：运行期不使用 node_modules/electron/dist，无需修复。')
  process.exit(0)
}

// --- 在缓存里找对应的 zip ---
// 只支持 electron 官方发布过的架构；不认识的架构**直接失败**，
// 不能静默按 x64 找 —— 那样会解出错误架构的二进制，而末尾的
// 存在性校验照样通过（文件在但跑不起来），故障被掩盖
const SUPPORTED_ARCHS = ['x64', 'arm64', 'ia32']
if (!SUPPORTED_ARCHS.includes(process.arch)) {
  log(`不支持的架构 ${process.arch}，请手动解压 electron 二进制。`)
  process.exit(1)
}
const arch = process.arch
const platName = curPlatform.platName
const zipName = `electron-v${version}-${platName}-${arch}.zip`

const cacheRoots = [
  process.env.ELECTRON_CACHE,
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache'),
  path.join(os.homedir(), '.cache', 'electron'),
  path.join(os.homedir(), 'Library', 'Caches', 'electron'),
].filter(Boolean)

let zipPath = null
for (const rootDir of cacheRoots) {
  if (!fs.existsSync(rootDir)) continue
  for (const entry of fs.readdirSync(rootDir)) {
    const candidate = path.join(rootDir, entry, zipName)
    if (fs.existsSync(candidate)) {
      zipPath = candidate
      break
    }
  }
  if (zipPath) break
}

if (!zipPath) {
  log(`缓存中未找到 ${zipName}`)
  log('请先执行： node node_modules/electron/install.js   （它会下载到缓存）')
  log('然后重新运行本脚本。')
  // ★ 这里必须非零退出：能走到这说明二进制确实缺失（上面的存在性校验没过），
  //   若 exit(0) 会让 `pnpm install` 误判成功，故障被推迟到运行期才以
  //   "Electron failed to install correctly" 暴露，排查成本更高
  process.exit(1)
}
log('使用缓存包:', zipPath, `(${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`)

// --- 解压到**临时目录**，成功后才整体替换 ---
// ★ 不能先把 dist 删掉：万一没有可用解压工具（精简 Linux 镜像常缺 unzip）
//   或 zip 损坏（跨机拷贝缓存 / 下载中断残留），先删会让「本来只是缺
//   path.txt、二进制尚在」的安装被彻底破坏，比不修还糟
const tmpDir = distDir + '.tmp'
fs.rmSync(tmpDir, { recursive: true, force: true })
fs.mkdirSync(tmpDir, { recursive: true })

// ★ 必须用**系统自带**的解压工具：
//   - Windows：System32\tar.exe（bsdtar，能解 zip）。绝不能只写 "tar"——
//     在 git-bash 环境下会解析到 GNU tar，它把 "C:\..." 当成远程主机，
//     报 "Cannot connect to C: resolve failed"。
//   - macOS / Linux：unzip 或 bsdtar 均可。
function extractWith(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  return !r.error && r.status === 0
}

const attempts =
  process.platform === 'win32'
    ? [
        [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipPath, '-C', tmpDir]],
        ['tar', ['-xf', zipPath, '-C', tmpDir, '--force-local']],
        [
          'powershell',
          [
            '-NoProfile',
            '-Command',
            // 单引号在 PowerShell 里需**双写**转义：路径含 ' 时（用户目录/自定义缓存路径）
            // 会把字符串提前闭合、命令被截断
            `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
          ],
        ],
      ]
    : [
        ['unzip', ['-q', '-o', zipPath, '-d', tmpDir]],
        ['tar', ['-xf', zipPath, '-C', tmpDir]],
      ]

let extracted = false
for (const [cmd, args] of attempts) {
  if (extractWith(cmd, args)) {
    extracted = true
    log('解压成功:', cmd)
    break
  }
  log('解压尝试失败:', cmd)
}

// --- 只有确认解压出可执行文件，才动原 dist ---
const tmpOk = extracted && binLooksUsable(tmpDir)
if (!tmpOk) {
  log('解压失败或结果不完整（缺少可用的 ' + platformPath + '），**保留原 dist 不变**。')
  log(`如需手动处理：把 ${zipPath}`)
  log(`  解压到 ${distDir}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(1)
}
fs.rmSync(distDir, { recursive: true, force: true })
fs.renameSync(tmpDir, distDir)
log('已替换 dist/')

// --- 补齐 install.js 的其余步骤 ---
const srcTypes = path.join(distDir, 'electron.d.ts')
if (fs.existsSync(srcTypes)) {
  fs.copyFileSync(srcTypes, path.join(pkgDir, 'electron.d.ts'))
}
fs.writeFileSync(pathTxt, platformPath, 'utf8')

// --- 校验 ---
const ok = binLooksUsable(distDir)
const files = fs.readdirSync(distDir).length
log(`${ok ? '✔' : '✘'} dist/ 条目数=${files}, ${platformPath} ${ok ? '已就位' : '缺失'}`)
if (!ok) process.exit(1)
