export function formatDisplayVersion(version: string): string {
  const normalized = String(version || '').trim()
  if (!normalized) {
    return ''
  }

  const stripped = normalized.replace(/^[vV]\s*/, '')
  const compactMajorOnly = stripped.match(/^(\d+)(?:\.0+)*$/)
  if (compactMajorOnly) {
    return `V${compactMajorOnly[1]}`
  }

  return `V${stripped}`
}
