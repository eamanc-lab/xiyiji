import { createHash } from 'crypto'
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { basename, extname, join, resolve } from 'path'
import {
  getDefaultDataDir,
  getPrimaryResourceRoot,
  getRuntimeAppDir,
  hasDetectedWorkspaceRoot
} from './app-paths'

const PORTABLE_DB_DIRNAME = 'data'
const AVATAR_VIDEO_DIRNAME = 'avatar_videos'
const AVATAR_THUMBNAIL_DIRNAME = 'avatar_thumbnails'

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => resolve(value)))]
}

function sanitizeStem(filePath: string): string {
  const stem = basename(filePath, extname(filePath))
  const sanitized = stem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized || 'asset'
}

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
}

function normalizeForCompare(targetPath: string): string {
  return resolve(targetPath).replace(/\//g, '\\').toLowerCase()
}

function pathStartsWith(targetPath: string, basePath: string): boolean {
  const normalizedTarget = `${normalizeForCompare(targetPath)}\\`
  const normalizedBase = `${normalizeForCompare(basePath)}\\`
  return normalizedTarget.startsWith(normalizedBase)
}

function samePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right)
}

function rebaseByMarker(inputPath: string, marker: string, targetRoot: string): string {
  const normalizedInput = inputPath.replace(/\//g, '\\')
  const lowerInput = normalizedInput.toLowerCase()
  const lowerMarker = marker.toLowerCase()
  const index = lowerInput.lastIndexOf(lowerMarker)

  if (index < 0) {
    return ''
  }

  const suffix = normalizedInput.slice(index + marker.length).replace(/^[/\\]+/, '')
  if (!suffix) {
    return targetRoot
  }

  return join(targetRoot, ...suffix.split(/[\\/]+/).filter(Boolean))
}

export function getPortableDatabaseCandidates(): string[] {
  const runtimeAppDir = getRuntimeAppDir()
  return uniq([
    join(runtimeAppDir, PORTABLE_DB_DIRNAME),
    join(runtimeAppDir, '..', PORTABLE_DB_DIRNAME)
  ])
}

export function getPortableDatabaseDir(): string {
  try {
    if (app?.isPackaged || hasDetectedWorkspaceRoot()) {
      return join(getPrimaryResourceRoot(), PORTABLE_DB_DIRNAME)
    }
    return join(app.getPath('userData'), PORTABLE_DB_DIRNAME)
  } catch {
    return join(getPrimaryResourceRoot() || getRuntimeAppDir(), PORTABLE_DB_DIRNAME)
  }
}

export function getPortableDatabasePath(): string {
  return join(getPortableDatabaseDir(), 'xiyiji.db')
}

export function getManagedAvatarVideoDir(): string {
  return join(getPortableDatabaseDir(), AVATAR_VIDEO_DIRNAME)
}

export function getManagedAvatarThumbnailDir(): string {
  return join(getPortableDatabaseDir(), AVATAR_THUMBNAIL_DIRNAME)
}

export function ensurePortableDataDirs(): void {
  for (const dirPath of [
    getPortableDatabaseDir(),
    getManagedAvatarVideoDir(),
    getManagedAvatarThumbnailDir()
  ]) {
    ensureDir(dirPath)
  }
}

function buildManagedFileName(sourcePath: string): string {
  const stat = statSync(sourcePath)
  const fileExt = extname(sourcePath) || '.bin'
  const hash = createHash('md5')
    .update(`${basename(sourcePath)}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 10)

  return `${sanitizeStem(sourcePath)}_${hash}${fileExt.toLowerCase()}`
}

export function copyFileToManagedStorage(
  sourcePath: string,
  kind: 'avatar' | 'thumbnail'
): string {
  const targetDir =
    kind === 'avatar' ? getManagedAvatarVideoDir() : getManagedAvatarThumbnailDir()

  ensureDir(targetDir)

  const resolvedSourcePath = resolve(sourcePath)
  if (pathStartsWith(resolvedSourcePath, targetDir)) {
    return resolvedSourcePath
  }

  const destinationPath = join(targetDir, buildManagedFileName(resolvedSourcePath))
  if (!samePath(resolvedSourcePath, destinationPath)) {
    copyFileSync(resolvedSourcePath, destinationPath)
  }

  return destinationPath
}

export function repairPortableMediaPath(inputPath?: string | null): string {
  const trimmed = String(inputPath || '').trim()
  if (!trimmed) {
    return ''
  }

  const dataDir = getDefaultDataDir()
  const fileName = basename(trimmed)
  const rebasedCandidates = [
    rebaseByMarker(trimmed, '\\data\\avatar_videos\\', getManagedAvatarVideoDir()),
    rebaseByMarker(trimmed, '\\data\\avatar_thumbnails\\', getManagedAvatarThumbnailDir()),
    rebaseByMarker(trimmed, '\\heygem_data\\', dataDir)
  ].filter(Boolean)
  const fallbackCandidates = [
    fileName ? join(getManagedAvatarVideoDir(), fileName) : '',
    fileName ? join(getManagedAvatarThumbnailDir(), fileName) : '',
    fileName ? join(dataDir, 'face2face', 'camera_recordings', fileName) : ''
  ].filter(Boolean)

  if (app?.isPackaged || hasDetectedWorkspaceRoot()) {
    const portableCandidate = rebasedCandidates.find((candidate) => existsSync(candidate))
    if (portableCandidate) {
      return portableCandidate
    }
  }

  if (existsSync(trimmed)) {
    return trimmed
  }

  return [...rebasedCandidates, ...fallbackCandidates].find((candidate) => existsSync(candidate)) || trimmed
}

export function isManagedPortablePath(targetPath?: string | null): boolean {
  const trimmed = String(targetPath || '').trim()
  if (!trimmed) {
    return false
  }

  return [
    getPortableDatabaseDir(),
    getDefaultDataDir()
  ].some((basePath) => existsSync(basePath) && pathStartsWith(trimmed, basePath))
}
