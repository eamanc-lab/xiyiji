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

// =============================================================================
// Customer sample data preparation
// =============================================================================
//
// When called with --customer-sample, the seeding step prunes the source
// database down to a single demo configuration so the shipped customer
// package starts in a clean, ready-to-use state. The user picked
// szr.mp4 + ttt as the demo case, and asked for an explicit "演示房间"
// pre-bound to ttt so customers can preview immediately.
//
// Cleanup rules (decided with user, do not change without confirmation):
//   Q1=d  rooms 表清空，再插入 1 个 "演示房间" 绑定 ttt
//   Q2=b  保留 api_keys / accounts / platform_credentials（不动）
//   Q3=c  通过独立 npm script release:customer 触发，默认不开启
//
// IMPORTANT: this only mutates the in-memory db copy + release directory
// files. The source AppData db on the developer machine is never written.

const SAMPLE_AVATAR_NAME = 'szr.mp4'
const SAMPLE_PROFILE_NAME = 'ttt'
const SAMPLE_DEMO_ROOM_NAME = '演示房间'
const SAMPLE_DEMO_ROOM_PLATFORM = 'douyin'

function generateUuidV4() {
  // Lightweight uuid v4 (no external dependency); good enough for db rows.
  const bytes = crypto.randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  )
}

function findSingleAvatarIdByName(db, name) {
  const rows = queryObjects(db, 'SELECT id FROM avatar_videos WHERE name = ? LIMIT 1', [
    name
  ])
  return rows[0] ? String(rows[0].id) : ''
}

function findSingleProfileIdByName(db, name) {
  const rows = queryObjects(db, 'SELECT id FROM dh_profiles WHERE name = ? LIMIT 1', [
    name
  ])
  return rows[0] ? String(rows[0].id) : ''
}

function applyCustomerSampleData(db) {
  log('Applying customer sample data: keep szr.mp4 + ttt only')

  // 1. Locate the sample avatar/profile rows. Both must exist in source db.
  const sampleAvatarId = findSingleAvatarIdByName(db, SAMPLE_AVATAR_NAME)
  if (!sampleAvatarId) {
    fail(
      `Customer sample requires avatar_videos.name='${SAMPLE_AVATAR_NAME}', ` +
        `but it was not found in the source database. Add it via the app first.`
    )
  }
  log(`  sample avatar id: ${sampleAvatarId}`)

  const sampleProfileId = findSingleProfileIdByName(db, SAMPLE_PROFILE_NAME)
  if (!sampleProfileId) {
    fail(
      `Customer sample requires dh_profiles.name='${SAMPLE_PROFILE_NAME}', ` +
        `but it was not found in the source database. Add it via the app first.`
    )
  }
  log(`  sample profile id: ${sampleProfileId}`)

  // 2. Force ttt to bind szr.mp4, set as default. The current ttt may point
  //    to a different video — we always rewrite to keep the package consistent.
  db.run(
    `UPDATE dh_profiles
     SET video_id = ?, is_default = 1, updated_at = datetime('now','localtime')
     WHERE id = ?`,
    [sampleAvatarId, sampleProfileId]
  )
  // Ensure no other row claims is_default=1
  db.run(
    'UPDATE dh_profiles SET is_default = 0 WHERE id <> ?',
    [sampleProfileId]
  )

  // 3. Whitelist deletion: remove every other avatar / profile.
  db.run('DELETE FROM avatar_videos WHERE id <> ?', [sampleAvatarId])
  db.run('DELETE FROM dh_profiles WHERE id <> ?', [sampleProfileId])

  // 4. Clear all script-management tables (Tab3 contents).
  //    These tables CASCADE-delete on rooms anyway, but we clear them
  //    explicitly so behavior is independent of PRAGMA foreign_keys state.
  db.run('DELETE FROM scripts')
  db.run('DELETE FROM forbidden_words')
  db.run('DELETE FROM blacklist')
  db.run('DELETE FROM room_links')
  db.run('DELETE FROM room_settings')

  // 5. Clear all rooms (Q1=d), then insert a single "演示房间" bound to ttt.
  db.run('DELETE FROM rooms')
  const demoRoomId = generateUuidV4()
  db.run(
    `INSERT INTO rooms (id, name, platform, status, profile_id, created_at)
     VALUES (?, ?, ?, 'idle', ?, datetime('now','localtime'))`,
    [demoRoomId, SAMPLE_DEMO_ROOM_NAME, SAMPLE_DEMO_ROOM_PLATFORM, sampleProfileId]
  )
  log(`  demo room created: id=${demoRoomId} name=${SAMPLE_DEMO_ROOM_NAME}`)

  // 6. NOTE: per Q2=b, api_keys / accounts / platform_credentials are NOT
  //    touched. The customer will see whatever the developer machine has.
  //    This is a deliberate choice — change only with explicit approval.
  log('  api_keys / accounts / platform_credentials: untouched (per Q2=b)')

  log('Customer sample data prepared')
}

