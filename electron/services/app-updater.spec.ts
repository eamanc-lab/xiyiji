import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  getUpdateFileName,
  hasNewerVersion,
  normalizeManifest,
  stripUtf8Bom
} from './app-updater-core'
import { formatDisplayVersion } from '../../src/shared/app-version'

describe('app updater core', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('4.0.1', '4.0.0')).toBe(1)
    expect(compareVersions('4.0.0', '4.0.0')).toBe(0)
    expect(compareVersions('4.0.0', '4.0.1')).toBe(-1)
    expect(compareVersions('4.0.10', '4.0.2')).toBe(1)
    expect(compareVersions('4.0', '4.0.0')).toBe(0)
    expect(compareVersions('V20', '4.0.3')).toBe(1)
    expect(compareVersions('21.0.0', 'V20')).toBe(1)
  })

  it('formats display versions for the V-series release rule', () => {
    expect(formatDisplayVersion('20.0.0')).toBe('V20')
    expect(formatDisplayVersion('21.0.0')).toBe('V21')
    expect(formatDisplayVersion('4.0.3')).toBe('V4.0.3')
    expect(formatDisplayVersion('V22')).toBe('V22')
  })

  it('normalizes manifest data and extracts filenames', () => {
    const manifest = normalizeManifest({
      version: '4.2.0',
      notes: 'test',
      appPackage: {
        url: 'https://example.com/updates/xiyiji-app-update-4.2.0.zip',
        sha256: 'A'.repeat(64),
        size: '1048576'
      },
      fullPackage: {
        url: 'https://pan.baidu.com/s/example',
        code: '1234'
      }
    })

    expect(manifest.version).toBe('4.2.0')
    expect(manifest.appPackage.sha256).toBe('a'.repeat(64))
    expect(manifest.appPackage.size).toBe(1048576)
    expect(getUpdateFileName(manifest)).toBe('xiyiji-app-update-4.2.0.zip')
    expect(hasNewerVersion('4.0.0', manifest.version)).toBe(true)
  })

  it('rejects invalid manifest payloads', () => {
    expect(() =>
      normalizeManifest({
        version: '',
        appPackage: {
          url: 'https://example.com/app.zip',
          sha256: 'a'.repeat(64)
        }
      })
    ).toThrow('更新清单缺少 version')

    expect(() =>
      normalizeManifest({
        version: '4.0.0',
        appPackage: {
          url: '',
          sha256: 'a'.repeat(64)
        }
      })
    ).toThrow('更新清单缺少有效的 appPackage.url')

    expect(() =>
      normalizeManifest({
        version: '4.0.0',
        appPackage: {
          url: 'https://example.com/app.zip',
          sha256: 'abc'
        }
      })
    ).toThrow('更新清单缺少有效的 appPackage.sha256')
  })

  it('strips utf8 bom before parsing manifest json', () => {
    const raw = `\uFEFF{"version":"4.0.2","appPackage":{"url":"https://example.com/app.zip","sha256":"${'a'.repeat(64)}"}}`
    const manifest = normalizeManifest(JSON.parse(stripUtf8Bom(raw)))

    expect(manifest.version).toBe('4.0.2')
    expect(manifest.appPackage.url).toBe('https://example.com/app.zip')
  })
})
