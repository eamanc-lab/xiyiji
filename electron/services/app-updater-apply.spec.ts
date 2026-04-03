import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockRmSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockAppendFileSync = vi.fn()
const mockUnlinkSync = vi.fn()
const mockStatSync = vi.fn()
const mockSpawn = vi.fn()
const mockQuit = vi.fn()

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '27.0.0',
    getPath: (name: string) => {
      if (name === 'temp') return 'C:\\Temp'
      if (name === 'exe') return 'C:\\App\\云映数字人.exe'
      return 'C:\\Temp'
    },
    quit: mockQuit,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    rmSync: mockRmSync,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    appendFileSync: mockAppendFileSync,
    unlinkSync: mockUnlinkSync,
    statSync: mockStatSync,
  }
})

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ''),
}))

vi.mock('../utils/app-paths', () => ({
  getRuntimeAppDir: vi.fn(() => 'C:\\App'),
}))

describe('app updater apply handoff regression', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    let readyFilePath = ''

    mockExistsSync.mockImplementation((target: unknown) => {
      const value = String(target || '')
      return (
        value.endsWith('state.json') ||
        value.includes('packages_cache\\xiyiji-app-update-28.0.0.zip') ||
        value.includes('staging\\28.0.0') ||
        value === readyFilePath
      )
    })

    mockReadFileSync.mockImplementation((target: unknown) => {
      const value = String(target || '')
      if (value.endsWith('state.json')) {
        return JSON.stringify({
          downloadedVersion: '28.0.0',
          cachedFilePath: 'C:\\Users\\Administrator\\AppData\\Local\\xiyiji-updater\\packages_cache\\xiyiji-app-update-28.0.0.zip',
          stagedDir: 'C:\\Users\\Administrator\\AppData\\Local\\xiyiji-updater\\staging\\28.0.0',
          manifest: {
            version: '28.0.0',
            appPackage: {
              url: 'https://example.com/xiyiji-app-update-28.0.0.zip',
              sha256: 'a'.repeat(64),
              launchExecutable: '云映数字人.exe',
            },
          },
          downloadedAt: '2026-03-29T00:00:00.000Z',
        })
      }
      return ''
    })

    mockStatSync.mockReturnValue({ size: 0 })

    mockSpawn.mockImplementation((_command: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { pid?: number; unref: ReturnType<typeof vi.fn> }
      child.pid = 4321
      child.unref = vi.fn()

      setTimeout(() => {
        const configWrite = mockWriteFileSync.mock.calls.find(([filePath]) =>
          String(filePath || '').includes('handoff\\apply-28.0.0-')
        )
        if (configWrite) {
          const helperConfig = JSON.parse(String(configWrite[1] || '{}'))
          readyFilePath = String(helperConfig.readyFile || '')
        }
        child.emit('spawn')
      }, 0)

      return child
    })
  })

  it('launches the updater helper through a starter PowerShell and a unicode-safe config file', async () => {
    const service = await import('./app-updater.service')

    await expect(service.applyUpdateAndRestart()).resolves.toEqual({ ok: true })

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = mockSpawn.mock.calls[0]
    expect(String(command)).toContain('powershell.exe')
    expect(args).toEqual(
      expect.arrayContaining(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'])
    )
    expect(options).toMatchObject({
      stdio: 'ignore',
      windowsHide: true,
    })
    expect(String(options.env?.XIYIJI_UPDATER_CONFIG || '')).toContain('handoff\\apply-28.0.0-')

    const starterCommand = String(args[args.indexOf('-Command') + 1] || '')
    expect(starterCommand).toContain('Start-Process')
    expect(starterCommand).toContain('-EncodedCommand')
    expect(starterCommand).not.toContain('start "" /b')

    const configWrite = mockWriteFileSync.mock.calls.find(([filePath]) =>
      String(filePath || '').includes('handoff\\apply-28.0.0-')
    )
    expect(configWrite).toBeTruthy()

    const helperConfig = JSON.parse(String(configWrite?.[1] || '{}'))
    expect(helperConfig.appRoot).toBe('C:\\App')
    expect(helperConfig.stageDir).toBe('C:\\Users\\Administrator\\AppData\\Local\\xiyiji-updater\\staging\\28.0.0')
    expect(helperConfig.launchExecutable).toBe('云映数字人.exe')
  })
})
