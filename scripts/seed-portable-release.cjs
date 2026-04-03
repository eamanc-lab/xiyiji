#!/usr/bin/env node

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const initSqlJs = require('sql.js')

const AVATAR_REFERENCE_MAX_DURATION_SEC = 180
const AVATAR_REFERENCE_MIN_DURATION_SEC = 30
const AVATAR_REFERENCE_TARGET_FRAME_COUNT = 4500
const AVATAR_REFERENCE_CLIP_POLICY_VERSION = 'v3'

function log(message) {
  process.stdout.write(`[seed-release] ${message}\n`)
}

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1'
    args[key] = value
  }
  return args
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function sanitizeStem(filePath) {
  const stem = path.basename(filePath, path.extname(filePath))
  const sanitized = stem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized || 'asset'
}

function stableFileHash(filePath) {
  const stat = fs.statSync(filePath)
  const key = `${path.basename(filePath)}|${stat.size}|${Math.round(stat.mtimeMs)}`
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 10)
}

function buildManagedFileName(filePath) {
  const ext = path.extname(filePath) || '.bin'
  return `${sanitizeStem(filePath)}_${stableFileHash(filePath)}${ext.toLowerCase()}`
}

function normalizeForCompare(targetPath) {
  return path.resolve(targetPath).replace(/\//g, '\\').toLowerCase()
}

function samePath(left, right) {
  return normalizeForCompare(left) === normalizeForCompare(right)
}

function pathStartsWith(targetPath, basePath) {
  const normalizedTarget = `${normalizeForCompare(targetPath)}\\`
  const normalizedBase = `${normalizeForCompare(basePath)}\\`
  return normalizedTarget.startsWith(normalizedBase)
}

function copyManagedFile(sourcePath, targetDir) {
  ensureDir(targetDir)
  const resolvedSourcePath = path.resolve(sourcePath)
  if (pathStartsWith(resolvedSourcePath, targetDir)) {
    return resolvedSourcePath
  }

  const destPath = path.join(targetDir, buildManagedFileName(resolvedSourcePath))
  if (!samePath(resolvedSourcePath, destPath)) {
    fs.copyFileSync(resolvedSourcePath, destPath)
  }
  return destPath
}

function queryObjects(db, sql, params = []) {
  const stmt = db.prepare(sql)
  if (params.length > 0) {
    stmt.bind(params)
  }
  const rows = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}

function upsertSetting(db, key, value) {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  )
}

function tryExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || ''
}

function rebaseByMarker(inputPath, marker, targetRoot) {
  const normalized = inputPath.replace(/\//g, '\\')
  const lowerInput = normalized.toLowerCase()
  const lowerMarker = marker.toLowerCase()
  const index = lowerInput.lastIndexOf(lowerMarker)
  if (index < 0) {
    return ''
  }

  const suffix = normalized.slice(index + marker.length).replace(/^[/\\]+/, '')
  if (!suffix) {
    return targetRoot
  }

  return path.join(targetRoot, ...suffix.split(/[\\/]+/).filter(Boolean))
}

function resolveSourceMediaPath(inputPath, releaseDir, managedVideoDir, managedThumbDir) {
  const trimmed = String(inputPath || '').trim()
  if (!trimmed) {
    return ''
  }

  const fileName = path.basename(trimmed)
  const rebasedCandidates = [
    rebaseByMarker(trimmed, '\\data\\avatar_videos\\', managedVideoDir),
    rebaseByMarker(trimmed, '\\data\\avatar_thumbnails\\', managedThumbDir),
    rebaseByMarker(trimmed, '\\heygem_data\\', path.join(releaseDir, 'heygem_data'))
  ]

  const portableCandidate = tryExisting(rebasedCandidates)
  if (portableCandidate) {
    return portableCandidate
  }

  if (fs.existsSync(trimmed)) {
    return path.resolve(trimmed)
  }

  return tryExisting([
    fileName ? path.join(managedVideoDir, fileName) : '',
    fileName ? path.join(managedThumbDir, fileName) : '',
    fileName ? path.join(releaseDir, 'heygem_data', 'face2face', 'camera_recordings', fileName) : ''
  ])
}

function pickSourceDb(releaseDbPath, appDataDbPath) {
  const candidates = [releaseDbPath, appDataDbPath]
    .filter((candidate) => candidate && fs.existsSync(candidate))
    .map((candidate) => ({
      path: path.resolve(candidate),
      mtimeMs: fs.statSync(candidate).mtimeMs
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)

  return candidates[0] ? candidates[0].path : ''
}

function spawnChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options
  })

  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    fail(`Command failed: ${command} ${args.join(' ')}\n${output}`)
  }

  return result
}

