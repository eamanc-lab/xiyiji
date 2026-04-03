import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockRmSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockAppendFileSync = vi.fn()
const mockUnlinkSync = vi.fn()
const mockStatSync = vi.fn()

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '28.0.0',
    getPath: (name: string) => {
      if (name === 'temp') return 'C:\\Temp'
      if (name === 'exe') return 'C:\\App\\云映数字人.exe'
      return 'C:\\Temp'
    },
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

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ''),
}))

vi.mock('../utils/app-paths', () => ({
  getRuntimeAppDir: vi.fn(() => 'C:\\App'),
}))

describe('app updater service regression', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    mockExistsSync.mockImplementation((target: unknown) => {
      const value = String(target || '')
      return (
        value.endsWith('state.json') ||
        value.includes('staging\\4.0.3')
      )
    })

    mockReadFileSync.mockImplementation((target: unknown) => {
      const value = String(target || '')
      if (value.endsWith('state.json')) {
        return JSON.stringify({
          downloadedVersion: '4.0.3',
          cachedFilePath: 'C:\\Users\\Administrator\\AppData\\Local\\xiyiji-updater\\packages_cache\\xiyiji-app-update-4.0.3.zip',
          stagedDir: 'C:\\Users\\Administrator\\AppData\\Local\\xiyiji-updater\\staging\\4.0.3',
          manifest: {
            version: '4.0.3',
            appPackage: {
              url: 'https://example.com/xiyiji-app-update-4.0.3.zip',
              sha256: 'a'.repeat(64),
            },
          },
          downloadedAt: '2026-03-29T00:00:00.000Z',
        })
      }
      return ''
    })

    mockRmSync.mockImplementation((target: unknown) => {
      const value = String(target || '')
      if (value.includes('staging\\4.0.3')) {
        const error = new Error(
          "ENOTEMPTY: directory not empty, rmdir 'C:\\Users\\Administrator\\AppData\\Local\\xiyiji-updater\\staging\\4.0.3\\resources'"
        ) as Error & { code?: string }
        error.code = 'ENOTEMPTY'
        throw error
      }
    })

    mockStatSync.mockReturnValue({ size: 0 })
  })

  it('does not throw when stale staging cleanup hits ENOTEMPTY', async () => {
    const service = await import('./app-updater.service')

    expect(() => service.getAppUpdaterState()).not.toThrow()

    const state = service.getAppUpdaterState()
    expect(state.phase).toBe('idle')
    expect(state.currentVersion).toBe('V28')
    expect(mockRmSync).toHaveBeenCalledWith(
      'C:\\Users\\Administrator\\AppData\\Local\\xiyiji-updater\\staging\\4.0.3',
      { recursive: true, force: true }
    )
  })
})
