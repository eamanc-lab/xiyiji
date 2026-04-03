import { app, BrowserWindow, shell } from 'electron'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { promisify } from 'util'
import { basename, dirname, join, resolve } from 'path'
import { execFile, spawn } from 'child_process'
import http from 'http'
import https from 'https'
import { formatDisplayVersion } from '../../src/shared/app-version'
import { getConfig } from '../config'
import { getRuntimeAppDir } from '../utils/app-paths'
import {
  type AppUpdateManifest,
  type FullPackageInfo,
  compareVersions,
  getUpdateFileName,
  hasNewerVersion,
  normalizeManifest,
  stripUtf8Bom
} from './app-updater-core'

const execFileAsync = promisify(execFile)

type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'applying' | 'error'

interface PersistedDownloadState {
  downloadedVersion: string
  cachedFilePath: string
  stagedDir: string
  manifest: AppUpdateManifest
  downloadedAt: string
}

interface UpdateResultRecord {
  status: 'success' | 'rollback'
  version: string
  timestamp: string
  message: string
  logFile?: string
}

export interface AppUpdaterState {
  isPackaged: boolean
  currentVersion: string
  phase: UpdatePhase
  progress: number
  message: string
  error: string
  availableVersion: string
  lastCheckedAt: string
  manifestUrl: string
  configuredFullPackageUrl: string
  configuredFullPackageCode: string
  downloadedFilePath: string
  stagedDir: string
  manifest: AppUpdateManifest | null
  lastResult: UpdateResultRecord | null
}

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
}

