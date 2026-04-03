import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineTask } from './pipeline.service'

const mocks = vi.hoisted(() => ({
  queryPlayerPosition: vi.fn(),
  sendPlayerSeek: vi.fn(),
  sendPlayerGapSeek: vi.fn(),
  getPlayerStreamQueueState: vi.fn(),
  getActiveBackend: vi.fn(),
  getActiveBackendType: vi.fn(),
  isNativeRendererBackendType: vi.fn(),
  synthesize: vi.fn(),
  getAudioDuration: vi.fn(),
  extractVideoInfo: vi.fn(),
  cutVideoSegment: vi.fn(),
  splitAudioByDuration: vi.fn(),
  concatVideoFiles: vi.fn(),
}))

vi.mock('../ipc/player.ipc', () => ({
  queryPlayerPosition: mocks.queryPlayerPosition,
  sendPlayerSeek: mocks.sendPlayerSeek,
  sendPlayerGapSeek: mocks.sendPlayerGapSeek,
  getPlayerStreamQueueState: mocks.getPlayerStreamQueueState,
}))

vi.mock('./lipsync-backend', () => ({
  getActiveBackend: mocks.getActiveBackend,
  getActiveBackendType: mocks.getActiveBackendType,
  isNativeRendererBackendType: mocks.isNativeRendererBackendType,
}))

vi.mock('./tts.service', () => ({
  ttsService: {
    synthesize: mocks.synthesize,
  },
}))

vi.mock('../config', () => ({
  getDataDir: () => 'D:\\yunyin\\XYJ2\\xiyiji\\heygem_data',
}))

vi.mock('../utils/ffmpeg', () => ({
  getAudioDuration: mocks.getAudioDuration,
  extractVideoInfo: mocks.extractVideoInfo,
  cutVideoSegment: mocks.cutVideoSegment,
  splitAudioByDuration: mocks.splitAudioByDuration,
  concatVideoFiles: mocks.concatVideoFiles,
}))

import { PipelineService } from './pipeline.service'

function createTask(id: string, audioPath: string): PipelineTask {
  return {
    id,
    avatarVideoPath: 'D:\\videos\\avatar.mp4',
    audioPath,
    source: 'tts',
    status: 'queued',
    progress: 0,
    createdAt: 0,
  }
}

describe('PipelineService frame continuation regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryPlayerPosition.mockResolvedValue(null)
    mocks.getPlayerStreamQueueState.mockReturnValue({
      mode: 'idle',
      depth: 0,
      updatedAt: 0,
    })
  })

  it('uses exact native chunk carry and trusts backend endFrame for the next task', async () => {
    const avatarInfo = {
      fps: 39.67699334177076,
      nFrames: 4807,
    }
    const ackStartFrames: number[] = []
    let invocation = 0

    const backend = {
      name: 'yundingyunbo',
      getStreamingTransport: () => 'chunk' as const,
      hasActiveAppendStream: () => true,
      initAvatar: vi.fn(),
      getAvatarInfo: () => avatarInfo,
      processAudioStream: vi.fn(async (_audioPath: string, _onChunk: unknown, onAck?: (numFrames: number, totalChunks: number) => Promise<number>) => {
        const startFrame = await onAck?.(260, 1)
        ackStartFrames.push(startFrame ?? -1)

        if (invocation === 0) {
          invocation += 1
          return {
            totalChunks: 1,
            totalFrames: 260,
            endFrame: 259,
          }
        }

        invocation += 1
        return {
          totalChunks: 1,
          totalFrames: 276,
          endFrame: 400,
        }
      }),
    }

    mocks.getActiveBackend.mockReturnValue(backend)
    mocks.getActiveBackendType.mockReturnValue('yundingyunbo_video_stream')
    mocks.isNativeRendererBackendType.mockReturnValue(true)

    const service = new PipelineService() as any

    await service.processStreaming(
      createTask('task-1', 'D:\\audio\\a.wav'),
      'D:\\videos\\avatar.mp4',
      'D:\\audio\\a.wav',
    )
    await service.processStreaming(
      createTask('task-2', 'D:\\audio\\b.wav'),
      'D:\\videos\\avatar.mp4',
      'D:\\audio\\b.wav',
    )

    expect(ackStartFrames).toEqual([0, 260])
    expect(service.nextStartFrame).toBe(401)
    expect(mocks.queryPlayerPosition).toHaveBeenCalledTimes(1)

    expect(mocks.sendPlayerGapSeek.mock.calls[0]?.[0]).toBeCloseTo(260 / avatarInfo.fps, 6)
    expect(mocks.sendPlayerGapSeek.mock.calls[1]?.[0]).toBeCloseTo(401 / avatarInfo.fps, 6)
  })

  it('falls back to startFrame + totalFrames when backend returns a null endFrame', async () => {
    const avatarInfo = {
      fps: 25,
      nFrames: 3029,
    }
    const ackStartFrames: number[] = []
    let invocation = 0

    const backend = {
      name: 'yundingyunbo',
      getStreamingTransport: () => 'chunk' as const,
      hasActiveAppendStream: () => true,
      initAvatar: vi.fn(),
      getAvatarInfo: () => avatarInfo,
      processAudioStream: vi.fn(async (_audioPath: string, _onChunk: unknown, onAck?: (numFrames: number, totalChunks: number) => Promise<number>) => {
        const startFrame = await onAck?.(163, 1)
        ackStartFrames.push(startFrame ?? -1)

        if (invocation === 0) {
          invocation += 1
          return {
            totalChunks: 1,
            totalFrames: 163,
            endFrame: null as any,
          }
        }

        invocation += 1
        return {
          totalChunks: 1,
          totalFrames: 145,
          endFrame: null as any,
        }
      }),
    }

    mocks.getActiveBackend.mockReturnValue(backend)
    mocks.getActiveBackendType.mockReturnValue('yundingyunbo_video_stream')
    mocks.isNativeRendererBackendType.mockReturnValue(true)

    const service = new PipelineService() as any

    await service.processStreaming(
      createTask('task-a', 'D:\\audio\\a.wav'),
      'D:\\videos\\avatar.mp4',
      'D:\\audio\\a.wav',
    )
    await service.processStreaming(
      createTask('task-b', 'D:\\audio\\b.wav'),
      'D:\\videos\\avatar.mp4',
      'D:\\audio\\b.wav',
    )

    expect(ackStartFrames).toEqual([0, 163])
    expect(service.nextStartFrame).toBe(308)
    expect(mocks.sendPlayerGapSeek.mock.calls[0]?.[0]).toBeCloseTo(163 / avatarInfo.fps, 6)
    expect(mocks.sendPlayerGapSeek.mock.calls[1]?.[0]).toBeCloseTo(308 / avatarInfo.fps, 6)
  })
})
