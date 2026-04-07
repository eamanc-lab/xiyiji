import { createHash } from 'crypto'
import { basename, dirname, extname, join } from 'path'
import { existsSync, mkdirSync, statSync } from 'fs'
import { getDataDir } from '../config'
import { dbGet } from '../db/index'
import { cutVideoSegment, extractVideoInfo, type VideoInfo } from './ffmpeg'

const AVATAR_REFERENCE_CLIP_POLICY_VERSION = 'v6-25fps'
const CAMERA_REFERENCE_MAX_DURATION_SEC = 12
const AVATAR_REFERENCE_MAX_DURATION_SEC = (() => {
  // Default: 5 minutes. Longer videos (e.g. 27min) would take 70+ minutes
  // for character preprocessing (face detection + XSeg mask generation).
  // 5 minutes is usually enough to capture face angles for the model.
  const raw = Number(process.env.YDB_AVATAR_REFERENCE_MAX_DURATION_SEC || '300')
  if (!Number.isFinite(raw)) return 300
  return raw > 0 ? raw : 300
})()
const AVATAR_REFERENCE_MIN_DURATION_SEC = (() => {
  const raw = Number(process.env.YDB_AVATAR_REFERENCE_MIN_DURATION_SEC || '30')
  if (!Number.isFinite(raw)) return 30
  return raw > 0 ? raw : 30
})()
const AVATAR_REFERENCE_TARGET_FRAME_COUNT = (() => {
  const raw = Number(process.env.YDB_AVATAR_REFERENCE_TARGET_FRAMES || '0')
  if (!Number.isFinite(raw)) return 0
  return raw >= 0 ? raw : 0
})()
const CAMERA_REFERENCE_CLIP_OFFSET_SEC = 1

// yundingyunbo's clone_video_local_v2 normalizes videos to 25 fps internally
// (regardless of source fps). The reference clip we generate must use the same
// fps so that frame counts stay aligned with normalized_video.mp4. Otherwise
// `_resolve_file_mode_runtime_driving` in the video-stream backend triggers
// "raw full video direct playback" because frame_diff > max(180, ref*0.1).
const YDB_REFERENCE_CLIP_NORMALIZED_FPS = 25

function isCameraRecordingPath(path: string): boolean {
  return path.replace(/\\/g, '/').includes('camera_recordings')
}

/**
 * yundingyunbo camera mode still needs a stable avatar video as the lip-sync
 * face reference. Prefer the profile's configured imported video; if the
 * profile has no video or only a temporary camera recording, fall back to the
 * latest non-camera avatar asset.
 */
export function resolveYdbCameraReferenceVideo(profileVideoPath?: string | null): string {
  const preferred = (profileVideoPath || '').trim()
  if (preferred && !isCameraRecordingPath(preferred)) {
    return preferred
  }

  const fallback = dbGet(
    `SELECT file_path
     FROM avatar_videos
     WHERE file_path NOT LIKE '%camera_recordings%'
     ORDER BY created_at DESC
     LIMIT 1`
  )

  const fallbackPath = (fallback?.file_path as string | undefined)?.trim() || ''
  if (fallbackPath) {
    console.log(`[YDB] Camera reference fallback avatar video: ${fallbackPath}`)
    return fallbackPath
  }

  return ''
}

function sanitizeStem(filePath: string): string {
  const stem = basename(filePath, extname(filePath))
  const sanitized = stem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized || 'avatar'
}

function getPreparedReferenceClipPath(
  sourcePath: string,
  clipDirName: string,
  maxDurationSec: number,
  cachePolicyKey: string,
  startSec: number
): string {
  const stat = statSync(sourcePath)
  const key =
    `${basename(sourcePath)}|${stat.size}|${Math.round(stat.mtimeMs)}|` +
    `${clipDirName}|${maxDurationSec}|${cachePolicyKey}|${startSec.toFixed(1)}`
  const hash = createHash('md5').update(key).digest('hex').slice(0, 10)
  const clipDir = join(getDataDir(), clipDirName)
  return join(clipDir, `${sanitizeStem(sourcePath)}_${hash}.mp4`)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function roundClipSecond(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10)
}