function safeRemove(targetPath: string): void {
  if (!targetPath || !existsSync(targetPath)) {
    return
  }
  try {
    rmSync(targetPath, { recursive: true, force: true })
  } catch (error: any) {
    warnUpdater(`Failed to remove path ${targetPath}: ${error?.message || error}`)
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(dirname(filePath))
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function escapePowerShellSingleQuoted(value: string): string {
  return String(value || '').replace(/'/g, "''")
}

function getUpdaterRoot(): string {
  const localAppData = process.env.LOCALAPPDATA || app.getPath('temp')
  return join(localAppData, 'xiyiji-updater')
}

function getPackagesCacheDir(): string {
  return join(getUpdaterRoot(), 'packages_cache')
}

function getStagingRoot(): string {
  return join(getUpdaterRoot(), 'staging')
}

function getRollbackRoot(): string {
  return join(getUpdaterRoot(), 'rollback')
}

function getLogsRoot(): string {
  return join(getUpdaterRoot(), 'logs')
}

function getStateFilePath(): string {
  return join(getUpdaterRoot(), 'state.json')
}

function getResultFilePath(): string {
  return join(getUpdaterRoot(), 'last-result.json')
}

function getHealthRoot(): string {
  return join(getUpdaterRoot(), 'health')
}

function nowIso(): string {
  return new Date().toISOString()
}

function formatUpdaterLogTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function logUpdater(message: string): void {
  console.log(`[Updater] ${message}`)
}

function warnUpdater(message: string): void {
  console.warn(`[Updater] ${message}`)
}

function appendUpdaterLog(logFile: string, message: string): void {
  if (!logFile) return
  try {
    ensureDir(dirname(logFile))
    appendFileSync(
      logFile,
      `[${formatUpdaterLogTimestamp()}] ${message}\n`,
      'utf8'
    )
  } catch (err: any) {
    warnUpdater(`Failed to append updater log ${logFile}: ${err?.message || err}`)
  }
}

export function getPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return 'powershell.exe'
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function displayVersion(version: string): string {
  return formatDisplayVersion(version) || String(version || '').trim()
}

function createInitialState(): AppUpdaterState {
  return {
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    phase: 'idle',
    progress: 0,
    message: '',
    error: '',
    availableVersion: '',
    lastCheckedAt: '',
    manifestUrl: '',
    configuredFullPackageUrl: '',
    configuredFullPackageCode: '',
    downloadedFilePath: '',
    stagedDir: '',
    manifest: null,
    lastResult: null
  }
}

let state: AppUpdaterState = createInitialState()
let persistentLoaded = false
let activeAction: Promise<unknown> | null = null

function getConfigSnapshot(): {
  manifestUrl: string
  fullPackageUrl: string
  fullPackageCode: string
} {
  return {
    manifestUrl: String(getConfig('update_manifest_url') || '').trim(),
    fullPackageUrl: String(getConfig('full_package_url') || '').trim(),
    fullPackageCode: String(getConfig('full_package_code') || '').trim()
  }
}

function mergeManifestFullPackage(manifest: AppUpdateManifest | null): AppUpdateManifest | null {
  if (!manifest) {
    return null
  }
  const config = getConfigSnapshot()
  const fullPackage: FullPackageInfo = {
    url: manifest.fullPackage?.url || config.fullPackageUrl || undefined,
    code: manifest.fullPackage?.code || config.fullPackageCode || undefined,
    note: manifest.fullPackage?.note
  }
  return {
    ...manifest,
    fullPackage: fullPackage.url || fullPackage.code || fullPackage.note ? fullPackage : undefined
  }
}

function buildStateSnapshot(): AppUpdaterState {
  const config = getConfigSnapshot()
  const manifest = mergeManifestFullPackage(state.manifest)
  return {
    ...state,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    manifestUrl: config.manifestUrl,
    configuredFullPackageUrl: manifest?.fullPackage?.url || config.fullPackageUrl,
    configuredFullPackageCode: manifest?.fullPackage?.code || config.fullPackageCode,
    manifest
  }
}

function buildPublicStateSnapshot(): AppUpdaterState {
  const snapshot = buildStateSnapshot()
  return {
    ...snapshot,
    currentVersion: displayVersion(snapshot.currentVersion),
    availableVersion: snapshot.availableVersion ? displayVersion(snapshot.availableVersion) : '',
    manifest: snapshot.manifest
      ? {
          ...snapshot.manifest,
          version: displayVersion(snapshot.manifest.version)
        }
      : null,
    lastResult: snapshot.lastResult
      ? {
          ...snapshot.lastResult,
          version: displayVersion(snapshot.lastResult.version)
        }
      : null
  }
}

function broadcastState(): void {
  const snapshot = buildPublicStateSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('updater:state', snapshot)
    } catch {
      // Ignore dead windows.
    }
  }
}

function setState(patch: Partial<AppUpdaterState>): AppUpdaterState {
  state = {
    ...state,
    ...patch
  }
  const snapshot = buildPublicStateSnapshot()
  broadcastState()
  return snapshot
}

function ensurePersistentLoaded(): void {
  if (persistentLoaded) {
    return
  }
  persistentLoaded = true

  for (const dirPath of [
    getUpdaterRoot(),
    getPackagesCacheDir(),
    getStagingRoot(),
    getRollbackRoot(),
    getLogsRoot(),
    getHealthRoot()
  ]) {
    ensureDir(dirPath)
  }

  const result = readJsonFile<UpdateResultRecord>(getResultFilePath())
  if (result?.status && result.version) {
    state.lastResult = result
    logUpdater(`Recovered updater result: status=${result.status}, version=${result.version}`)
  }

  const persisted = readJsonFile<PersistedDownloadState>(getStateFilePath())
  if (!persisted) {
    return
  }

  if (persisted.downloadedVersion && compareVersions(app.getVersion(), persisted.downloadedVersion) >= 0) {
    logUpdater(
      `Clearing stale downloaded update state: current=${app.getVersion()}, downloaded=${persisted.downloadedVersion}`
    )
    safeRemove(persisted.stagedDir)
    safeRemove(persisted.cachedFilePath)
    safeRemove(getStateFilePath())
    return
  }

  if (!existsSync(persisted.cachedFilePath) || !existsSync(persisted.stagedDir)) {
    warnUpdater(
      `Clearing invalid downloaded update state because artifacts are missing: cache=${persisted.cachedFilePath}, stage=${persisted.stagedDir}`
    )
    safeRemove(getStateFilePath())
    return
  }

  const stagedAsar = join(persisted.stagedDir, 'resources', 'app.asar')
  if (!existsSync(stagedAsar)) {
    warnUpdater(`Clearing invalid downloaded update state because staged app.asar is missing: ${stagedAsar}`)
    safeRemove(persisted.stagedDir)
    safeRemove(getStateFilePath())
    return
  }

  state = {
    ...state,
    phase: 'downloaded',
    progress: 100,
    message: `已准备好升级到 ${displayVersion(persisted.downloadedVersion)}，点击“立即重启升级”即可安装`,
    availableVersion: persisted.downloadedVersion,
    downloadedFilePath: persisted.cachedFilePath,
    stagedDir: persisted.stagedDir,
    manifest: persisted.manifest
  }
  logUpdater(`Restored downloaded update state for version ${persisted.downloadedVersion}`)
}

function clearPersistedDownloadState(removeArtifacts = false): void {
  const persisted = readJsonFile<PersistedDownloadState>(getStateFilePath())
  if (removeArtifacts && persisted) {
    logUpdater(
      `Clearing persisted update state and artifacts for version ${persisted.downloadedVersion || 'unknown'}`
    )
    safeRemove(persisted.cachedFilePath)
    safeRemove(persisted.stagedDir)
  }
  safeRemove(getStateFilePath())
}

function savePersistedDownloadState(payload: PersistedDownloadState): void {
  writeJsonFile(getStateFilePath(), payload)
  logUpdater(
    `Saved downloaded update state: version=${payload.downloadedVersion}, cache=${payload.cachedFilePath}, stage=${payload.stagedDir}`
  )
}

function assertPackaged(): void {
  if (!app.isPackaged) {
    throw new Error('开发环境不支持在线升级，请在打包后的客户版本中测试')
  }
}

async function withActionLock<T>(action: () => Promise<T>): Promise<T> {
  if (activeAction) {
    throw new Error('已有升级任务在执行，请稍后再试')
  }
  const promise = action()
  activeAction = promise
  try {
    return await promise
  } finally {
    if (activeAction === promise) {
      activeAction = null
    }
  }
}

async function fetchText(url: string, redirectCount = 0): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const client = url.startsWith('https:') ? https : http
    const request = client.get(
      url,
      {
        headers: {
          'User-Agent': `xiyiji-updater/${app.getVersion()}`
        }
      },
      (response) => {
        const statusCode = response.statusCode || 0
        const location = response.headers.location
        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          if (redirectCount >= 5) {
            response.resume()
            rejectPromise(new Error('更新清单重定向次数过多'))
            return
          }
          response.resume()
          const nextUrl = new URL(location, url).toString()
          resolvePromise(fetchText(nextUrl, redirectCount + 1))
          return
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume()
          rejectPromise(new Error(`请求失败，HTTP ${statusCode}`))
          return
        }

        response.setEncoding('utf8')
        let raw = ''
        response.on('data', (chunk) => {
          raw += chunk
        })
        response.on('end', () => resolvePromise(raw))
        response.on('error', rejectPromise)
      }
    )

    request.setTimeout(30000, () => {
      request.destroy(new Error('请求超时'))
    })
    request.on('error', rejectPromise)
  })
}

