import { registerWindowIpc } from './window.ipc'
import { registerFileIpc } from './file.ipc'
import { registerSettingsIpc } from './settings.ipc'
import { registerSystemIpc } from './system.ipc'
import { registerLiveIpc } from './live.ipc'
import { registerChatIpc } from './chat.ipc'
import { registerPlayerIpc } from './player.ipc'
import { registerPipelineIpc } from './pipeline.ipc'
import { registerDanmakuIpc } from './danmaku.ipc'
import { registerRoomIpc } from './room.ipc'
import { registerAssetIpc } from './asset.ipc'
import { registerProfileIpc } from './profile.ipc'
import { registerScriptIpc } from './script.ipc'
import { registerLiveRoomIpc } from './live-room.ipc'
import { registerLicenseIpc } from './license.ipc'
import { registerPlatformIpc } from './platform.ipc'
import { registerUpdaterIpc } from './updater.ipc'

export function registerAllIpc(): void {
  registerWindowIpc()
  registerFileIpc()
  registerSettingsIpc()
  registerSystemIpc()
  registerLiveIpc()
  registerChatIpc()
  registerPlayerIpc()
  registerPipelineIpc()
  registerDanmakuIpc()
  registerRoomIpc()
  registerAssetIpc()
  registerProfileIpc()
  registerScriptIpc()
  registerLiveRoomIpc()
  registerLicenseIpc()
  registerPlatformIpc()
  registerUpdaterIpc()
}