export function resolveYdbAvatarReferenceClipDurationSec(
  sourceInfo: Pick<VideoInfo, 'duration' | 'fps'>
): number {
  if (AVATAR_REFERENCE_MAX_DURATION_SEC <= 0) {
    return 0
  }

  const sourceDuration = Number.isFinite(sourceInfo.duration) ? sourceInfo.duration : 0
  const fps = Number.isFinite(sourceInfo.fps) && sourceInfo.fps > 0 ? sourceInfo.fps : 25
  if (sourceDuration <= 0) {
    return AVATAR_REFERENCE_MAX_DURATION_SEC
  }

  const frameLimitedDuration =
    AVATAR_REFERENCE_TARGET_FRAME_COUNT > 0
      ? AVATAR_REFERENCE_TARGET_FRAME_COUNT / fps
      : AVATAR_REFERENCE_MAX_DURATION_SEC
  const effectiveMinDuration = Math.min(sourceDuration, AVATAR_REFERENCE_MIN_DURATION_SEC)
  const effectiveMaxDuration = Math.min(sourceDuration, AVATAR_REFERENCE_MAX_DURATION_SEC)

  return roundClipSecond(
    clamp(frameLimitedDuration, effectiveMinDuration, effectiveMaxDuration)
  )
}

export function pickAvatarReferenceClipStartSec(sourceDuration: number, maxDurationSec: number): number {
  const maxStartSec = Math.max(0, sourceDuration - maxDurationSec)
  if (maxStartSec <= 0) {
    return 0
  }

  // File-mode video_stream must begin from the head of the full video. Using
  // a mid-video reference clip made preview appear to "start in the middle"
  // and also increased mouth/face alignment drift on early segments.
  return 0
}