async function fetchManifest(manifestUrl: string): Promise<AppUpdateManifest> {
  const raw = stripUtf8Bom(await fetchText(manifestUrl))
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('更新清单不是合法 JSON')
  }
  return normalizeManifest(parsed)
}

async function computeSha256(filePath: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex').toLowerCase()))
    stream.on('error', rejectPromise)
  })
}

async function downloadFile(
  url: string,
  destinationPath: string,
  onProgress: (receivedBytes: number, totalBytes: number) => void,
  redirectCount = 0
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const client = url.startsWith('https:') ? https : http
    const request = client.get(
      url,
      {
        headers: {
          'User-Agent': `xiyiji-updater/${app.getVersion()}`
        }
      },
      (response) => {
        const statusCode = response.statusCode || 0
        const location = response.headers.location
        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          if (redirectCount >= 5) {
            response.resume()
            rejectPromise(new Error('更新包重定向次数过多'))
            return
          }
          response.resume()
          resolvePromise(downloadFile(new URL(location, url).toString(), destinationPath, onProgress, redirectCount + 1))
          return
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume()
          rejectPromise(new Error(`下载失败，HTTP ${statusCode}`))
          return
        }

        const totalBytes = Number(response.headers['content-length'] || 0)
        let receivedBytes = 0
        const writer = createWriteStream(destinationPath)

        response.on('data', (chunk) => {
          receivedBytes += chunk.length
          onProgress(receivedBytes, totalBytes)
        })
        response.on('error', (error) => {
          writer.destroy()
          rejectPromise(error)
        })
        writer.on('error', rejectPromise)
        writer.on('finish', () => resolvePromise())
        response.pipe(writer)
      }
    )

    request.setTimeout(60000, () => {
      request.destroy(new Error('下载超时'))
    })
    request.on('error', rejectPromise)
  })
}

async function expandZip(zipPath: string, destinationPath: string): Promise<void> {
  safeRemove(destinationPath)
  ensureDir(destinationPath)

  const command = `Expand-Archive -LiteralPath '${escapePowerShellSingleQuoted(zipPath)}' -DestinationPath '${escapePowerShellSingleQuoted(destinationPath)}' -Force`
  const powerShellExecutable = getPowerShellExecutable()
  logUpdater(`Expanding update archive with ${powerShellExecutable}: ${basename(zipPath)} -> ${destinationPath}`)
  try {
    await execFileAsync(
      powerShellExecutable,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        windowsHide: true,
        timeout: 10 * 60 * 1000
      }
    )
  } catch (error: any) {
    safeRemove(destinationPath)
    throw new Error(`解压更新包失败: ${error?.message || error}`)
  }
}

async function queryDriveFreeBytes(targetPath: string): Promise<number | null> {
  const resolved = resolve(targetPath)
  const drive = resolved.slice(0, 2)
  if (!/^[A-Za-z]:$/.test(drive)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(
      'wmic',
      ['logicaldisk', 'where', `DeviceID='${drive}'`, 'get', 'FreeSpace', '/format:value'],
      {
        windowsHide: true,
        timeout: 10000
      }
    )
    const match = stdout.match(/FreeSpace=(\d+)/)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

async function ensureEnoughDriveSpace(targetPath: string, requiredBytes: number, label: string): Promise<void> {
  if (!requiredBytes || requiredBytes <= 0) {
    return
  }
  const freeBytes = await queryDriveFreeBytes(targetPath)
  if (freeBytes !== null && freeBytes < requiredBytes) {
    const requiredGb = (requiredBytes / 1024 / 1024 / 1024).toFixed(1)
    const freeGb = (freeBytes / 1024 / 1024 / 1024).toFixed(1)
    throw new Error(`${label}磁盘空间不足，需要至少 ${requiredGb} GB，可用仅 ${freeGb} GB`)
  }
}

function ensureAppRootWritable(appRoot: string): void {
  const probeFile = join(appRoot, '.xiyiji-update-write-test')
  try {
    writeFileSync(probeFile, 'ok', 'utf8')
    unlinkSync(probeFile)
  } catch {
    throw new Error('当前程序目录不可写，无法在线升级。请将程序放到可写目录后重试')
  }
}

function getAppRoot(): string {
  return resolve(getRuntimeAppDir())
}

function getApplyScriptPath(): string {
  return join(getUpdaterRoot(), 'apply-update.ps1')
}

function getApplyConfigPath(version: string): string {
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]+/g, '_')
  return join(getUpdaterRoot(), 'handoff', `apply-${safeVersion}-${Date.now()}.json`)
}

function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64')
}

