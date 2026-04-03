import { ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { dbAll, dbGet, dbRun, saveDatabase } from '../db/index'
import { getDataDir } from '../config'
import { detectFfmpeg, extractVideoInfo } from '../utils/ffmpeg'

export function registerProfileIpc(): void {
  // List all profiles with video name and room count
  ipcMain.handle('profile:list', () => {
    return dbAll(`
      SELECT p.*,
             v.name AS video_name,
             v.file_path AS video_file_path,
             v.duration_sec AS video_duration_sec,
             v.fps AS video_fps,
             v.thumbnail_path,
             COUNT(r.id) AS room_count
      FROM dh_profiles p
      LEFT JOIN avatar_videos v ON v.id = p.video_id
      LEFT JOIN rooms r ON r.profile_id = p.id
      GROUP BY p.id
      ORDER BY p.is_default DESC, p.created_at DESC
    `)
  })

  // Get single profile
  ipcMain.handle('profile:get', (_e, id: string) => {
    return dbGet(`
      SELECT p.*,
             v.name AS video_name,
             v.file_path AS video_file_path,
             v.duration_sec AS video_duration_sec,
             v.fps AS video_fps,
             v.thumbnail_path
      FROM dh_profiles p
      LEFT JOIN avatar_videos v ON v.id = p.video_id
      WHERE p.id = ?
    `, [id])
  })

  // Create profile
  ipcMain.handle('profile:create', (_e, data: {
    name: string
    videoId?: string
    cameraDeviceId?: string
    cameraDeviceLabel?: string
    mediaType?: string
    chromaEnabled?: number
    chromaSimilarity?: number
    chromaSmoothing?: number
    vadThreshold?: number
    vadPostSilenceMs?: number
    ttsVoice?: string
    ttsSpeed?: number
    ttsVolume?: number
  }) => {
    const id = uuidv4()
    dbRun(
      `INSERT INTO dh_profiles
         (id, name, video_id, camera_device_id, camera_device_label, media_type,
          chroma_enabled, chroma_similarity, chroma_smoothing,
          vad_threshold, vad_post_silence_ms, tts_voice, tts_speed, tts_volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.name,
        data.videoId || null,
        data.cameraDeviceId || null,
        data.cameraDeviceLabel || null,
        data.mediaType || 'video',
        data.chromaEnabled ?? 0,
        data.chromaSimilarity ?? 80,
        data.chromaSmoothing ?? 1,
        data.vadThreshold ?? 0.02,
        data.vadPostSilenceMs ?? 500,
        data.ttsVoice || 'jack_cheng',
        data.ttsSpeed ?? 1.0,
        data.ttsVolume ?? 0.8
      ]
    )
    saveDatabase()
    return { ok: true, record: dbGet('SELECT * FROM dh_profiles WHERE id = ?', [id]) }
  })

  // Update profile
  ipcMain.handle('profile:update', (_e, id: string, data: {
    name?: string
    videoId?: string
    cameraDeviceId?: string
    cameraDeviceLabel?: string
    mediaType?: string
    chromaEnabled?: number
    chromaSimilarity?: number
    chromaSmoothing?: number
    vadThreshold?: number
    vadPostSilenceMs?: number
    ttsVoice?: string
    ttsSpeed?: number
    ttsVolume?: number
  }) => {
    const fieldMap: Record<string, string> = {
      name: 'name',
      videoId: 'video_id',
      cameraDeviceId: 'camera_device_id',
      cameraDeviceLabel: 'camera_device_label',
      mediaType: 'media_type',
      chromaEnabled: 'chroma_enabled',
      chromaSimilarity: 'chroma_similarity',
      chromaSmoothing: 'chroma_smoothing',
      vadThreshold: 'vad_threshold',
      vadPostSilenceMs: 'vad_post_silence_ms',
      ttsVoice: 'tts_voice',
      ttsSpeed: 'tts_speed',
      ttsVolume: 'tts_volume'
    }
    const fields: string[] = []
    const vals: unknown[] = []
    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in data) {
        fields.push(`${col} = ?`)
        vals.push((data as any)[key])
      }
    }
    if (fields.length === 0) return { ok: false, error: 'Nothing to update' }
    fields.push('updated_at = datetime(\'now\',\'localtime\')')
    vals.push(id)
    dbRun(`UPDATE dh_profiles SET ${fields.join(', ')} WHERE id = ?`, vals)
    saveDatabase()
    return { ok: true }
  })

  // Delete profile (only if no rooms use it)
  ipcMain.handle('profile:delete', (_e, id: string) => {
    const inUse = dbGet('SELECT id FROM rooms WHERE profile_id = ? LIMIT 1', [id])
    if (inUse) return { ok: false, error: 'Profile is used by a room' }
    dbRun('DELETE FROM dh_profiles WHERE id = ?', [id])
    saveDatabase()
    return { ok: true }
  })

  // Set default profile
  ipcMain.handle('profile:set-default', (_e, id: string) => {
    dbRun('UPDATE dh_profiles SET is_default = 0')
    dbRun('UPDATE dh_profiles SET is_default = 1 WHERE id = ?', [id])
    saveDatabase()
    return { ok: true }
  })

  // Get default profile
  ipcMain.handle('profile:get-default', () => {
    return dbGet(`
      SELECT p.*,
             v.name AS video_name,
             v.file_path AS video_file_path,
             v.duration_sec AS video_duration_sec,
             v.fps AS video_fps
      FROM dh_profiles p
      LEFT JOIN avatar_videos v ON v.id = p.video_id
      WHERE p.is_default = 1
      LIMIT 1
    `)
  })

  // Save camera recording as avatar video
  ipcMain.handle('camera:record-save', async (_e, profileId: string, buffer: ArrayBuffer) => {
    try {
      const dataDir = getDataDir()
      const tempDir = join(dataDir, 'face2face', 'camera_recordings')
      mkdirSync(tempDir, { recursive: true })

      const buf = Buffer.from(buffer)
      const { ffmpeg } = await detectFfmpeg()
      const { execFile } = require('child_process')
      const { promisify } = require('util')
      const execFileAsync = promisify(execFile)
      // Use timestamp in filename so DIANJT sees a new path → fresh preprocessing
      const ts = Date.now()
      const outputMp4 = join(tempDir, `${profileId}_${ts}.mp4`)

      // Clean up old camera MP4s for this profile
      try {
        const oldFiles = readdirSync(tempDir).filter(
          f => f.startsWith(profileId) && f.endsWith('.mp4') && !f.includes(`_${ts}`)
        )
        for (const f of oldFiles) {
          try { unlinkSync(join(tempDir, f)) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }

      // Detect if input is JPEG (single frame) or WebM (video recording)
      const isJpeg = buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8
      if (isJpeg) {
        // Single JPEG frame → generate 1s static MP4 (25 identical frames)
        const tempJpg = join(tempDir, `${profileId}_temp.jpg`)
        writeFileSync(tempJpg, buf)
        await execFileAsync(ffmpeg, [
          '-y', '-loop', '1', '-i', tempJpg,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-t', '1', '-r', '25', '-pix_fmt', 'yuv420p',
          '-an', outputMp4
        ], { timeout: 30000 })
        try { unlinkSync(tempJpg) } catch { /* ignore */ }
        console.log(`[Profile] Camera single-frame → static MP4: ${outputMp4}`)
      } else {
        // WebM video buffer → convert to MP4
        const tempWebm = join(tempDir, `${profileId}_temp.webm`)
        writeFileSync(tempWebm, buf)
        await execFileAsync(ffmpeg, [
          '-y', '-i', tempWebm,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-r', '25', '-pix_fmt', 'yuv420p',
          '-an', outputMp4
        ], { timeout: 30000 })
        try { unlinkSync(tempWebm) } catch { /* ignore */ }
      }

      // 3. Get video info
      const info = await extractVideoInfo(outputMp4)

      // 4. Insert or update avatar_videos
      const videoId = `cam_${profileId}`
      const existing = dbGet('SELECT id FROM avatar_videos WHERE id = ?', [videoId])
      if (existing) {
        dbRun(
          'UPDATE avatar_videos SET file_path = ?, fps = ?, duration_sec = ? WHERE id = ?',
          [outputMp4, info.fps, info.duration, videoId]
        )
      } else {
        dbRun(
          'INSERT INTO avatar_videos (id, name, file_path, fps, duration_sec) VALUES (?, ?, ?, ?, ?)',
          [videoId, `摄像头录像-${profileId.slice(0, 8)}`, outputMp4, info.fps, info.duration]
        )
      }

      // 5. Update profile's video_id
      dbRun('UPDATE dh_profiles SET video_id = ? WHERE id = ?', [videoId, profileId])
      saveDatabase()

      console.log(`[Profile] Camera recording saved: ${outputMp4} (${info.fps}fps, ${info.duration.toFixed(1)}s)`)
      return { ok: true, videoId, filePath: outputMp4 }
    } catch (err: any) {
      console.error('[Profile] Camera record save failed:', err.message)
      return { ok: false, error: err.message }
    }
  })
}
