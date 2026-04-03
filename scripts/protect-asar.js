const fs = require('fs')
const path = require('path')

/**
 * electron-builder afterPack hook
 * Strip legacy DIANJT/heygem scripts from packaged resources.
 */
exports.default = async function afterPack(context) {
  const scriptsDir = path.join(context.appOutDir, 'resources', 'resources', 'scripts')
  if (!fs.existsSync(scriptsDir)) {
    console.log('[protect] scripts dir not found, skipping')
    return
  }

  const removeFiles = [
    'dianjt_host_server.py',
    'setup_core.py',
    'stream_dinet.py',
    'stream_server.py',
    '_compile_core.bat',
    '_dianjt_core.py',
    '_dianjt_core.py.bak',
    '_dianjt_core.pyd'
  ]

  for (const file of removeFiles) {
    const filePath = path.join(scriptsDir, file)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log(`[protect] Removed legacy runtime file: ${file}`)
    }
  }

  const protectedYdbScripts = ['yundingyunbo_bridge', 'yundingyunbo_camera_proxy']
  for (const baseName of protectedYdbScripts) {
    const pyFile = path.join(scriptsDir, `${baseName}.py`)
    const pycFile = path.join(scriptsDir, `${baseName}.pyc`)
    if (!fs.existsSync(pycFile)) {
      throw new Error(`[protect] Missing protected bytecode: ${path.basename(pycFile)}`)
    }
    if (fs.existsSync(pyFile)) {
      fs.unlinkSync(pyFile)
      console.log(`[protect] Removed protected source file: ${path.basename(pyFile)}`)
    }
  }

  const pycacheDir = path.join(scriptsDir, '__pycache__')
  if (fs.existsSync(pycacheDir)) {
    fs.rmSync(pycacheDir, { recursive: true })
    console.log('[protect] Removed: __pycache__/')
  }
}