function createApplyScriptContent(): string {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ConfigPath = [string]$env:XIYIJI_UPDATER_CONFIG
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  throw 'Missing XIYIJI_UPDATER_CONFIG environment variable'
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Get-RequiredString {
  param(
    $Value,
    [string]$Name
  )

  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw "Missing $Name in updater config"
  }

  return $text
}

$AppRoot = Get-RequiredString $Config.appRoot 'appRoot'
$StageDir = Get-RequiredString $Config.stageDir 'stageDir'
$BackupDir = Get-RequiredString $Config.backupDir 'backupDir'
$LaunchExe = Get-RequiredString $Config.launchExecutable 'launchExecutable'
$ReadyFile = Get-RequiredString $Config.readyFile 'readyFile'
$HealthFile = Get-RequiredString $Config.healthFile 'healthFile'
$Version = Get-RequiredString $Config.version 'version'
$ResultFile = Get-RequiredString $Config.resultFile 'resultFile'
$LogFile = Get-RequiredString $Config.logFile 'logFile'
$StateFile = Get-RequiredString $Config.stateFile 'stateFile'
$ParentPid = [int]$Config.parentPid
if ($ParentPid -le 0) {
  throw 'Invalid parentPid in updater config'
}

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Remove-PathWithRetry {
  param([string]$TargetPath)
  if (-not (Test-Path -LiteralPath $TargetPath)) { return }
  for ($attempt = 0; $attempt -lt 8; $attempt++) {
    try {
      Remove-Item -LiteralPath $TargetPath -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -ge 7) { throw }
      Start-Sleep -Milliseconds 600
    }
  }
}

function Ensure-Dir {
  param([string]$DirPath)
  if (-not (Test-Path -LiteralPath $DirPath)) {
    New-Item -ItemType Directory -Path $DirPath -Force | Out-Null
  }
}

function Copy-TopLevelContents {
  param(
    [string]$SourcePath,
    [string]$DestinationPath
  )

  Ensure-Dir $DestinationPath
  Get-ChildItem -LiteralPath $SourcePath -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $DestinationPath -Recurse -Force
  }
}

function Clear-AppFilesPreservingData {
  param([string]$RootPath)
  $preserve = @('DIANJT', 'yundingyunbo_v163', 'heygem_data', 'data', 'logs', 'xiyiji_output', '.runtime')
  Get-ChildItem -LiteralPath $RootPath -Force | ForEach-Object {
    if ($preserve -contains $_.Name) { return }
    Remove-PathWithRetry $_.FullName
  }
}

Ensure-Dir (Split-Path -Parent $LogFile)
Ensure-Dir (Split-Path -Parent $ReadyFile)
Write-Log "Updater script started for version $Version"
Write-Log "Updater config loaded from $ConfigPath"
Write-Log "Parameters: AppRoot=$AppRoot StageDir=$StageDir BackupDir=$BackupDir LaunchExe=$LaunchExe ReadyFile=$ReadyFile ParentPid=$ParentPid"

