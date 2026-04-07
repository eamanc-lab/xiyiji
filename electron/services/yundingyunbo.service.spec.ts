import { describe, expect, it } from 'vitest'
import { resolveYdbAvatarInitPaths, YundingyunboService } from './yundingyunbo.service'

describe('resolveYdbAvatarInitPaths', () => {
  it('uses a prepared reference clip while keeping the full source video for non-camera playback', () => {
    expect(
      resolveYdbAvatarInitPaths({
        inputPath: 'D:\\videos\\full.mp4',
        preparedVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
        cameraMode: false,
      })
    ).toEqual({
      referenceVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
      drivingVideoPath: 'D:\\videos\\full.mp4',
    })
  })

  it('keeps a single path when camera mode is enabled', () => {
    expect(
      resolveYdbAvatarInitPaths({
        inputPath: 'D:\\videos\\full.mp4',
        preparedVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
        cameraMode: true,
      })
    ).toEqual({
      referenceVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
      drivingVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
    })
  })

  it('keeps a single path when the source video does not need clipping', () => {
    expect(
      resolveYdbAvatarInitPaths({
        inputPath: 'D:\\videos\\short.mp4',
        preparedVideoPath: 'D:\\videos\\short.mp4',
        cameraMode: false,
      })
    ).toEqual({
      referenceVideoPath: 'D:\\videos\\short.mp4',
      drivingVideoPath: 'D:\\videos\\short.mp4',
    })
  })

  it('forces driving to match reference clip when video-stream backend requires it', () => {
    expect(
      resolveYdbAvatarInitPaths({
        inputPath: 'D:\\videos\\full.mp4',
        preparedVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
        cameraMode: false,
        forceDrivingMatchesReference: true,
      })
    ).toEqual({
      referenceVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
      drivingVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
    })
  })

  it('does not change short-video behavior when forceDrivingMatchesReference is true', () => {
    expect(
      resolveYdbAvatarInitPaths({
        inputPath: 'D:\\videos\\short.mp4',
        preparedVideoPath: 'D:\\videos\\short.mp4',
        cameraMode: false,
        forceDrivingMatchesReference: true,
      })
    ).toEqual({
      referenceVideoPath: 'D:\\videos\\short.mp4',
      drivingVideoPath: 'D:\\videos\\short.mp4',
    })
  })

  it('does not affect non-video-stream backend when flag is false (default)', () => {
    // Default backend (yundingyunbo) keeps the original split: reference is
    // the clip, driving stays as the full source video. The main bridge does
    // not have the 5s tolerance issue, so this preserves existing behavior.
    expect(
      resolveYdbAvatarInitPaths({
        inputPath: 'D:\\videos\\full.mp4',
        preparedVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
        cameraMode: false,
        forceDrivingMatchesReference: false,
      })
    ).toEqual({
      referenceVideoPath: 'D:\\data\\ydb_refs\\full_clip.mp4',
      drivingVideoPath: 'D:\\videos\\full.mp4',
    })
  })

  it('does not self-supersede when file-mode reference preparation is synchronous', async () => {
    const service = new YundingyunboService() as any

    service.startServer = async () => {}
    service.sendCommand = (command: { id: string }) => {
      const pending = service.pendingRequests.get(command.id)
      if (!pending) {
        throw new Error(`missing pending request for ${command.id}`)
      }
      pending.resolve({ fps: 25, n_frames: 15736 })
    }

    await expect(service.initAvatar('D:\\videos\\full.mp4')).resolves.toBeUndefined()
    expect(service.getAvatarInfo()).toEqual({ fps: 25, nFrames: 15736 })
  })
})
