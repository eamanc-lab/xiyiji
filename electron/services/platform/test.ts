import { EventEmitter } from 'events'
import WebSocket from 'ws'
import type { PlatformAdapter, LiveEvent } from './adapter.interface'

const DOUYIN_WS_PORT = 2345