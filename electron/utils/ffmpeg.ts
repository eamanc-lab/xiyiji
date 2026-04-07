import { execFile, exec } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import { getPortableYundingyunboCandidates, getRuntimeAppDir } from './app-paths'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

let ffmpegPath: string | null = null
let ffprobePath: string | null = null

/**
 * Detect FFmpeg/ffprobe paths.
 * Priority: project resources > app resources > system PATH > common locations
 */
export async function detectFfmpeg(): Promise<{ ffmpeg: string; ffprobe: string }> {
  if (ffmpegPath && ffprobePath) {
    return { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
  }

  // Check project resources directory first
  const appDir = getRuntimeAppDir()
  const resourcePaths = [
    join(dirname(app.getAppPath()), 'resources', 'ffmpeg'),
    join(app.getAppPath(), '..', 'resources', 'ffmpeg'),
    join(appDir, 'resources', 'ffmpeg'),
    join(process.cwd(), 'resources', 'ffmpeg')
  ]

  for (const dir of resourcePaths) {
    const ffmpegExe = join(dir, 'ffmpeg.exe')
    const ffprobeExe = join(dir, 'ffprobe.exe')
    if (existsSync(ffmpegExe) && existsSync(ffprobeExe)) {
      ffmpegPath = ffmpegExe
      ffprobePath = ffprobeExe
      return { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
    }
  }

  // Check YDB bundled ffmpeg next. Runtime reference-clip preparation must be
  // able to reuse the same ffmpeg that ships with yundingyunbo portable builds.
  const ydbBases = [
    process.env.YUNDINGYUNBO_BASE || '',
    ...getPortableYundingyunboCandidates()
  ].filter(Boolean)

  for (const base of [...new Set(ydbBases)]) {
    for (const dir of [
      join(base, 'env', 'ffmpeg', 'bin'),
      join(base, 'env_50', 'ffmpeg', 'bin')
    ]) {
      const ffmpegExe = join(dir, 'ffmpeg.exe')
      const ffprobeExe = join(dir, 'ffprobe.exe')
      if (existsSync(ffmpegExe) && existsSync(ffprobeExe)) {
        ffmpegPath = ffmpegExe
        ffprobePath = ffprobeExe
        return { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
      }
    }
  }

  // Check system PATH
  try {
    await execAsync('ffmpeg -version', { timeout: 5000 })
    ffmpegPath = 'ffmpeg'
    ffprobePath = 'ffprobe'
    return { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
  } catch {
    // Not in PATH
  }

  // Check common Windows locations
  const commonPaths = [
    join(process.env.SystemDrive || 'C:', 'ffmpeg', 'bin'),
    join(process.env.ProgramFiles || '', 'ffmpeg', 'bin'),
    join(process.env['ProgramFiles(x86)'] || '', 'ffmpeg', 'bin'),
    join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin'),
    join(process.env.USERPROFILE || '', 'ffmpeg', 'bin')
  ]

  for (const dir of commonPaths) {
    const ffmpegExe = join(dir, 'ffmpeg.exe')
    const ffprobeExe = join(dir, 'ffprobe.exe')
    if (existsSync(ffmpegExe) && existsSync(ffprobeExe)) {
      ffmpegPath = ffmpegExe
      ffprobePath = ffprobeExe
      return { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
    }
  }

  throw new Error('FFmpeg not found. Please install FFmpeg and add it to PATH.')
}

/**
 * Check if FFmpeg is available.
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await detectFfmpeg()
    return true
  } catch {
    return false
  }
}

export interface VideoInfo {
  duration: number
  width: number
  height: number
  fps: number
  codec: string
  hasAudio: boolean
}

/**
 * Extract video metadata using ffprobe.
 */
export async function extractVideoInfo(videoPath: string): Promise<VideoInfo> {
  const { ffprobe } = await detectFfmpeg()

  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    videoPath
  ], { timeout: 15000 })

  const data = JSON.parse(stdout)
  const videoStream = data.streams?.find((s: any) => s.codec_type === 'video')
  const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio')
  const format = data.format || {}

  let fps = 25
  if (videoStream?.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split('/')
    fps = Math.round(parseInt(num) / parseInt(den))
  }

  return {
    duration: parseFloat(format.duration || '0'),
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    fps,
    codec: videoStream?.codec_name || 'unknown',
    hasAudio: !!audioStream
  }
}

/**
 * Extract a thumbnail from video at the given timestamp.
 */
export async function extractThumbnail(
  videoPath: string,
  outputPath: string,
  timestamp: number = 0.5
): Promise<void> {
  const { ffmpeg } = await detectFfmpeg()

  await execFileAsync(ffmpeg, [
    '-ss', String(timestamp),
    '-i', videoPath,
    '-vframes', '1',
    '-q:v', '3',
    '-y',
    outputPath
  ], { timeout: 15000 })
}

/**
 * Extract audio from video as WAV.
 */
export async function extractAudio(
  videoPath: string,
  outputPath: string
): Promise<void> {
  const { ffmpeg } = await detectFfmpeg()

  await execFileAsync(ffmpeg, [
    '-i', videoPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    '-y',
    outputPath
  ], { timeout: 120000 })
}

/**
 * Convert WAV to MP3 (for ASR upload, reduces file size).
 */
export async function wavToMp3(
  inputPath: string,
  outputPath: string
): Promise<void> {
  const { ffmpeg } = await detectFfmpeg()

  await execFileAsync(ffmpeg, [
    '-i', inputPath,
    '-acodec', 'libmp3lame',
    '-q:a', '4',
    '-y',
    outputPath
  ], { timeout: 60000 })
}

/**
 * Merge video and audio into a single file.
 */
export async function mergeAudioVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<void> {
  const { ffmpeg } = await detectFfmpeg()

  await execFileAsync(ffmpeg, [
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-shortest',
    '-y',
    outputPath
  ], { timeout: 300000 })
}

/**
 * Concatenate multiple audio files into one.
 */
export async function concatAudioFiles(
  inputPaths: string[],
  outputPath: string
): Promise<void> {
  const { ffmpeg } = await detectFfmpeg()

  // Build concat filter
  const inputs: string[] = []
  let filterParts: string[] = []

  for (let i = 0; i < inputPaths.length; i++) {
    inputs.push('-i', inputPaths[i])
    filterParts.push(`[${i}:a]`)
  }

  const filter = `${filterParts.join('')}concat=n=${inputPaths.length}:v=0:a=1[out]`

  await execFileAsync(ffmpeg, [
    ...inputs,
    '-filter_complex', filter,
    '-map', '[out]',
    '-y',
    outputPath
  ], { timeout: 120000 })
}

/**
 * Green screen / chroma key export using FFmpeg.
 * Converts HSV parameters to FFmpeg colorkey filter.
 */
export async function chromakeyExport(
  videoPath: string,
  bgPath: string | null,
  params: {
    hue_min: number
    hue_max: number
    sat_min: number
    sat_max: number
    val_min: number
    val_max: number
    smoothing: number
    similarity: number
  },
  outputPath: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  const { ffmpeg } = await detectFfmpeg()

  // Get video info for progress calculation
  const info = await extractVideoInfo(videoPath)
  const totalFrames = info.duration * info.fps

  // Convert HSV center to RGB hex for colorkey
  // Take center of HSV range
  const hCenter = ((params.hue_min + params.hue_max) / 2) / 180  // 0-1
  const sCenter = ((params.sat_min + params.sat_max) / 2) / 255  // 0-1
  const vCenter = ((params.val_min + params.val_max) / 2) / 255  // 0-1

  const rgb = hsvToRgb(hCenter, sCenter, vCenter)
  const colorHex = `0x${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b.toString(16).padStart(2, '0')}`

  const similarity = (params.similarity / 100) * 0.5 // Scale 0-100 to 0-0.5
  const blend = Math.min(params.smoothing / 10, 1.0) // Scale 0-10 to 0-1

  let filterComplex: string
  const args: string[] = ['-i', videoPath]

  if (bgPath && existsSync(bgPath)) {
    // Check if background is image or video
    const bgExt = bgPath.toLowerCase().split('.').pop()
    const isVideo = ['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(bgExt || '')

    if (isVideo) {
      args.push('-i', bgPath)
      filterComplex = `[0:v]colorkey=${colorHex}:${similarity.toFixed(3)}:${blend.toFixed(2)}[fg];[1:v]scale=${info.width}:${info.height}[bg];[bg][fg]overlay`
    } else {
      args.push('-i', bgPath)
      filterComplex = `[1:v]scale=${info.width}:${info.height}[bg];[0:v]colorkey=${colorHex}:${similarity.toFixed(3)}:${blend.toFixed(2)}[fg];[bg][fg]overlay`
    }
  } else {
    // No background - output with alpha (webm) or black background
    filterComplex = `colorkey=${colorHex}:${similarity.toFixed(3)}:${blend.toFixed(2)}`
  }

  args.push(
    '-filter_complex', filterComplex,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-y',
    outputPath
  )

  // Copy audio if exists
  if (info.hasAudio) {
    args.splice(args.indexOf('-filter_complex'), 0, '-c:a', 'aac')
  }

  return new Promise((resolve, reject) => {
    const proc = execFile(ffmpeg, args, { timeout: 600000 }, (error) => {
      if (error) reject(error)
      else resolve()
    })

    // Parse progress from stderr
    proc.stderr?.on('data', (data: string) => {
      const frameMatch = data.toString().match(/frame=\s*(\d+)/)
      if (frameMatch && onProgress && totalFrames > 0) {
        const frame = parseInt(frameMatch[1])
        onProgress(Math.min(Math.round((frame / totalFrames) * 100), 99))
      }
    })
  })
}

/**
 * Cut a segment from a video file.
 * Re-encodes to ensure proper keyframes for HeyGem F2F processing.
 *
 * @param options.fps If specified, force the output video to use this fps
 *   (resamples frames). Useful when the consumer requires a specific fps —
 *   e.g. yundingyunbo's normalized_video uses 25 fps internally, so reference
 *   clips must also be 25 fps to keep frame counts aligned.
 */
export async function cutVideoSegment(
  videoPath: string,
  startSec: number,
  durationSec: number,
  outputPath: string,
  options?: { fps?: number }
): Promise<void> {
  const { ffmpeg } = await detectFfmpeg()
  const timeoutMs = Math.max(
    180000,
    Math.min(900000, Math.round(Math.max(1, durationSec) * 2000 + 60000))
  )

  const fpsArgs: string[] = []
  if (options?.fps && Number.isFinite(options.fps) && options.fps > 0) {
    fpsArgs.push('-r', String(options.fps))
  }

  await execFileAsync(ffmpeg, [
    '-ss', String(startSec),
    '-i', videoPath,
    '-t', String(durationSec),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '18',
    ...fpsArgs,
    '-c:a', 'copy',
    '-y',
    outputPath
  ], { timeout: timeoutMs })
}

/**
 * Get audio duration in seconds.
 */
export async function getAudioDuration(audioPath: string): Promise<number> {
  const { ffprobe } = await detectFfmpeg()

  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'quiet',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    audioPath
  ], { timeout: 10000 })

  return parseFloat(stdout.trim()) || 0
}

/**
 * Split an audio file into chunks of specified duration.
 * Returns array of chunk file paths. If audio is shorter than chunkDuration, returns [audioPath].
 * Tiny remainders (< 1.5s) are merged into the last chunk.
 */
export async function splitAudioByDuration(
  audioPath: string,
  chunkDurationSec: number
): Promise<string[]> {
  const totalDuration = await getAudioDuration(audioPath)
  if (totalDuration <= chunkDurationSec * 1.3) {
    return [audioPath]
  }

  const { ffmpeg } = await detectFfmpeg()
  const dir = dirname(audioPath)
  const ext = audioPath.split('.').pop() || 'wav'
  const chunks: string[] = []

  let offset = 0
  let i = 0
  while (offset < totalDuration) {
    const remaining = totalDuration - offset
    // Merge tiny remainder into previous chunk by extending it
    if (remaining <= chunkDurationSec * 1.3) {
      // This is the last chunk - take all remaining
      const chunkPath = join(dir, `chunk_${Date.now()}_${i}.${ext}`)
      await execFileAsync(ffmpeg, [
        '-ss', String(offset),
        '-i', audioPath,
        '-c', 'copy',
        '-y',
        chunkPath
      ], { timeout: 30000 })
      chunks.push(chunkPath)
      break
    }

    const chunkPath = join(dir, `chunk_${Date.now()}_${i}.${ext}`)
    await execFileAsync(ffmpeg, [
      '-ss', String(offset),
      '-i', audioPath,
      '-t', String(chunkDurationSec),
      '-c', 'copy',
      '-y',
      chunkPath
    ], { timeout: 30000 })
    chunks.push(chunkPath)
    offset += chunkDurationSec
    i++
  }

  return chunks
}

/**
 * Concatenate multiple video files into one using FFmpeg concat demuxer.
 * Uses stream copy (no re-encode) for speed.
 */
export async function concatVideoFiles(
  inputPaths: string[],
  outputPath: string
): Promise<void> {
  if (inputPaths.length === 0) throw new Error('No input files for concat')
  if (inputPaths.length === 1) {
    // Just copy the single file
    const { copyFileSync } = require('fs')
    copyFileSync(inputPaths[0], outputPath)
    return
  }

  const { ffmpeg } = await detectFfmpeg()
  const { writeFileSync } = require('fs')

  // Create concat file list
  const listPath = outputPath + '.concat.txt'
  const listContent = inputPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n')
  writeFileSync(listPath, listContent)

  try {
    await execFileAsync(ffmpeg, [
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-y',
      outputPath
    ], { timeout: 60000 })
  } finally {
    try { require('fs').unlinkSync(listPath) } catch { /* ignore */ }
  }
}

// Helper: HSV to RGB conversion
function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  let r = 0, g = 0, b = 0
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)

  switch (i % 6) {
    case 0: r = v; g = t; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = t; break
    case 3: r = p; g = q; b = v; break
    case 4: r = t; g = p; b = v; break
    case 5: r = v; g = p; b = q; break
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255)
  }
}
