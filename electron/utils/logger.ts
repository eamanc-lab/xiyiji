import { appendFileSync, mkdirSync, existsSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { execSync } from 'child_process'
import { getPrimaryResourceRoot, getRuntimeAppDir, hasDetectedWorkspaceRoot } from './app-paths'

let logFilePath = ''
let logsDirPath = ''
let consoleMirrorEnabled = true
let stdioErrorHooked = false

function isBrokenPipeError(err: any): boolean {
  const code = String(err?.code || '')
  const msg = String(err?.message || err || '')
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || msg.includes('EPIPE') || msg.includes('broken pipe')
}

function fmt(...args: any[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
}

function ensureWritableDir(dir: string): boolean {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const probeFile = join(dir, '.write-test')
    writeFileSync(probeFile, 'ok', 'utf8')
    unlinkSync(probeFile)
    return true
  } catch {
    return false
  }
}

function resolveLogsDir(): string {
  const candidates = app.isPackaged || hasDetectedWorkspaceRoot()
    ? [
        join(getPrimaryResourceRoot(), 'logs'),
        join(getRuntimeAppDir(), 'logs'),
        join(app.getPath('userData'), 'logs')
      ]
    : [join(app.getPath('userData'), 'logs')]

  for (const candidate of candidates) {
    if (ensureWritableDir(candidate)) return candidate
  }

  return candidates[0]
}

/**
 * Start writing all console output (main process) to a timestamped log file.
 * Called once inside app.whenReady() so app.getPath() is available.
 * Returns the path of the log file being written.
 */
export function initLogger(): string {
  logsDirPath = resolveLogsDir()

  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  logFilePath = join(logsDirPath, `${stamp}.log`)

  // Use appendFileSync for reliable writes (stream-based approach had 0-byte issues)
  const write = (level: string, args: any[]) => {
    if (!logFilePath) return
    try {
      const ts = new Date().toISOString().slice(11, 23)
      appendFileSync(logFilePath, `[${ts}][${level}] ${fmt(...args)}\n`, 'utf8')
    } catch {
      // ignore write errors — never crash the app over logging
    }
  }

  // Save original console methods BEFORE overriding.
  // Assign to variables that the bundler cannot tree-shake as dead code.
  const _origLog = console.log
  const _origWarn = console.warn
  const _origError = console.error

  const safeMirror = (fn: Function, args: any[]): void => {
    if (!consoleMirrorEnabled) return
    try {
      fn.apply(console, args)
    } catch (err: any) {
      if (isBrokenPipeError(err)) {
        consoleMirrorEnabled = false
        write('WARN', ['[Logger] stdout/stderr pipe broken, disabled console mirror'])
        return
      }
      const msg = String(err?.message || err || '')
      consoleMirrorEnabled = false
      write('WARN', [`[Logger] console mirror disabled due to error: ${msg}`])
    }
  }

  if (!stdioErrorHooked) {
    stdioErrorHooked = true
    const onStdIoError = (label: 'stdout' | 'stderr') => (err: any) => {
      if (!isBrokenPipeError(err)) return
      consoleMirrorEnabled = false
      write('WARN', [`[Logger] ${label} error: ${String(err?.message || err)}`])
    }
    process.stdout?.on('error', onStdIoError('stdout'))
    process.stderr?.on('error', onStdIoError('stderr'))
  }

  console.log = (...args: any[]) => { safeMirror(_origLog, args); write('INFO', args) }
  console.warn = (...args: any[]) => { safeMirror(_origWarn, args); write('WARN', args) }
  console.error = (...args: any[]) => { safeMirror(_origError, args); write('ERROR', args) }

  // First log entry — uses the NEW console.log to verify the pipeline works
  console.log(`[Logger] Logging to: ${logFilePath}`)
  return logFilePath
}

export function getLogFilePath(): string {
  return logFilePath
}

export function getLogsDir(): string {
  return logsDirPath || resolveLogsDir()
}

/** Open the logs folder in Windows Explorer. */
export function openLogsFolder(): void {
  const dir = getLogsDir()
  try {
    execSync(`explorer "${dir}"`, { windowsHide: false })
  } catch {
    // explorer returns non-zero exit sometimes; ignore
  }
}

export function closeLogger(): void {
  // No stream to close — appendFileSync handles cleanup automatically
  logFilePath = ''
  logsDirPath = ''
}
