/**
 * Initialize and register all lip-sync backends.
 * Called once at app startup after database is ready.
 */

import { registerBackend, setActiveBackend } from './lipsync-backend'
import { yundingyunboService } from './yundingyunbo.service'
import { yundingyunboVideoStreamService } from './yundingyunbo-video-stream.service'
import { getLipSyncBackend } from '../config'

export function initLipSyncBackends(): void {
  registerBackend('yundingyunbo', yundingyunboService)
  registerBackend('yundingyunbo_video_stream', yundingyunboVideoStreamService)

  const preferred = (getLipSyncBackend() || '').trim()
  if (preferred && preferred !== 'yundingyunbo' && preferred !== 'yundingyunbo_video_stream') {
    console.warn(`[LipSync] Ignoring unsupported backend '${preferred}', forcing yundingyunbo`)
  }

  setActiveBackend(
    preferred === 'yundingyunbo_video_stream' ? 'yundingyunbo_video_stream' : 'yundingyunbo'
  )
}