function probeVideoInfo(ffprobeExe, filePath) {
  const result = spawnChecked(ffprobeExe, [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath
  ])

  const parsed = JSON.parse(result.stdout || '{}')
  const duration = Number(parsed?.format?.duration || 0)
  const videoStream = Array.isArray(parsed?.streams)
    ? parsed.streams.find((stream) => stream?.codec_type === 'video')
    : null

  let fps = 25
  if (videoStream?.r_frame_rate) {
    const [num, den] = String(videoStream.r_frame_rate).split('/')
    const numerator = Number(num || 0)
    const denominator = Number(den || 1)
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      fps = Math.max(1, Math.round(numerator / denominator))
    }
  }

  return {
    duration: Number.isFinite(duration) ? duration : 0,
    fps,
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundClipSecond(value) {
  return Math.max(0, Math.round(value * 10) / 10)
}

function resolveAvatarReferenceClipDurationSec(videoInfo) {
  if (!(AVATAR_REFERENCE_MAX_DURATION_SEC > 0)) {
    return 0
  }

  const duration = Number.isFinite(videoInfo?.duration) ? videoInfo.duration : 0
  const fps = Number.isFinite(videoInfo?.fps) && videoInfo.fps > 0 ? videoInfo.fps : 25
  if (duration <= 0) {
    return AVATAR_REFERENCE_MAX_DURATION_SEC
  }

  const frameLimitedDuration =
    AVATAR_REFERENCE_TARGET_FRAME_COUNT > 0
      ? AVATAR_REFERENCE_TARGET_FRAME_COUNT / fps
      : AVATAR_REFERENCE_MAX_DURATION_SEC
  const effectiveMinDuration = Math.min(duration, AVATAR_REFERENCE_MIN_DURATION_SEC)
  const effectiveMaxDuration = Math.min(duration, AVATAR_REFERENCE_MAX_DURATION_SEC)
  return roundClipSecond(clamp(frameLimitedDuration, effectiveMinDuration, effectiveMaxDuration))
}

function pickAvatarReferenceClipStartSec(duration, maxDurationSec) {
  const maxStartSec = Math.max(0, duration - maxDurationSec)
  if (maxStartSec <= 0) {
    return 0
  }

  const targetFraction = duration >= 600 ? 0.35 : duration >= 180 ? 0.25 : 0.15
  const minStartSec = Math.min(maxStartSec, duration >= 180 ? 8 : 3)
  return roundClipSecond(clamp(duration * targetFraction, minStartSec, maxStartSec))
}

function ensurePreparedReferenceClip(sourcePath, clipDir, ffmpegExe, ffprobeExe) {
  const videoInfo = probeVideoInfo(ffprobeExe, sourcePath)
  const clipDurationSec = resolveAvatarReferenceClipDurationSec(videoInfo)
  if (clipDurationSec <= 0 || videoInfo.duration <= clipDurationSec + 0.5) {
    return sourcePath
  }

  ensureDir(clipDir)
  const startSec = pickAvatarReferenceClipStartSec(videoInfo.duration, clipDurationSec)
  const stat = fs.statSync(sourcePath)
  const key =
    `${path.basename(sourcePath)}|${stat.size}|${Math.round(stat.mtimeMs)}|` +
    `yundingyunbo_avatar_refs|${clipDurationSec}|${AVATAR_REFERENCE_CLIP_POLICY_VERSION}|${startSec.toFixed(1)}`
  const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 10)
  const clipPath = path.join(clipDir, `${sanitizeStem(sourcePath)}_${hash}.mp4`)

  if (fs.existsSync(clipPath)) {
    const existingClipInfo = probeVideoInfo(ffprobeExe, clipPath)
    if (existingClipInfo.duration > 0 && existingClipInfo.duration <= clipDurationSec + 1) {
      return clipPath
    }
  }

  spawnChecked(ffmpegExe, [
    '-ss',
    String(startSec),
    '-i',
    sourcePath,
    '-t',
    String(clipDurationSec),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-c:a',
    'copy',
    '-y',
    clipPath
  ])

  return clipPath
}

function prewarmYdbCharacters({
  releaseDir,
  avatarPaths,
  projectDir
}) {
  const ydbBase = path.join(releaseDir, 'yundingyunbo_v163')
  const ydbPython = path.join(ydbBase, 'env', 'python.exe')
  const ffmpegExe = path.join(ydbBase, 'env', 'ffmpeg', 'bin', 'ffmpeg.exe')
  const ffprobeExe = path.join(ydbBase, 'env', 'ffmpeg', 'bin', 'ffprobe.exe')
  const helperScript = path.join(projectDir, 'scripts', 'ydb_prewarm_character.py')
  const dataDir = path.join(releaseDir, 'heygem_data')
  const clipDir = path.join(dataDir, 'yundingyunbo_avatar_refs')

  for (const requiredPath of [ydbPython, ffmpegExe, ffprobeExe, helperScript]) {
    if (!fs.existsSync(requiredPath)) {
      fail(`Missing prewarm dependency: ${requiredPath}`)
    }
  }

  const uniquePaths = [...new Set(avatarPaths.filter(Boolean).map((item) => path.resolve(item)))]
  if (uniquePaths.length === 0) {
    log('No avatar videos found for YDB prewarm; skipping')
    return
  }

  log(`Prewarming YDB character cache for ${uniquePaths.length} avatar video(s)`)
  ensureDir(clipDir)

  for (const avatarPath of uniquePaths) {
    if (!fs.existsSync(avatarPath)) {
      fail(`Cannot prewarm missing avatar video: ${avatarPath}`)
    }

    const preparedPath = ensurePreparedReferenceClip(avatarPath, clipDir, ffmpegExe, ffprobeExe)
    log(`Prewarming avatar cache: ${path.basename(preparedPath)}`)

    spawnChecked(
      ydbPython,
      [
        helperScript,
        '--ydb-base',
        ydbBase,
        '--data-dir',
        dataDir,
        '--video',
        preparedPath
      ],
      {
        cwd: ydbBase,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          YUNDINGYUNBO_BASE: ydbBase,
          XIYIJI_DATA_DIR: dataDir,
          XIYIJI_FFMPEG_DIR: path.dirname(ffmpegExe),
          FFMPEG_BINARY: ffmpegExe,
          IMAGEIO_FFMPEG_EXE: ffmpegExe,
          PYDUB_FFMPEG_PATH: ffmpegExe
        }
      }
    )
  }
}

