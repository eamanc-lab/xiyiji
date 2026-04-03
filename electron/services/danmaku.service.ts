import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { inflate } from 'zlib'

export interface DanmakuMessage {
  text: string
  username: string
  uid: number
  timestamp: number
}

const WS_URL = 'wss://broadcastlv.chat.bilibili.com/sub'

// Binary protocol constants
const HEADER_SIZE = 16
const OP_HEARTBEAT = 2
const OP_HEARTBEAT_REPLY = 3
const OP_MESSAGE = 5
const OP_AUTH = 7
const OP_AUTH_REPLY = 8
const PROTO_JSON = 0
const PROTO_ZLIB = 2
const PROTO_BROTLI = 3

class DanmakuService extends EventEmitter {
  private ws: WebSocket | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private roomId: number = 0
  private connected = false
  private reconnectAttempts = 0
  private maxReconnects = 5
  private shouldReconnect = false

  async connect(roomId: number): Promise<void> {
    this.roomId = roomId
    this.shouldReconnect = true
    this.reconnectAttempts = 0
    await this.doConnect()
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Fetch real room id via API (short id to long id)
        this.fetchRealRoomId(this.roomId)
          .then((realRoomId) => {
            this.ws = new WebSocket(WS_URL)

            this.ws.on('open', () => {
              this.sendAuth(realRoomId)
              this.startHeartbeat()
              resolve()
            })

            this.ws.on('message', (data: Buffer) => {
              this.handleMessage(data)
            })

            this.ws.on('close', () => {
              this.onDisconnect()
            })

            this.ws.on('error', (err) => {
              console.error('Danmaku WS error:', err.message)
              this.emit('error', err.message)
              if (!this.connected) reject(err)
            })
          })
          .catch(reject)
      } catch (err) {
        reject(err)
      }
    })
  }

  private async fetchRealRoomId(roomId: number): Promise<number> {
    try {
      const axios = require('axios')
      const resp = await axios.get(
        `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`,
        { timeout: 10000 }
      )
      if (resp.data?.code === 0 && resp.data?.data?.room_id) {
        return resp.data.data.room_id
      }
    } catch {
      // Fallback to using roomId as-is
    }
    return roomId
  }

  private sendAuth(roomId: number): void {
    const body = JSON.stringify({
      uid: 0,
      roomid: roomId,
      protover: 2,
      platform: 'web',
      type: 2
    })
    this.sendPacket(OP_AUTH, body)
  }

  private sendPacket(operation: number, body: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const bodyBuf = Buffer.from(body, 'utf-8')
    const totalLen = HEADER_SIZE + bodyBuf.length
    const header = Buffer.alloc(HEADER_SIZE)

    header.writeUInt32BE(totalLen, 0) // packet length
    header.writeUInt16BE(HEADER_SIZE, 4) // header length
    header.writeUInt16BE(1, 6) // protocol version
    header.writeUInt32BE(operation, 8) // operation
    header.writeUInt32BE(1, 12) // sequence id

    this.ws.send(Buffer.concat([header, bodyBuf]))
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendPacket(OP_HEARTBEAT, '')
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      this.parsePackets(data)
    } catch (err: any) {
      console.error('Danmaku parse error:', err.message)
    }
  }

  private parsePackets(data: Buffer): void {
    let offset = 0
    while (offset < data.length) {
      if (offset + HEADER_SIZE > data.length) break

      const packetLen = data.readUInt32BE(offset)
      const headerLen = data.readUInt16BE(offset + 4)
      const protoVer = data.readUInt16BE(offset + 6)
      const operation = data.readUInt32BE(offset + 8)

      if (packetLen < HEADER_SIZE || offset + packetLen > data.length) break

      const body = data.subarray(offset + headerLen, offset + packetLen)

      switch (operation) {
        case OP_AUTH_REPLY:
          this.connected = true
          this.reconnectAttempts = 0
          this.emit('connected', this.roomId)
          break

        case OP_HEARTBEAT_REPLY:
          if (body.length >= 4) {
            const popularity = body.readUInt32BE(0)
            this.emit('popularity', popularity)
          }
          break

        case OP_MESSAGE:
          if (protoVer === PROTO_ZLIB) {
            this.decompressZlib(body)
          } else if (protoVer === PROTO_BROTLI) {
            this.decompressBrotli(body)
          } else {
            this.parseJsonMessage(body)
          }
          break
      }

      offset += packetLen
    }
  }

  private decompressZlib(data: Buffer): void {
    inflate(data, (err, result) => {
      if (err) {
        console.error('Zlib decompress error:', err)
        return
      }
      this.parsePackets(result)
    })
  }

  private decompressBrotli(data: Buffer): void {
    try {
      const { brotliDecompressSync } = require('zlib')
      const result = brotliDecompressSync(data)
      this.parsePackets(result)
    } catch (err: any) {
      console.error('Brotli decompress error:', err.message)
    }
  }

  private parseJsonMessage(body: Buffer): void {
    try {
      const json = JSON.parse(body.toString('utf-8'))
      this.dispatchCommand(json)
    } catch {
      // Ignore unparseable messages
    }
  }

  private dispatchCommand(json: any): void {
    const cmd = json.cmd

    if (cmd === 'DANMU_MSG' || cmd?.startsWith('DANMU_MSG')) {
      const info = json.info
      if (info && info[1]) {
        const msg: DanmakuMessage = {
          text: info[1],
          username: info[2]?.[1] || 'unknown',
          uid: info[2]?.[0] || 0,
          timestamp: Date.now()
        }
        this.emit('danmaku', msg)
      }
    }
    // Other commands can be added: SEND_GIFT, INTERACT_WORD, etc.
  }

  private onDisconnect(): void {
    this.connected = false
    this.stopHeartbeat()
    this.emit('disconnected')

    if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnects) {
      this.reconnectAttempts++
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
      console.log(`Danmaku reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
      this.reconnectTimer = setTimeout(() => {
        this.doConnect().catch((err) => {
          console.error('Danmaku reconnect failed:', err.message)
        })
      }, delay)
    }
  }

  disconnect(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeat()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    this.emit('disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  getRoomId(): number {
    return this.roomId
  }
}

export const danmakuService = new DanmakuService()
