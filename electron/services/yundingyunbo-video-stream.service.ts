import { YundingyunboService } from './yundingyunbo.service'

export const yundingyunboVideoStreamService = new YundingyunboService({
  name: 'yundingyunbo-video-stream',
  bridgeScriptBaseName: 'yundingyunbo_video_stream_bridge',
  envOverrides: {
    YDB_FORCE_V2_FILE_MODE: '0',
    YDB_FORCE_VIDEO_STREAM_FILE_MODE: '1',
    YDB_ENABLE_BLOCKING_SPECIAL_DRIVE: '1',
    YDB_FORCE_SEQUENTIAL_FILE_FRAMES: '1',
    YDB_ENABLE_AUTO_SPECIAL_READER: '0',
  },
})
