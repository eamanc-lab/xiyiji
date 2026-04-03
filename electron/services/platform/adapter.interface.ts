export interface LiveEvent {
  type: 'danmaku' | 'like' | 'follow' | 'gift' | 'enter' | 'share'
  userId: string
  userName: string
  text?: string
  giftName?: string
  count?: number
  timestamp: number
}

export interface PlatformAdapter {
  readonly platform: string
  connect(credential: any): Promise<void>
  disconnect(): void
  getStatus(): 'connected' | 'disconnected' | 'error'
  onEvent(callback: (event: LiveEvent) => void): void
  offEvent(): void
}