async function prepareYdbReferenceVideo(
  sourcePath: string,
  clipDirName: string,
  logLabel: string,
  maxDurationSec: number,
  options?: {
    cachePolicyKey?: string
    strictLongVideoClipRequired?: boolean
    pickStartSec?: (sourceDuration: number, maxDurationSec: number) => number
    sourceInfo?: Pick<VideoInfo, 'duration' | 'fps'>
  }
): Promise<string> {
  if (!sourcePath) {
    return ''
  }

  if (!existsSync(sourcePath)) {
    console.warn(`[YDB] ${logLabel} source missing: ${sourcePath}`)
    return ''
  }

  let sourceInfo = options?.sourceInfo
  if (!sourceInfo) {
    try {
      sourceInfo = await extractVideoInfo(sourcePath)
    } catch (err: any) {
      console.warn(
        `[YDB] Failed to inspect ${logLabel}, falling back to source: ${err?.message || err}`
      )
      return sourcePath
    }
  }

  const sourceDuration = Number.isFinite(sourceInfo.duration) ? sourceInfo.duration : 0
  if (maxDurationSec <= 0 || sourceDuration <= 0 || sourceDuration <= maxDurationSec + 0.5) {
    return sourcePath
  }

  const cachePolicyKey = options?.cachePolicyKey || 'legacy'
  const strictLongVideoClipRequired = !!options?.strictLongVideoClipRequired
  const startSec = clamp(
    roundClipSecond(
      options?.pickStartSec
        ? options.pickStartSec(sourceDuration, maxDurationSec)
        : Math.min(CAMERA_REFERENCE_CLIP_OFFSET_SEC, Math.max(0, sourceDuration - maxDurationSec))
    ),
    0,
    Math.max(0, sourceDuration - maxDurationSec)
  )

  const clipPath = getPreparedReferenceClipPath(
    sourcePath,
    clipDirName,
    maxDurationSec,
    cachePolicyKey,
    startSec
  )
  if (existsSync(clipPath)) {
    try {
      const clipInfo = await extractVideoInfo(clipPath)
      const clipDuration = Number.isFinite(clipInfo.duration) ? clipInfo.duration : 0
      if (clipDuration > 0 && clipDuration <= maxDurationSec + 1) {
        console.log(
          `[YDB] Reusing prepared ${logLabel}: ${clipPath} ` +
            `(start=${startSec.toFixed(1)}s, duration=${clipDuration.toFixed(1)}s)`
        )
        return clipPath
      }
    } catch (err: any) {
      console.warn(
        `[YDB] Failed to inspect prepared ${logLabel}, rebuilding: ${err?.message || err}`
      )
    }
  }

  const clipDir = dirname(clipPath)
  if (!existsSync(clipDir)) {
    mkdirSync(clipDir, { recursive: true })
  }

  try {
    await cutVideoSegment(sourcePath, startSec, maxDurationSec, clipPath, {
      fps: YDB_REFERENCE_CLIP_NORMALIZED_FPS,
    })
    const clipInfo = await extractVideoInfo(clipPath)
    const clipDuration = Number.isFinite(clipInfo.duration) ? clipInfo.duration : 0
    if (clipDuration <= 0 || clipDuration > maxDurationSec + 1) {
      throw new Error(
        `prepared clip validation failed (duration=${clipDuration || 0}s, max=${maxDurationSec}s)`
      )
    }
    console.log(
      `[YDB] Prepared ${logLabel}: ${sourcePath} -> ${clipPath} ` +
        `(start=${startSec.toFixed(1)}s, ${sourceDuration.toFixed(1)}s -> ${clipDuration.toFixed(1)}s)`
    )
    return clipPath
  } catch (err: any) {
    if (strictLongVideoClipRequired) {
      throw new Error(
        `Long reference video requires clip preparation, but ${logLabel} failed: ${err?.message || err}`
      )
    }
    console.warn(
      `[YDB] Failed to prepare ${logLabel}, using full source: ${err?.message || err}`
    )
    return sourcePath
  }
}

export async function prepareYdbAvatarVideo(sourcePath?: string | null): Promise<string> {
  const input = (sourcePath || '').trim()
  if (!input) {
    return ''
  }
  if (!existsSync(input)) {
    console.warn(`[YDB] avatar reference clip source missing: ${input}`)
    return ''
  }
  if (AVATAR_REFERENCE_MAX_DURATION_SEC <= 0) return input

  let sourceInfo
  try {
    sourceInfo = await extractVideoInfo(input)
  } catch (err: any) {
    console.warn(
      `[YDB] Failed to inspect avatar reference clip policy, falling back to source: ${err?.message || err}`
    )
    return input
  }

  const maxDurationSec = resolveYdbAvatarReferenceClipDurationSec(sourceInfo)
  console.log(
    `[YDB] Avatar reference clip policy: duration=${sourceInfo.duration.toFixed(1)}s, fps=${sourceInfo.fps || 25}, ` +
      `clip=${maxDurationSec.toFixed(1)}s`
  )

  return prepareYdbReferenceVideo(
    input,
    'yundingyunbo_avatar_refs',
    'avatar reference clip',
    maxDurationSec,
    {
      cachePolicyKey: AVATAR_REFERENCE_CLIP_POLICY_VERSION,
      strictLongVideoClipRequired: true,
      pickStartSec: pickAvatarReferenceClipStartSec,
      sourceInfo,
    }
  )
}

export async function prepareYdbCameraReferenceVideo(
  profileVideoPath?: string | null
): Promise<string> {
  const sourcePath = resolveYdbCameraReferenceVideo(profileVideoPath)
  return prepareYdbReferenceVideo(
    sourcePath,
    'yundingyunbo_camera_refs',
    'camera reference clip',
    CAMERA_REFERENCE_MAX_DURATION_SEC,
    {
      cachePolicyKey: 'camera-early-v1',
    }
  )
}