try {
  if (Test-Path -LiteralPath $ResultFile) {
    Remove-Item -LiteralPath $ResultFile -Force
  }
  if (Test-Path -LiteralPath $HealthFile) {
    Remove-Item -LiteralPath $HealthFile -Force
  }
  if (Test-Path -LiteralPath $ReadyFile) {
    Remove-Item -LiteralPath $ReadyFile -Force
  }

  @{
    status = 'ready'
    version = $Version
    timestamp = [DateTime]::UtcNow.ToString('o')
    parentPid = $ParentPid
    logFile = $LogFile
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReadyFile -Encoding UTF8
  Write-Log "Ready marker written: $ReadyFile"

  Write-Log "Waiting for parent process $ParentPid to exit"
  try {
    Wait-Process -Id $ParentPid -Timeout 20 -ErrorAction Stop
    Write-Log "Parent process exited cleanly"
  } catch {
    try {
      $parent = Get-Process -Id $ParentPid -ErrorAction Stop
      if ($null -ne $parent) {
        Write-Log "Parent process still running after timeout, forcing stop"
        Stop-Process -Id $ParentPid -Force -ErrorAction Stop
        Start-Sleep -Seconds 2
        Write-Log "Parent process force-stopped"
      }
    } catch {
      Write-Log "Parent process wait ended: $($_.Exception.Message)"
    }
  }
  Start-Sleep -Milliseconds 800

  Remove-PathWithRetry $BackupDir
  Ensure-Dir $BackupDir

  Write-Log 'Backing up current app files'
  Get-ChildItem -LiteralPath $AppRoot -Force | ForEach-Object {
    if (@('DIANJT', 'yundingyunbo_v163', 'heygem_data', 'data', 'logs', 'xiyiji_output', '.runtime') -contains $_.Name) {
      return
    }
    Copy-Item -LiteralPath $_.FullName -Destination $BackupDir -Recurse -Force
  }

  Write-Log 'Replacing app files'
  Clear-AppFilesPreservingData $AppRoot
  Copy-TopLevelContents -SourcePath $StageDir -DestinationPath $AppRoot

  $launchPath = Join-Path $AppRoot $LaunchExe
  if (-not (Test-Path -LiteralPath $launchPath)) {
    throw "Launch executable not found: $launchPath"
  }

  Write-Log "Launching updated app: $launchPath"
  Start-Process -FilePath $launchPath -WorkingDirectory $AppRoot -ArgumentList @("--xiyiji-health-file=$HealthFile", "--xiyiji-updated-version=$Version") | Out-Null

  $healthy = $false
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $HealthFile) {
      $healthy = $true
      break
    }
    Start-Sleep -Seconds 2
  }

  if (-not $healthy) {
    throw 'Updated app did not report health status in time'
  }

  Write-Log 'Health check passed'
  if (Test-Path -LiteralPath $ReadyFile) {
    Remove-Item -LiteralPath $ReadyFile -Force
  }
  if (Test-Path -LiteralPath $StateFile) {
    Remove-Item -LiteralPath $StateFile -Force
  }

  @{
    status = 'success'
    version = $Version
    timestamp = [DateTime]::UtcNow.ToString('o')
    message = 'Update applied successfully'
    logFile = $LogFile
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ResultFile -Encoding UTF8

  if (Test-Path -LiteralPath $ConfigPath) {
    Remove-Item -LiteralPath $ConfigPath -Force
  }
  Remove-PathWithRetry $BackupDir
  Remove-PathWithRetry $StageDir
  Write-Log 'Updater finished successfully'
  exit 0
} catch {
  $message = $_.Exception.Message
  Write-Log "Update failed: $message"

  try {
    if (Test-Path -LiteralPath $BackupDir) {
      Write-Log 'Restoring backup'
      Clear-AppFilesPreservingData $AppRoot
      Copy-TopLevelContents -SourcePath $BackupDir -DestinationPath $AppRoot
    }

    $rollbackExe = Join-Path $AppRoot $LaunchExe
    if (Test-Path -LiteralPath $rollbackExe) {
      Write-Log 'Relaunching rolled-back app'
      Start-Process -FilePath $rollbackExe -WorkingDirectory $AppRoot | Out-Null
    }
  } catch {
    Write-Log "Rollback failed: $($_.Exception.Message)"
  }

  if (Test-Path -LiteralPath $ReadyFile) {
    Remove-Item -LiteralPath $ReadyFile -Force
  }
  if (Test-Path -LiteralPath $StateFile) {
    Remove-Item -LiteralPath $StateFile -Force
  }

  @{
    status = 'rollback'
    version = $Version
    timestamp = [DateTime]::UtcNow.ToString('o')
    message = $message
    logFile = $LogFile
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ResultFile -Encoding UTF8

  if (Test-Path -LiteralPath $ConfigPath) {
    Remove-Item -LiteralPath $ConfigPath -Force
  }
  exit 1
}
`.trimStart()
}

function createApplyHelperStartCommand(): string {
  const helperCommand = encodePowerShellCommand(createApplyScriptContent())
  const powerShellExecutable = escapePowerShellSingleQuoted(getPowerShellExecutable())

  return [
    `$helperArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${helperCommand}')`,
    `Start-Process -WindowStyle Hidden -FilePath '${powerShellExecutable}' -ArgumentList $helperArgs | Out-Null`
  ].join('; ')
}

function createLogFilePath(version: string): string {
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const timestamp = Date.now()
  return join(getLogsRoot(), `apply-${safeVersion}-${timestamp}.log`)
}

interface DetachedUpdaterLaunchOptions {
  configPath: string
  appRoot: string
  stageDir: string
  backupDir: string
  launchExecutable: string
  readyFile: string
  healthFile: string
  version: string
  resultFile: string
  logFile: string
  stateFile: string
  parentPid: number
}

async function launchDetachedUpdaterHelper(options: DetachedUpdaterLaunchOptions): Promise<number> {
  const powerShellExecutable = getPowerShellExecutable()
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    createApplyHelperStartCommand()
  ]

  appendUpdaterLog(options.logFile, `Main app launching updater helper via starter PowerShell ${powerShellExecutable}`)
  appendUpdaterLog(options.logFile, `Helper config path: ${options.configPath}`)

  return await new Promise<number>((resolvePromise, rejectPromise) => {
    let startupTimer: NodeJS.Timeout | null = null
    let readyPollTimer: NodeJS.Timeout | null = null
    let settled = false
    let starterExitCode: number | null = null
    let starterExitSignal: NodeJS.Signals | null = null

    const finish = (handler: () => void): void => {
      if (settled) return
      settled = true
      if (startupTimer) clearTimeout(startupTimer)
      if (readyPollTimer) clearInterval(readyPollTimer)
      handler()
    }

    const hasReadySignal = (): boolean => {
      try {
        return existsSync(options.readyFile)
      } catch {
        return false
      }
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(powerShellExecutable, args, {
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          XIYIJI_UPDATER_CONFIG: options.configPath
        }
      })
    } catch (error) {
      finish(() => rejectPromise(new Error(`Failed to start updater helper: ${getErrorMessage(error)}`)))
      return
    }

    const childPid = child.pid || 0

    child.once('error', (error) => {
      const errorMessage = getErrorMessage(error)
      appendUpdaterLog(options.logFile, `Updater helper launch error: ${errorMessage}`)
      finish(() => rejectPromise(new Error(`Failed to start updater helper: ${errorMessage}`)))
    })

    child.once('spawn', () => {
      appendUpdaterLog(options.logFile, `Updater helper starter spawned: pid=${childPid || 'unknown'}`)
      readyPollTimer = setInterval(() => {
        if (!hasReadySignal()) return
        appendUpdaterLog(options.logFile, `Updater helper ready signal detected: ${options.readyFile}`)
        finish(() => resolvePromise(childPid))
      }, 100)
    })

    child.once('exit', (code, signal) => {
      const details = `code=${code === null ? 'null' : code}, signal=${signal || 'none'}`
      starterExitCode = code
      starterExitSignal = signal
      if (settled) {
        appendUpdaterLog(options.logFile, `Updater helper starter exited after handoff: ${details}`)
        return
      }
      if (code === 0) {
        appendUpdaterLog(options.logFile, `Updater helper starter completed: ${details}`)
        return
      }
      appendUpdaterLog(options.logFile, `Updater helper starter failed before ready signal: ${details}`)
      finish(() =>
        rejectPromise(
          new Error(`Updater helper exited too early (${details})`)
        )
      )
    })

    startupTimer = setTimeout(() => {
      if (hasReadySignal()) {
        appendUpdaterLog(options.logFile, `Updater helper ready signal detected at timeout boundary: ${options.readyFile}`)
        finish(() => resolvePromise(childPid))
        return
      }
      appendUpdaterLog(
        options.logFile,
        `Updater helper startup timed out before ready signal. starterExitCode=${starterExitCode === null ? 'null' : starterExitCode} starterExitSignal=${starterExitSignal || 'none'}`
      )
      finish(() => rejectPromise(new Error('Updater helper startup timed out')))
    }, 15000)
  })
}

