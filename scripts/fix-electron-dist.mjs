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

const require = createRequire(import.meta.url)

function log(...a) {
  console.log('[fix-electron]', ...a)
}

// --- 定位 electron 包（pnpm 下 node_modules/electron 是指向 .pnpm 的软链）---
let pkgDir
try {
  pkgDir = path.dirname(require.resolve('electron/package.json'))
} catch (err) {
  log('未找到 electron 包，跳过。')
  process.exit(0)
}
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const version = pkg.version

const platformPath =
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
const distDir = path.join(pkgDir, 'dist')
const exePath = path.join(distDir, platformPath)
const pathTxt = path.join(pkgDir, 'path.txt')

// --- 已就绪则跳过（幂等）---
if (fs.existsSync(exePath) && fs.existsSync(pathTxt)) {
  log(`electron ${version} 二进制已就绪，跳过。`)
  process.exit(0)
}

// --- 在缓存里找对应的 zip ---
// 只支持 electron 官方发布过的架构；不认识的架构**直接失败**，
// 不能静默按 x64 找 —— 那样会解出错误架构的二进制，而末尾的
// existsSync 校验照样通过（文件在但跑不起来），故障被掩盖
const SUPPORTED_ARCHS = ['x64', 'arm64', 'ia32']
if (!SUPPORTED_ARCHS.includes(process.arch)) {
  log(`不支持的架构 ${process.arch}，请手动解压 electron 二进制。`)
  process.exit(1)
}
const arch = process.arch
const platName = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
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

// --- 清掉 extract-zip 留下的半成品，重新解压 ---
fs.rmSync(distDir, { recursive: true, force: true })
fs.mkdirSync(distDir, { recursive: true })

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
        [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipPath, '-C', distDir]],
        ['tar', ['-xf', zipPath, '-C', distDir, '--force-local']],
        [
          'powershell',
          [
            '-NoProfile',
            '-Command',
            // 单引号在 PowerShell 里需**双写**转义：路径含 ' 时（用户目录/自定义缓存路径）
            // 会把字符串提前闭合、命令被截断
            `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${distDir.replace(/'/g, "''")}' -Force`,
          ],
        ],
      ]
    : [
        ['unzip', ['-q', '-o', zipPath, '-d', distDir]],
        ['tar', ['-xf', zipPath, '-C', distDir]],
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
if (!extracted) {
  log('全部解压方式均失败，请手动解压后重试：')
  log(`  ${zipPath}  ->  ${distDir}`)
  process.exit(1)
}

// --- 补齐 install.js 的其余步骤 ---
const srcTypes = path.join(distDir, 'electron.d.ts')
if (fs.existsSync(srcTypes)) {
  fs.copyFileSync(srcTypes, path.join(pkgDir, 'electron.d.ts'))
}
fs.writeFileSync(pathTxt, platformPath, 'utf8')

// --- 校验 ---
const ok = fs.existsSync(exePath)
const files = fs.readdirSync(distDir).length
log(`${ok ? '✔' : '✘'} dist/ 条目数=${files}, ${platformPath} ${ok ? '已就位' : '缺失'}`)
if (!ok) process.exit(1)