async function main() {
  const args = parseArgs(process.argv)
  const projectDir = path.resolve(args['project-dir'] || path.join(__dirname, '..'))
  const releaseDir = path.resolve(
    args['release-dir'] || path.join(projectDir, 'release', 'xiyiji-release')
  )
  const appDataDbPath = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'xiyiji', 'data', 'xiyiji.db')
    : ''
  const releaseDbPath = path.join(releaseDir, 'data', 'xiyiji.db')
  const sourceDbPath = pickSourceDb(releaseDbPath, appDataDbPath)

  if (!sourceDbPath) {
    fail(`No source database found. Checked: ${releaseDbPath}${appDataDbPath ? `, ${appDataDbPath}` : ''}`)
  }

  log(`Using source database: ${sourceDbPath}`)

  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(sourceDbPath))

  const dataDir = path.join(releaseDir, 'data')
  const managedVideoDir = path.join(dataDir, 'avatar_videos')
  const managedThumbDir = path.join(dataDir, 'avatar_thumbnails')
  ensureDir(dataDir)
  ensureDir(managedVideoDir)
  ensureDir(managedThumbDir)

  const avatarRows = queryObjects(
    db,
    `SELECT av.id, av.name, av.file_path, av.thumbnail_path, COUNT(p.id) AS profile_count
     FROM avatar_videos av
     LEFT JOIN dh_profiles p ON p.video_id = av.id
     GROUP BY av.id
     ORDER BY av.created_at DESC`
  )

  const missingCriticalAssets = []
  const warnings = []
  const preparedAvatarPaths = []

  for (const row of avatarRows) {
    const sourceVideoPath = resolveSourceMediaPath(
      row.file_path,
      releaseDir,
      managedVideoDir,
      managedThumbDir
    )

    if (!sourceVideoPath) {
      const message = `Missing avatar video: ${row.name || row.id} -> ${row.file_path || '(empty)'}`
      if (Number(row.profile_count || 0) > 0) {
        missingCriticalAssets.push(message)
      } else {
        warnings.push(message)
      }
      continue
    }

    const managedVideoPath = copyManagedFile(sourceVideoPath, managedVideoDir)
    preparedAvatarPaths.push(managedVideoPath)
    if (managedVideoPath !== row.file_path) {
      db.run('UPDATE avatar_videos SET file_path = ? WHERE id = ?', [managedVideoPath, row.id])
    }

    const thumbnailPath = resolveSourceMediaPath(
      row.thumbnail_path,
      releaseDir,
      managedVideoDir,
      managedThumbDir
    )
    if (thumbnailPath) {
      const managedThumbnailPath = copyManagedFile(thumbnailPath, managedThumbDir)
      if (managedThumbnailPath !== row.thumbnail_path) {
        db.run('UPDATE avatar_videos SET thumbnail_path = ? WHERE id = ?', [
          managedThumbnailPath,
          row.id
        ])
      }
    } else if (row.thumbnail_path) {
      warnings.push(`Missing thumbnail: ${row.name || row.id} -> ${row.thumbnail_path}`)
    }
  }

  if (missingCriticalAssets.length > 0) {
    fail(`Portable release data seeding failed:\n${missingCriticalAssets.join('\n')}`)
  }

  upsertSetting(db, 'data_dir', '')
  upsertSetting(db, 'output_dir', '')
  upsertSetting(db, 'dianjt_base', '')
  upsertSetting(db, 'yundingyunbo_base', '')
  upsertSetting(db, 'lipsync_backend', 'yundingyunbo')

  fs.writeFileSync(releaseDbPath, Buffer.from(db.export()))
  db.close()

  warnings.forEach((item) => log(`warning: ${item}`))
  log(`Portable database written: ${releaseDbPath}`)

  if (String(args['skip-prewarm'] || '0') !== '1') {
    prewarmYdbCharacters({
      releaseDir,
      avatarPaths: preparedAvatarPaths,
      projectDir
    })
  } else {
    log('Skipping YDB prewarm by request')
  }

  log('Portable release data seeding complete')
}

main().catch((error) => {
  process.stderr.write(`[seed-release] ERROR: ${error.message}\n`)
  process.exit(1)
})