function getLaunchExecutable(manifest: AppUpdateManifest): string {
  return String(manifest.appPackage.launchExecutable || '').trim() || basename(app.getPath('exe'))
}

function getStagedAsarPath(stageDir: string): string {
  return join(stageDir, 'resources', 'app.asar')
}

async function prepareDownload(manifest: AppUpdateManifest): Promise<{ filePath: string; stageDir: string }> {
  logUpdater(`Preparing update download for version ${manifest.version}`)
  clearPersistedDownloadState(true)

  const filePath = join(getPackagesCacheDir(), getUpdateFileName(manifest))
  const stageDir = join(getStagingRoot(), manifest.version)

  ensureDir(dirname(filePath))
  ensureDir(dirname(stageDir))
  safeRemove(filePath)
  safeRemove(stageDir)

  const packageSize = manifest.appPackage.size || 0
  if (packageSize > 0) {
    await ensureEnoughDriveSpace(getPackagesCacheDir(), packageSize + 1024 * 1024 * 512, '缓存目录')
  }

  try {
    logUpdater(`Downloading update package from ${manifest.appPackage.url} to ${filePath}`)
    await downloadFile(manifest.appPackage.url, filePath, (receivedBytes, totalBytes) => {
      const progress = totalBytes > 0 ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : 0
      setState({
        phase: 'downloading',
        progress,
        message: totalBytes > 0
          ? `正在下载更新包 ${progress}%`
          : `正在下载更新包，已接收 ${(receivedBytes / 1024 / 1024).toFixed(1)} MB`,
        error: ''
      })
    })
  } catch (error) {
    safeRemove(filePath)
    throw error
  }

  const actualSha256 = await computeSha256(filePath)
  if (actualSha256 !== manifest.appPackage.sha256.toLowerCase()) {
    safeRemove(filePath)
    throw new Error('更新包校验失败，SHA256 不匹配')
  }

  logUpdater(`Verified update package sha256 for version ${manifest.version}`)

  setState({
    phase: 'downloading',
    progress: 99,
    message: '下载完成，正在解压更新包...',
    error: ''
  })

  await expandZip(filePath, stageDir)

  if (!existsSync(getStagedAsarPath(stageDir))) {
    safeRemove(stageDir)
    throw new Error('解压后的更新包缺少 resources/app.asar')
  }

  logUpdater(`Prepared staged update for version ${manifest.version}: ${stageDir}`)
  return { filePath, stageDir }
}

export function getAppUpdaterState(): AppUpdaterState {
  ensurePersistentLoaded()
  return buildPublicStateSnapshot()
}

