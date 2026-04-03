import { execFile } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { formatDisplayVersion } from '../../src/shared/app-version'
import { getConfig, getDataDir, getLipSyncBackend, getOutputDir } from '../config'
import {
  getPortableDataCandidates,
  getPortableOutputCandidates,
  getPortableYundingyunboCandidates,
  getRuntimeAppDir,
} from '../utils/app-paths'
import {
  getManagedAvatarVideoDir,
  getPortableDatabasePath,
} from '../utils/portable-data'
import { getLogFilePath, getLogsDir } from '../utils/logger'
import {
  findBridgeScript,
  getPortableFfmpegDirs,
  getPortableNodeDirs,
  resolveYundingyunboBase,
  resolveYundingyunboPython,
} from './yundingyunbo.service'

const execFileAsync = promisify(execFile)

function firstExistingFile(paths: string[]): string {
  return paths.find((candidate) => existsSync(candidate)) || ''
}

function formatBool(value: boolean): string {
  return value ? 'yes' : 'no'
}

function logPathState(label: string, targetPath: string): void {
  const normalized = targetPath || '(empty)'
  console.log(`[SelfCheck] ${label}: ${normalized} | exists=${formatBool(!!targetPath && existsSync(targetPath))}`)
}

async function probeVersion(label: string, filePath: string, args: string[]): Promise<void> {
  if (!filePath || !existsSync(filePath)) {
    console.warn(`[SelfCheck] ${label} probe skipped: executable missing`)
    return
  }

  try {
    const { stdout = '', stderr = '' } = await execFileAsync(filePath, args, {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    const firstLine = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '(no output)'
    console.log(`[SelfCheck] ${label} probe: ${firstLine}`)
  } catch (err: any) {
    console.warn(`[SelfCheck] ${label} probe failed: ${err?.message || err}`)
  }
}

export async function logStartupRuntimeSelfCheck(): Promise<void> {
  console.log('[SelfCheck] Startup runtime check begin')
  const rawVersion = app.getVersion()
  console.log(`[SelfCheck] version: ${formatDisplayVersion(rawVersion)} (raw=${rawVersion})`)

  const runtimeAppDir = getRuntimeAppDir()
  console.log(
    `[SelfCheck] app: packaged=${formatBool(app.isPackaged)} exe=${app.getPath('exe')} runtime_dir=${runtimeAppDir}`
  )
  console.log(
    `[SelfCheck] paths: app=${app.getAppPath()} cwd=${process.cwd()} userData=${app.getPath('userData')}`
  )
  console.log(
    `[SelfCheck] portable db: path=${getPortableDatabasePath()} avatar_assets=${getManagedAvatarVideoDir()}`
  )
  console.log(
    `[SelfCheck] logs: dir=${getLogsDir()} file=${getLogFilePath() || '(not initialized)'}`
  )

  const dataDir = getDataDir()
  const outputDir = getOutputDir()
  const backend = getLipSyncBackend()
  console.log(
    `[SelfCheck] config: requested_backend=${backend} runtime_backend=yundingyunbo data_dir=${dataDir} output_dir=${outputDir}`
  )
  console.log(
    `[SelfCheck] config overrides: yundingyunbo_base=${getConfig('yundingyunbo_base') || '(empty)'}`
  )
  console.log(
    `[SelfCheck] portable candidates: data=${getPortableDataCandidates().join(' | ')} output=${getPortableOutputCandidates().join(' | ')}`
  )
  console.log(
    `[SelfCheck] portable engine candidates: ydb=${getPortableYundingyunboCandidates().join(' | ')}`
  )

  try {
    const yundingBase = resolveYundingyunboBase()
    const yundingPython = resolveYundingyunboPython(yundingBase)
    const bridgeScript = findBridgeScript()
    const nodeDirs = getPortableNodeDirs(yundingBase)
    const ffmpegDirs = getPortableFfmpegDirs(yundingBase)
    const nodeExe = firstExistingFile(nodeDirs.map((dir) => join(dir, 'node.exe')))
    const ffmpegExe = firstExistingFile(ffmpegDirs.map((dir) => join(dir, 'ffmpeg.exe')))
    const overlayInit = join(yundingBase, 'tools', 'get_douyin_flv', 'src', '__init__.py')

    logPathState('YDB base', yundingBase)
    logPathState('YDB python', yundingPython)
    logPathState('YDB bridge script', bridgeScript)
    console.log(`[SelfCheck] YDB node dirs: ${nodeDirs.join(' | ') || '(none)'}`)
    console.log(`[SelfCheck] YDB ffmpeg dirs: ${ffmpegDirs.join(' | ') || '(none)'}`)
    logPathState('YDB node.exe', nodeExe)
    logPathState('YDB ffmpeg.exe', ffmpegExe)
    logPathState('YDB get_douyin_flv init patch', overlayInit)

    await probeVersion('YDB python', yundingPython, ['-V'])
    await probeVersion('YDB node', nodeExe, ['-v'])
    await probeVersion('YDB ffmpeg', ffmpegExe, ['-version'])
  } catch (err: any) {
    console.warn(`[SelfCheck] YDB runtime check failed: ${err?.message || err}`)
  }

  console.log('[SelfCheck] Startup runtime check complete')
}
