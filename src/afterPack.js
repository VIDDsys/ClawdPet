'use strict'
// afterPack 钩子：在 NSIS 封壳之前给内层 EXE 嵌入图标与版本信息。
// 必须在这一步改——portable 成品是 NSIS 自校验包，打包后再改会触发 integrity check 失败。
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const os = require('os')

function findRcedit() {
  if (process.env.RCEGIT_PATH && fs.existsSync(process.env.RCEGIT_PATH)) return process.env.RCEGIT_PATH
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
  if (!fs.existsSync(cache)) return null
  for (const dir of fs.readdirSync(cache)) {
    for (const name of ['rcedit-x64.exe', 'rcedit-ia32.exe']) {
      const p = path.join(cache, dir, name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe')
  const icon = path.join(context.packager.info.projectDir, 'assets', 'icon.ico')
  const rcedit = findRcedit()
  if (!rcedit || !fs.existsSync(exe) || !fs.existsSync(icon)) {
    console.warn('[afterPack] rcedit/icon/exe missing, skip embedding:', { rcedit, exe, icon })
    return
  }
  const version = context.packager.appInfo.version
  await new Promise((resolve, reject) => {
    execFile(rcedit, [exe, '--set-icon', icon,
      '--set-version-string', 'ProductName', 'ClawdPet',
      '--set-version-string', 'FileDescription', 'Clawd Pet - AI Desktop Assistant',
      '--set-version-string', 'FileVersion', version,
      '--set-version-string', 'ProductVersion', version,
      '--set-file-version', version + '.0',
      '--set-product-version', version + '.0'], { windowsHide: true }, e => e ? reject(e) : resolve())
  })
  console.log('[afterPack] icon + version embedded into', exe)
}
