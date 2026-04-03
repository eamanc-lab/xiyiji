import type { PlatformAdapter, LiveEvent } from './adapter.interface'
import { DouyinAdapter } from './douyin.adapter'
import { TikTokAdapter } from './tiktok.adapter'
import { WeixinChannelAdapter } from './weixin-channel.adapter'
import { TaobaoAdapter } from './taobao.adapter'
import { XiaohongshuAdapter } from './xiaohongshu.adapter'

type PlatformName = 'douyin' | 'tiktok' | 'weixin_channel' | 'taobao' | 'xiaohongshu'

/**
 * Singleton manager for platform adapters.
 * Only one platform may be connected at a time.
 */
class PlatformManager {
  private adapters: Map<PlatformName, PlatformAdapter> = new Map()
  private activeAdapter: PlatformAdapter | null = null
  private activePlatform: PlatformName | null = null

  constructor() {
    this.adapters.set('douyin', new DouyinAdapter())
    this.adapters.set('tiktok', new TikTokAdapter())
    this.adapters.set('weixin_channel', new WeixinChannelAdapter())
    this.adapters.set('taobao', new TaobaoAdapter())
    this.adapters.set('xiaohongshu', new XiaohongshuAdapter())
  }

  getAdapter(platform: PlatformName): PlatformAdapter | undefined {
    return this.adapters.get(platform)
  }

  getActive(): PlatformAdapter | null {
    return this.activeAdapter
  }

  getActivePlatform(): PlatformName | null {
    return this.activePlatform
  }

  async connect(
    platform: PlatformName,
    credential: any,
    onEvent: (event: LiveEvent) => void
  ): Promise<void> {
    if (this.activeAdapter) {
      this.disconnect()
    }

    const adapter = this.adapters.get(platform)
    if (!adapter) {
      throw new Error(`Unknown platform: ${platform}`)
    }

    adapter.onEvent(onEvent)
    await adapter.connect(credential)
    this.activeAdapter = adapter
    this.activePlatform = platform
    console.log(`[PlatformManager] Connected to: ${platform}`)
  }

  disconnect(): void {
    if (!this.activeAdapter) return
    this.activeAdapter.offEvent()
    this.activeAdapter.disconnect()
    this.activeAdapter = null
    this.activePlatform = null
    console.log('[PlatformManager] Disconnected')
  }

  getStatus(): { platform: PlatformName | null; status: string } {
    return {
      platform: this.activePlatform,
      status: this.activeAdapter?.getStatus() ?? 'disconnected'
    }
  }

  listPlatforms(): Array<{ name: PlatformName; label: string }> {
    return [
      { name: 'douyin', label: '抖音' },
      { name: 'tiktok', label: 'TikTok' },
      { name: 'weixin_channel', label: '视频号' },
      { name: 'taobao', label: '淘宝直播' },
      { name: 'xiaohongshu', label: '小红书' }
    ]
  }
}

export const platformManager = new PlatformManager()
