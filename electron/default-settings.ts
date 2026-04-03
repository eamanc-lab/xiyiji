import updateConfig from '../update-config.json'
import { getDefaultDataDir, getDefaultLipSyncBackend, getDefaultOutputDir } from './utils/app-paths'

export const BUNDLED_API_DEFAULTS: Record<string, string> = {
  dashscope_api_key: 'sk-385d5926350541e7ba163102f07d26a2',
  ucloud_tts_api_key: 'ge47AAEZ9je3V6Di3aE5812e-536F-4aE7-a4a7-8dFfBb07',
  ucloud_tts_model: 'IndexTeam/IndexTTS-2',
  ucloud_tts_base_url: 'https://api.modelverse.cn/v1',
  dashscope_base_url: 'https://dashscope.aliyuncs.com/api/v1',
  eulerstream_api_key: 'euler_MjZhMGI1MmNmNGVhNmEyYTJlZGFiYWZhODlhNWMzOTYyYzk3YmQzMGJiZmU5ZGRmYmYwY2Uw',
  license_server_url: 'https://szr.cloudcut.fun',
  update_manifest_url: String(updateConfig.manifestUrl || '').trim(),
  full_package_url: String(updateConfig.fullPackageUrl || '').trim(),
  full_package_code: String(updateConfig.fullPackageCode || '').trim()
}

export function getBundledSettingsDefaults(): Record<string, string> {
  return {
    language: 'zh-CN',
    data_dir: getDefaultDataDir(),
    output_dir: getDefaultOutputDir(),
    temp_cleanup_days: '7',
    show_fps: 'false',
    auto_start: 'false',
    batch_size: '4',
    model_version: '256v1',
    blend_mode: 'lmk',
    blur_threshold: '0.9',
    vad_threshold: '0.6',
    vad_min_silence: '500',
    vad_speech_padding: '30',
    vad_min_speech: '0.3',
    vad_energy_threshold: '0.04',
    f2f_port: '8383',
    ...BUNDLED_API_DEFAULTS,
    lipsync_backend: getDefaultLipSyncBackend(),
    dianjt_base: '',
    yundingyunbo_base: ''
  }
}
