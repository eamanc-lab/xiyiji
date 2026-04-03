import { app } from 'electron'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'

function uniq(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((p) => resolve(p)))]
}

function getAncestorDirs(startPath: string): string[] {
  const results: string[] = []
  let current = resolve(startPath)

  while (true) {
    results.push(current)
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return results
}

function hasWorkspaceMarker(rootPath: string): boolean {
  return [
    join(rootPath, 'heygem_data'),
    join(rootPath, 'xiyiji_output'),
    join(rootPath, 'yundingyunbo_v163'),
    join(rootPath, 'DIANJT'),
    join(rootPath, 'DIANJT260224A')
  ].some((candidate) => existsSync(candidate))
}

export function getRuntimeAppDir(): string {
  try {
    if (app?.isPackaged) {
      return dirname(app.getPath('exe'))
    }
  } catch {
    // Fall back to cwd during early startup / tests.
  }
  return resolve(process.cwd())
}

export function getPrimaryResourceRoot(): string {
  const appDir = getRuntimeAppDir()
  const startDirs = uniq([appDir, resolve(process.cwd())])

  for (const candidate of uniq(startDirs.flatMap((dir) => getAncestorDirs(dir)))) {
    if (hasWorkspaceMarker(candidate)) {
      return candidate
    }
  }

  return appDir
}

export function hasDetectedWorkspaceRoot(): boolean {
  return hasWorkspaceMarker(getPrimaryResourceRoot())
}

export function getRuntimeStateRoot(): string {
  return join(getPrimaryResourceRoot(), '.runtime')
}

export function getPortableDataCandidates(): string[] {
  const appDir = getRuntimeAppDir()
  const resourceRoot = getPrimaryResourceRoot()
  return uniq([
    join(resourceRoot, 'heygem_data'),
    join(appDir, 'heygem_data'),
    join(appDir, '..', 'heygem_data')
  ])
}

export function getPortableOutputCandidates(): string[] {
  const appDir = getRuntimeAppDir()
  const resourceRoot = getPrimaryResourceRoot()
  return uniq([
    join(resourceRoot, 'xiyiji_output'),
    join(appDir, 'xiyiji_output'),
    join(appDir, '..', 'xiyiji_output')
  ])
}

export function getPortableDianjtCandidates(): string[] {
  const appDir = getRuntimeAppDir()
  const resourceRoot = getPrimaryResourceRoot()
  return uniq([
    join(resourceRoot, 'DIANJT260224A', 'DIANJT', 'DianJT_Pro'),
    join(resourceRoot, 'DIANJT260224A', 'DIANJT'),
    join(resourceRoot, 'DIANJT', 'DianJT_Pro'),
    join(resourceRoot, 'DIANJT'),
    join(appDir, 'DIANJT', 'DianJT_Pro'),
    join(appDir, 'DIANJT'),
    join(appDir, '..', 'DIANJT', 'DianJT_Pro'),
    join(appDir, '..', 'DIANJT')
  ])
}

export function getPortableYundingyunboCandidates(): string[] {
  const appDir = getRuntimeAppDir()
  const resourceRoot = getPrimaryResourceRoot()
  const cwd = resolve(process.cwd())
  const ancestorRoots = uniq([resourceRoot, appDir, cwd].flatMap((p) => getAncestorDirs(p)))
  const driveRoots = uniq([resourceRoot, appDir, cwd].map((p) => p.slice(0, 3))).filter((p) =>
    /^[A-Za-z]:\\$/.test(p)
  )
  return uniq([
    ...ancestorRoots.map((root) => join(root, 'yundingyunbo_v163')),
    ...driveRoots.flatMap((root) => [
      join(root, 'BaiduNetdiskDownload', 'yundingyunbo_v163'),
      join(root, 'Downloads', 'yundingyunbo_v163')
    ])
  ])
}

export function getDefaultDataDir(): string {
  for (const candidate of getPortableDataCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  if (app?.isPackaged || hasDetectedWorkspaceRoot()) {
    return getPortableDataCandidates()[0]
  }
  return resolve(process.cwd(), 'tmp', 'heygem_data')
}

export function getDefaultOutputDir(): string {
  for (const candidate of getPortableOutputCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  if (app?.isPackaged || hasDetectedWorkspaceRoot()) {
    return getPortableOutputCandidates()[0]
  }
  return resolve(process.cwd(), 'tmp', 'xiyiji_output')
}

export function getDefaultLipSyncBackend(): 'yundingyunbo' {
  return 'yundingyunbo'
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

function normalizeForCompare(targetPath: string): string {
  return resolve(targetPath).replace(/\//g, '\\').toLowerCase()
}

function matchesResolvedPath(value: string, candidates: string[]): boolean {
  const normalizedValue = normalizeForCompare(value)
  return candidates.some((candidate) => normalizeForCompare(candidate) === normalizedValue)
}

function firstExisting(paths: string[]): string | null {
  return paths.find((candidate) => existsSync(candidate)) || null
}

function getPortableOverride(key: string, value: string): string | null {
  if (!app?.isPackaged && !hasDetectedWorkspaceRoot()) {
    return null
  }

  if (key === 'data_dir' && matchesAny(value, [/(^|[\\/])heygem_data([\\/])?$/i])) {
    const candidates = getPortableDataCandidates()
    if (!matchesResolvedPath(value, candidates)) {
      return getDefaultDataDir()
    }
  }

  if (key === 'output_dir' && matchesAny(value, [/(^|[\\/])xiyiji_output([\\/])?$/i])) {
    const candidates = getPortableOutputCandidates()
    if (!matchesResolvedPath(value, candidates)) {
      return getDefaultOutputDir()
    }
  }

  if (key === 'dianjt_base' && matchesAny(value, [/DianJT_Pro/i, /DIANJT/i])) {
    const candidates = getPortableDianjtCandidates()
    if (!matchesResolvedPath(value, candidates)) {
      return firstExisting(candidates) || candidates[0]
    }
  }

  if (key === 'yundingyunbo_base' && matchesAny(value, [/yundingyunbo_v163/i])) {
    const candidates = getPortableYundingyunboCandidates()
    if (!matchesResolvedPath(value, candidates)) {
      return firstExisting(candidates) || candidates[0]
    }
  }

  return null
}

export function normalizeLegacyPath(key: string, value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed

  const packagedOverride = getPortableOverride(key, trimmed)
  if (packagedOverride) return packagedOverride

  if (existsSync(trimmed)) return trimmed

  if (key === 'data_dir' && matchesAny(trimmed, [/(^|[\\/])heygem_data([\\/])?$/i])) {
    return getDefaultDataDir()
  }

  if (key === 'output_dir' && matchesAny(trimmed, [/(^|[\\/])xiyiji_output([\\/])?$/i])) {
    return getDefaultOutputDir()
  }

  if (
    key === 'dianjt_base' &&
    matchesAny(trimmed, [/DianJT_Pro/i, /DIANJT/i])
  ) {
    return firstExisting(getPortableDianjtCandidates()) || getPortableDianjtCandidates()[0]
  }

  if (
    key === 'yundingyunbo_base' &&
    matchesAny(trimmed, [/yundingyunbo_v163/i])
  ) {
    return firstExisting(getPortableYundingyunboCandidates()) || getPortableYundingyunboCandidates()[0]
  }

  return trimmed
}
