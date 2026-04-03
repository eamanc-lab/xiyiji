export interface UpdatePackageInfo {
  url: string
  sha256: string
  size?: number
  fileName?: string
  launchExecutable?: string
}

export interface FullPackageInfo {
  url?: string
  code?: string
  note?: string
}

export interface AppUpdateManifest {
  version: string
  channel?: string
  publishedAt?: string
  notes?: string
  forceUpdate?: boolean
  minSupportedVersion?: string
  appPackage: UpdatePackageInfo
  fullPackage?: FullPackageInfo
}

export function stripUtf8Bom(value: string): string {
  return String(value || '').replace(/^\uFEFF/, '')
}

function normalizeVersionPart(part: string): number {
  const match = String(part || '').match(/\d+/)
  return match ? Number(match[0]) : 0
}

export function compareVersions(left: string, right: string): number {
  const leftParts = String(left || '').split('.').map(normalizeVersionPart)
  const rightParts = String(right || '').split('.').map(normalizeVersionPart)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0
    const b = rightParts[index] ?? 0
    if (a > b) return 1
    if (a < b) return -1
  }

  return 0
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function normalizeSha256(value: string): string {
  return String(value || '').trim().toLowerCase()
}

function isValidSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(normalizeSha256(value))
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim()
  return normalized || undefined
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return undefined
  }
  return Math.round(normalized)
}

export function normalizeManifest(input: unknown): AppUpdateManifest {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, any>
  const appPackageRaw = (raw.appPackage &&
  typeof raw.appPackage === 'object'
    ? raw.appPackage
    : {}) as Record<string, any>
  const fullPackageRaw = (raw.fullPackage &&
  typeof raw.fullPackage === 'object'
    ? raw.fullPackage
    : {}) as Record<string, any>

  const version = String(raw.version || '').trim()
  const url = String(appPackageRaw.url || '').trim()
  const sha256 = normalizeSha256(appPackageRaw.sha256)

  if (!version) {
    throw new Error('更新清单缺少 version')
  }
  if (!isHttpUrl(url)) {
    throw new Error('更新清单缺少有效的 appPackage.url')
  }
  if (!isValidSha256(sha256)) {
    throw new Error('更新清单缺少有效的 appPackage.sha256')
  }

  const manifest: AppUpdateManifest = {
    version,
    channel: normalizeOptionalString(raw.channel),
    publishedAt: normalizeOptionalString(raw.publishedAt),
    notes: normalizeOptionalString(raw.notes),
    forceUpdate: Boolean(raw.forceUpdate),
    minSupportedVersion: normalizeOptionalString(raw.minSupportedVersion),
    appPackage: {
      url,
      sha256,
      size: normalizeOptionalNumber(appPackageRaw.size),
      fileName: normalizeOptionalString(appPackageRaw.fileName),
      launchExecutable: normalizeOptionalString(appPackageRaw.launchExecutable)
    }
  }

  const fullPackage = {
    url: normalizeOptionalString(fullPackageRaw.url),
    code: normalizeOptionalString(fullPackageRaw.code),
    note: normalizeOptionalString(fullPackageRaw.note)
  }
  if (fullPackage.url || fullPackage.code || fullPackage.note) {
    manifest.fullPackage = fullPackage
  }

  return manifest
}

export function getUpdateFileName(manifest: AppUpdateManifest): string {
  const explicitName = String(manifest.appPackage.fileName || '').trim()
  if (explicitName) {
    return explicitName
  }

  try {
    const url = new URL(manifest.appPackage.url)
    const tail = url.pathname.split('/').filter(Boolean).pop()
    if (tail) {
      return tail
    }
  } catch {
    // Ignore invalid URL parsing here because normalizeManifest already validated it.
  }

  return `xiyiji-app-update-${manifest.version}.zip`
}

export function hasNewerVersion(currentVersion: string, manifestVersion: string): boolean {
  return compareVersions(manifestVersion, currentVersion) > 0
}
