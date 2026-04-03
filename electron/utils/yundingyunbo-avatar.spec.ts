import { describe, expect, it } from 'vitest'
import {
  pickAvatarReferenceClipStartSec,
  resolveYdbAvatarReferenceClipDurationSec,
} from './yundingyunbo-avatar'

describe('resolveYdbAvatarReferenceClipDurationSec', () => {
  it('caps long reference videos at three minutes for normal fps', () => {
    expect(
      resolveYdbAvatarReferenceClipDurationSec({
        duration: 10 * 60 * 60,
        fps: 25,
      })
    ).toBe(180)
  })

  it('allows high-fps reference videos to extend up to the three-minute cap', () => {
    expect(
      resolveYdbAvatarReferenceClipDurationSec({
        duration: 10 * 60 * 60,
        fps: 60,
      })
    ).toBe(180)
  })

  it('keeps shorter videos unchanged when they are already under the max clip length', () => {
    expect(
      resolveYdbAvatarReferenceClipDurationSec({
        duration: 45,
        fps: 25,
      })
    ).toBe(45)
  })
})

describe('pickAvatarReferenceClipStartSec', () => {
  it('starts long avatar reference clips from the head of the source video', () => {
    expect(pickAvatarReferenceClipStartSec(1626.1, 75)).toBe(0)
    expect(pickAvatarReferenceClipStartSec(10 * 60 * 60, 180)).toBe(0)
  })

  it('returns zero when the source is shorter than the requested clip', () => {
    expect(pickAvatarReferenceClipStartSec(45, 180)).toBe(0)
  })
})