export async function checkForUpdates(manifestUrlOverride?: string): Promise<AppUpdaterState> {
  ensurePersistentLoaded()

  return await withActionLock(async () => {
    const config = getConfigSnapshot()
    const manifestUrl = String(manifestUrlOverride || '').trim() || config.manifestUrl
    logUpdater(`Checking for updates. manifestUrl=${manifestUrl || '(empty)'}`)

    if (!manifestUrl) {
      warnUpdater('Update check skipped because manifest URL is empty')
      return setState({
        phase: 'idle',
        manifest: null,
        availableVersion: '',
        message: config.fullPackageUrl
          ? '未配置在线升级清单，可使用完整包下载'
          : '请先在系统设置里配置更新清单 URL',
        error: '',
        progress: 0
      })
    }

    setState({
      phase: 'checking',
      progress: 0,
      message: '正在检查更新...',
      error: ''
    })

    try {
      const manifest = await fetchManifest(manifestUrl)
      const mergedManifest = mergeManifestFullPackage(manifest)
      const updateAvailable = hasNewerVersion(app.getVersion(), manifest.version)
      logUpdater(
        `Fetched manifest version ${manifest.version}. current=${app.getVersion()} available=${updateAvailable}`
      )
      const persisted = readJsonFile<PersistedDownloadState>(getStateFilePath())
      const persistedVersion = String(persisted?.downloadedVersion || '').trim()
      const persistedHasArtifacts = Boolean(
        persistedVersion &&
        persisted?.cachedFilePath &&
        persisted?.stagedDir &&
        existsSync(persisted.cachedFilePath) &&
        existsSync(getStagedAsarPath(persisted.stagedDir))
      )
      if (persistedVersion && compareVersions(manifest.version, persistedVersion) > 0) {
        logUpdater(
          `Discarding prepared downloaded update ${persistedVersion} because newer manifest ${manifest.version} is available`
        )
        clearPersistedDownloadState(true)
      }
      const hasPreparedDownload = persistedVersion === manifest.version && persistedHasArtifacts

      if (hasPreparedDownload && mergedManifest) {
        logUpdater(`Found prepared downloaded update for version ${manifest.version}`)
        return setState({
          phase: 'downloaded',
          progress: 100,
          message: `已准备好升级到 ${displayVersion(manifest.version)}，点击“立即重启升级”即可安装`,
          error: '',
          availableVersion: manifest.version,
          lastCheckedAt: nowIso(),
          downloadedFilePath: persisted.cachedFilePath,
          stagedDir: persisted.stagedDir,
          manifest: mergedManifest
        })
      }

      if (updateAvailable && mergedManifest) {
        logUpdater(`Update available: ${manifest.version}`)
        return setState({
          phase: 'available',
          progress: 0,
          message: `发现新版本 ${displayVersion(manifest.version)}`,
          error: '',
          availableVersion: manifest.version,
          lastCheckedAt: nowIso(),
          downloadedFilePath: '',
          stagedDir: '',
          manifest: mergedManifest
        })
      }

      logUpdater(`No update available. current=${app.getVersion()} manifest=${manifest.version}`)
      return setState({
        phase: 'idle',
        progress: 0,
        message:
          compareVersions(app.getVersion(), manifest.version) > 0
            ? `当前版本 ${displayVersion(app.getVersion())} 高于清单版本 ${displayVersion(manifest.version)}`
            : '当前已是最新版本',
        error: '',
        availableVersion: '',
        lastCheckedAt: nowIso(),
        downloadedFilePath: '',
        stagedDir: '',
        manifest: mergedManifest
      })
    } catch (error: any) {
      warnUpdater(`Update check failed: ${error?.message || String(error)}`)
      return setState({
        phase: 'error',
        progress: 0,
        message: '检查更新失败',
        error: error?.message || String(error),
        availableVersion: '',
        manifest: null
      })
    }
  })
}

export async function downloadUpdate(manifestUrlOverride?: string): Promise<AppUpdaterState> {
  ensurePersistentLoaded()
  assertPackaged()

  return await withActionLock(async () => {
    let manifest = buildStateSnapshot().manifest
    if (!manifest || !hasNewerVersion(app.getVersion(), manifest.version)) {
      const config = getConfigSnapshot()
      const manifestUrl = String(manifestUrlOverride || '').trim() || config.manifestUrl
      if (!manifestUrl) {
        throw new Error('请先在系统设置里配置更新清单 URL')
      }
      manifest = mergeManifestFullPackage(await fetchManifest(manifestUrl))
    }

    if (!manifest) {
      throw new Error('没有可用的更新清单')
    }
    if (!hasNewerVersion(app.getVersion(), manifest.version)) {
      return setState({
        phase: 'idle',
        progress: 0,
        message: '当前已是最新版本',
        error: '',
        availableVersion: '',
        downloadedFilePath: '',
        stagedDir: ''
      })
    }

    logUpdater(`Starting update download for version ${manifest.version}`)

    setState({
      phase: 'downloading',
      progress: 0,
      message: `开始下载 ${displayVersion(manifest.version)} 更新包...`,
      error: '',
      availableVersion: manifest.version
    })

    try {
      const prepared = await prepareDownload(manifest)
      const persisted: PersistedDownloadState = {
        downloadedVersion: manifest.version,
        cachedFilePath: prepared.filePath,
        stagedDir: prepared.stageDir,
        manifest,
        downloadedAt: nowIso()
      }
      savePersistedDownloadState(persisted)
      logUpdater(`Update download completed for version ${manifest.version}`)

      return setState({
        phase: 'downloaded',
        progress: 100,
        message: `更新包已准备完成，点击“立即重启升级”安装 ${displayVersion(manifest.version)}`,
        error: '',
        availableVersion: manifest.version,
        downloadedFilePath: prepared.filePath,
        stagedDir: prepared.stageDir,
        manifest
      })
    } catch (error: any) {
      warnUpdater(`Update download failed: ${error?.message || String(error)}`)
      clearPersistedDownloadState(true)
      return setState({
        phase: 'error',
        progress: 0,
        message: '下载更新失败',
        error: error?.message || String(error),
        downloadedFilePath: '',
        stagedDir: ''
      })
    }
  })
}