function isSampleAvatarManagedFile(name, sampleStem) {
  // Managed files are saved as `<stem>_<10char hex>.<ext>`. Match exactly
  // the same prefix to avoid accidentally deleting unrelated files that
  // happen to share a prefix.
  if (!name || !sampleStem) return false
  const lower = name.toLowerCase()
  const prefix = `${sampleStem.toLowerCase()}_`
  if (!lower.startsWith(prefix)) return false
  // After the prefix we expect 10 hex chars + extension.
  const after = lower.slice(prefix.length)
  return /^[0-9a-f]{10}\./.test(after)
}

function cleanReleaseSampleAssets(releaseDir) {
  log('Cleaning release directory of non-sample avatar files')

  const sampleStem = sanitizeStem(SAMPLE_AVATAR_NAME)
  const cleanupTargets = [
    {
      label: 'data/avatar_videos',
      dir: path.join(releaseDir, 'data', 'avatar_videos'),
      keep: (name) => isSampleAvatarManagedFile(name, sampleStem)
    },
    {
      label: 'data/avatar_thumbnails',
      dir: path.join(releaseDir, 'data', 'avatar_thumbnails'),
      keep: (name) => isSampleAvatarManagedFile(name, sampleStem)
    },
    {
      label: 'heygem_data/yundingyunbo_avatar_refs',
      dir: path.join(releaseDir, 'heygem_data', 'yundingyunbo_avatar_refs'),
      // Reference clip names are <stem>_<hash>.mp4 — same prefix rule.
      keep: (name) => isSampleAvatarManagedFile(name, sampleStem)
    },
    {
      label: 'heygem_data/yundingyunbo_characters',
      dir: path.join(releaseDir, 'heygem_data', 'yundingyunbo_characters'),
      // Character cache directories are uuid-named and not name-correlated
      // to the source avatar. Wipe them all here; prewarm will regenerate
      // the cache for szr.mp4 only (because db has only that row left).
      keep: () => false
    }
  ]

  for (const target of cleanupTargets) {
    if (!fs.existsSync(target.dir)) continue
    let removed = 0
    for (const entry of fs.readdirSync(target.dir, { withFileTypes: true })) {
      const name = entry.name
      // Always preserve the cache index file used by yundingyunbo runtime.
      if (entry.isFile() && name === '_cache.json') continue
      if (target.keep(name)) continue
      const full = path.join(target.dir, name)
      try {
        fs.rmSync(full, { recursive: true, force: true })
        removed += 1
      } catch (err) {
        log(`  warning: failed to remove ${full}: ${err.message || err}`)
      }
    }
    if (removed > 0) {
      log(`  ${target.label}: removed ${removed} entry/entries`)
    }
  }

  log('Release sample asset cleanup complete')
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

  const customerSampleMode = String(args['customer-sample'] || '0') === '1'
  if (customerSampleMode) {
    // Apply BEFORE the avatar copy loop runs, so the loop only sees the
    // single sample row and copies just one file.
    applyCustomerSampleData(db)
  }

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

  if (customerSampleMode) {
    // Sweep release directory after db has been pruned but before db is
    // written. This way the file layout matches the row layout.
    cleanReleaseSampleAssets(releaseDir)
  }

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
