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
    // Allow video-stream to loop the full driving video. Default is '1'
    // (no_loop), which clamps the sequential frame generator at last_frame
    // and prevents the video from cycling back to start. We want full 27min
    // playback that loops back to the beginning, so disable no_loop here.
    YDB_VIDEO_STREAM_NO_LOOP: '0',
  },
})
