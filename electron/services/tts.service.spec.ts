import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPost = vi.fn()
const mockGet = vi.fn()
const mockWriteFileSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockConcatAudioFiles = vi.fn()

vi.mock('axios', () => {
  const api = {
    post: mockPost,
    get: mockGet,
    isAxiosError: (value: unknown) => Boolean((value as any)?.isAxiosError)
  }

  return {
    default: api,
    ...api
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'D:\\tts-test')
  }
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync
  }
})

vi.mock('../config', () => ({
  getUcloudTtsApiKey: vi.fn(() => 'test-key'),
  getUcloudTtsModel: vi.fn(() => 'IndexTeam/IndexTTS-2'),
  getUcloudTtsBaseUrl: vi.fn(() => 'https://api.modelverse.cn/v1')
}))

vi.mock('../utils/ffmpeg', () => ({
  concatAudioFiles: mockConcatAudioFiles
}))

function makeAxiosError(status: number, data?: unknown): Error & Record<string, any> {
  const err = new Error(`Request failed with status code ${status}`) as Error & Record<string, any>
  err.isAxiosError = true
  err.response = {
    status,
    data
  }
  return err
}

describe('tts service fallback handling', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(Buffer.from('voice-file'))
    mockConcatAudioFiles.mockResolvedValue(undefined)
  })

  it('falls back to preset voice when the selected cloned voice is missing remotely', async () => {
    mockPost
      .mockRejectedValueOnce(makeAxiosError(400, Buffer.from('voice not found')))
      .mockResolvedValueOnce({ data: Buffer.from('fallback-audio') })
    mockGet.mockResolvedValueOnce({
      data: {
        list: [{ id: 'uspeech:other-voice', name: 'other' }]
      }
    })

    const { TtsService } = await import('./tts.service')
    const service = new TtsService()

    const result = await service.synthesize(
      'uspeech:missing-voice',
      '你好，欢迎来到我们的直播间',
      1
    )

    expect(result.audioPath).toContain('tts_')
    expect(mockPost).toHaveBeenCalledTimes(2)
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      voice: 'uspeech:missing-voice'
    })
    expect(mockPost.mock.calls[1][1]).toMatchObject({
      voice: 'jack_cheng'
    })
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
  })

  it('keeps the original error when the cloned voice still exists in the provider list', async () => {
    mockPost.mockRejectedValueOnce(makeAxiosError(400, Buffer.from('voice temporarily rejected')))
    mockGet.mockResolvedValueOnce({
      data: {
        list: [{ id: 'uspeech:existing-voice', name: 'existing' }]
      }
    })

    const { TtsService } = await import('./tts.service')
    const service = new TtsService()

    await expect(
      service.synthesize('uspeech:existing-voice', '你好，欢迎来到我们的直播间', 1)
    ).rejects.toThrow('Request failed with status code 400')

    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })
})