export async function applyUpdateAndRestart(): Promise<{ ok: true }> {
  ensurePersistentLoaded()
  assertPackaged()

  const snapshot = buildStateSnapshot()
  if (snapshot.phase !== 'downloaded' || !snapshot.manifest || !snapshot.stagedDir) {
    throw new Error('请先下载更新包，再执行安装')
  }

  const appRoot = getAppRoot()
  ensureAppRootWritable(appRoot)

  const stageSizeBytes = (() => {
    try {
      const stagedAsar = statSync(getStagedAsarPath(snapshot.stagedDir))
      return stagedAsar.size
    } catch {
      return snapshot.manifest?.appPackage.size || 0
    }
  })()
  if (stageSizeBytes > 0) {
    await ensureEnoughDriveSpace(appRoot, stageSizeBytes * 2 + 1024 * 1024 * 512, '程序目录')
  }

  const resultFile = getResultFilePath()
  const logFile = createLogFilePath(snapshot.manifest.version)
  const readyFile = join(getUpdaterRoot(), 'handoff', `ready-${snapshot.manifest.version}-${Date.now()}.json`)
  const healthFile = join(getHealthRoot(), `health-${snapshot.manifest.version}-${Date.now()}.json`)
  const backupDir = join(getRollbackRoot(), `rollback-${snapshot.manifest.version}-${Date.now()}`)
  const configPath = getApplyConfigPath(snapshot.manifest.version)
  const scriptPath = getApplyScriptPath()
  const launchExecutable = getLaunchExecutable(snapshot.manifest)
  writeJsonFile(configPath, {
    appRoot,
    stageDir: snapshot.stagedDir,
    backupDir,
    launchExecutable,
    readyFile,
    healthFile,
    version: snapshot.manifest.version,
    resultFile,
    logFile,
    stateFile: getStateFilePath(),
    parentPid: process.pid
  })
  writeFileSync(scriptPath, createApplyScriptContent(), 'utf8')
  safeRemove(resultFile)
  safeRemove(readyFile)
  logUpdater(
    `Preparing to apply update ${snapshot.manifest.version}. appRoot=${appRoot}, stageDir=${snapshot.stagedDir}, launchExecutable=${launchExecutable}`
  )
  appendUpdaterLog(logFile, `Main app preparing update apply for version ${snapshot.manifest.version}`)
  appendUpdaterLog(logFile, 'Helper launch mode: powershell starter -> Start-Process helper powershell')
  appendUpdaterLog(logFile, `Config path: ${configPath}`)
  appendUpdaterLog(logFile, `Helper script snapshot path: ${scriptPath}`)
  appendUpdaterLog(logFile, `App root: ${appRoot}`)
  appendUpdaterLog(logFile, `Stage dir: ${snapshot.stagedDir}`)
  appendUpdaterLog(logFile, `Backup dir: ${backupDir}`)
  appendUpdaterLog(logFile, `Launch executable: ${launchExecutable}`)
  appendUpdaterLog(logFile, `Ready file: ${readyFile}`)
  appendUpdaterLog(logFile, `Health file: ${healthFile}`)
  appendUpdaterLog(logFile, `Result file: ${resultFile}`)
  appendUpdaterLog(logFile, `State file: ${getStateFilePath()}`)

  setState({
    phase: 'applying',
    progress: 100,
    message: `正在退出并安装 ${displayVersion(snapshot.manifest.version)}...`,
    error: ''
  })

  try {
    const helperPid = await launchDetachedUpdaterHelper({
      configPath,
      appRoot,
      stageDir: snapshot.stagedDir,
      backupDir,
      launchExecutable,
      readyFile,
      healthFile,
      version: snapshot.manifest.version,
      resultFile,
      logFile,
      stateFile: getStateFilePath(),
      parentPid: process.pid
    })
    logUpdater(`Updater helper confirmed running: pid=${helperPid || 'unknown'}`)
    appendUpdaterLog(logFile, `Main app confirmed updater helper is running: pid=${helperPid || 'unknown'}`)

    setTimeout(() => {
      appendUpdaterLog(logFile, 'Main app quitting to allow update apply')
      logUpdater(`Quitting main app for update ${snapshot.manifest?.version || ''}`)
      app.quit()
    }, 250)
  } catch (error) {
    const message = getErrorMessage(error)
    warnUpdater(`Failed to hand off update apply: ${message}`)
    appendUpdaterLog(logFile, `Main app failed to hand off update apply: ${message}`)
    safeRemove(configPath)
    setState({
      phase: 'downloaded',
      progress: 100,
      message: 'Update package is ready, but failed to start the installer helper. Please retry.',
      error: message,
      availableVersion: snapshot.manifest.version,
      downloadedFilePath: snapshot.downloadedFilePath,
      stagedDir: snapshot.stagedDir,
      manifest: snapshot.manifest
    })
    throw error
  }

  return { ok: true }
}

export async function openFullPackageLink(): Promise<{ ok: boolean; url: string; code: string }> {
  ensurePersistentLoaded()
  const snapshot = buildStateSnapshot()
  const fullPackageUrl = snapshot.manifest?.fullPackage?.url || snapshot.configuredFullPackageUrl
  const fullPackageCode = snapshot.manifest?.fullPackage?.code || snapshot.configuredFullPackageCode
  if (!fullPackageUrl) {
    throw new Error('未配置完整包下载链接')
  }
  await shell.openExternal(fullPackageUrl)
  return {
    ok: true,
    url: fullPackageUrl,
    code: fullPackageCode
  }
}

export function clearUpdaterResultMessage(): AppUpdaterState {
  ensurePersistentLoaded()
  safeRemove(getResultFilePath())
  return setState({
    lastResult: null
  })
}
