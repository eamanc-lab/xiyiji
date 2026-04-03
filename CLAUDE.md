# 打包与在线升级强制入口

只要涉及以下任一动作：

- 打包
- 发客户
- 在线升级
- OSS 上传
- manifest
- 检查更新

必须先读：

`D:\yunyin\XYJ2\xiyiji\打包与在线升级SOP.md`

强制规则：

1. 当前唯一正式工作目录是 `D:\yunyin\XYJ2\xiyiji`
2. `D:\XYJ2\xiyiji` 是旧目录，禁止作为正式打包和发布目录
3. 发客户的完整包只能取自 `D:\yunyin\XYJ2\xiyiji\release\xiyiji-release`
4. 在线升级产物只能取自 `D:\yunyin\XYJ2\xiyiji\release\online-update`
5. 测试在线升级前，必须先确认远端版本号高于本地版本号
6. 如果 `CLAUDE.md`、`本次进度交接.txt`、旧文档与 `打包与在线升级SOP.md` 冲突，以 `打包与在线升级SOP.md` 为准
7. 仓库地址: `git@github.com:eamanc-lab/xiyiji.git`
8. 提交策略：在工程项目中进行代码修改时，遵循"小步提交"策略：
   - 每完成一个有意义的小步骤就提交一次（如：完成一个函数、修好一个 bug、添加一个文件）
   - 提交信息简洁描述本步做了什么，使用中文 Conventional Commits 格式
   - 目的：为每步操作创建可回退的存档点，出问题时能精确定位和回滚
   - 最终交付前，可由用户决定是否用 git rebase -i 合并为一个整洁提交
   - 不要等所有改动完成后才一次性提交

# 西忆集 (Xiyiji) — AI 数字人直播平台

## 项目概述

西忆集是一个基于 Electron + Vue 3 的 AI 数字人直播桌面应用。核心功能是通过本地 GPU 驱动 yundingyunbo 本地推理引擎进行实时口型同步视频生成，配合 AI 自动直播话术生成、多平台弹幕监控、播放队列管理，实现全自动 AI 数字人直播。TTS 和 LLM 使用云端 API，F2F（Face-to-Face）推理完全本地化（无需 Docker）。

**产品名**: 西忆集
**App ID**: com.xiyiji.app
**平台**: Windows 10/11
**GPU 要求**: NVIDIA GTX 1080 Ti (8GB) 最低, RTX 4070+ 推荐

---

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Electron | 33.2.1 |
| 前端 | Vue 3 (Composition API) | 3.5.13 |
| 构建 | electron-vite | 5.0.0 |
| UI 库 | TDesign Vue Next | 1.10.5 |
| 状态管理 | Pinia | 2.3.0 |
| 路由 | Vue Router | 4.5.0 |
| 数据库 | sql.js (WASM SQLite) | 1.11.0 |
| 视频处理 | fluent-ffmpeg + FFmpeg 二进制 | 2.1.3 |
| 国际化 | vue-i18n | 9.14.0 |
| 打包 | electron-builder (NSIS) | 25.1.8 |
| 测试 | vitest | 2.1.9 |
| 代码保护 | javascript-obfuscator + protect-asar | — |

---

## 开发命令

```bash
npm install          # 安装依赖
npm run dev          # 开发模式启动
npm run build        # 编译 TypeScript
npm run build:win    # 打包 Windows 安装包
npm run test:unit    # 运行单元测试
```

---

## 目录结构

```
xiyiji/
├── electron/                          # Electron 主进程
│   ├── config.ts                      # 配置管理（SQLite 持久化 + 默认值）
│   ├── db/
│   │   └── index.ts                   # sql.js 数据库初始化、建表、迁移、CRUD
│   ├── ipc/                           # IPC 处理器（主进程 ↔ 渲染进程）
│   │   ├── index.ts                   # 注册所有 IPC handler（18 个模块）
│   │   ├── asset.ipc.ts               # 形象视频素材管理（导入、重命名、删除、缩略图）
│   │   ├── chat.ipc.ts                # 数字人对话（LLM + TTS + F2F 完整链路）
│   │   ├── danmaku.ipc.ts             # B站弹幕系统（WebSocket 协议）
│   │   ├── file.ipc.ts                # 文件对话框、视频信息提取
│   │   ├── license.ipc.ts             # License 验证与激活
│   │   ├── live.ipc.ts                # 直播控制（遗留接口）
│   │   ├── live-room.ipc.ts           # ★ 直播间生命周期（启动/停止/队列/弹幕/AI循环）
│   │   ├── pipeline.ipc.ts            # 合成管线（提交任务、查询状态、帧合并优化）
│   │   ├── platform.ipc.ts            # 多平台弹幕适配器管理
│   │   ├── player.ipc.ts              # 视频播放器控制（位置查询、seek、摄像头）
│   │   ├── profile.ipc.ts             # 数字人方案管理（CRUD + 默认方案）
│   │   ├── room.ipc.ts                # 直播间 CRUD
│   │   ├── script.ipc.ts              # 脚本管理（通用/商品链接/快捷/禁词/黑名单）
│   │   ├── settings.ipc.ts            # 设置读写
│   │   ├── system.ipc.ts              # 系统信息（GPU、磁盘等）
│   │   ├── updater.ipc.ts             # 在线升级（检查更新、下载、应用）
│   │   └── window.ipc.ts              # 窗口管理（最小化、最大化、关闭）
│   ├── services/                      # 业务逻辑服务层
│   │   ├── yundingyunbo.service.ts     # ★ F2F 口型同步（yundingyunbo 本地进程，NDJSON 协议）
│   │   ├── yundingyunbo-video-stream.service.ts # 视频流式推理服务
│   │   ├── pipeline.service.ts        # ★ 合成管线（任务队列、帧同步、流式输出）
│   │   ├── live-pipeline.service.ts   # ★ 直播管线桥接（队列↔管线，chunk 跟踪）
│   │   ├── ai-loop.service.ts         # ★ AI 自动直播循环（话术生成、弹幕响应、自动轮播）
│   │   ├── queue.manager.ts           # ★ 播放队列管理（优先级插入、过期清理）
│   │   ├── room-session.service.ts    # 房间会话状态（脚本加载、上下文构建）
│   │   ├── room-temperature.ts        # 房间热度（滑动窗口 + 滞后判定）
│   │   ├── qwen.service.ts            # Qwen 批量话术生成（结构化 prompt）
│   │   ├── tts.service.ts             # TTS 语音合成（UCloud IndexTTS-2）
│   │   ├── asr.service.ts             # ASR 语音识别（阿里云 DashScope FunASR）
│   │   ├── llm.service.ts             # LLM 对话（阿里云 Qwen，DashScope API）
│   │   ├── lipsync-backend.ts         # LipSync 后端抽象接口
│   │   ├── lipsync-init.ts            # 后端注册与初始化
│   │   ├── danmaku.service.ts         # B站弹幕 WebSocket 协议
│   │   ├── danmaku-reply.service.ts   # 弹幕自动回复（关键词匹配、冷却）
│   │   ├── event-batcher.ts           # 弹幕事件批处理（4s 窗口、禁词过滤、黑名单）
│   │   ├── license.service.ts         # License 服务
│   │   ├── virtual-camera.service.ts  # OBS 虚拟摄像头输出
│   │   └── platform/                  # 多平台弹幕适配器
│   │       ├── adapter.interface.ts   # PlatformAdapter 接口定义
│   │       ├── platform.manager.ts    # 适配器管理器（单例）
│   │       ├── douyin.adapter.ts      # 抖音（WebSocket 代理 localhost:2345）
│   │       ├── tiktok.adapter.ts      # TikTok（EulerStream WebSocket API）
│   │       ├── weixin-channel.adapter.ts # 视频号（BrowserWindow + CDP 拦截）
│   │       ├── xiaohongshu.adapter.ts # 小红书（BrowserWindow + CDP + DOM）
│   │       └── taobao.adapter.ts      # 淘宝（BrowserWindow + CDP + DOM）
│   └── utils/
│       ├── ffmpeg.ts                  # FFmpeg 封装（提取音频、视频信息、截图、拼接等）
│       └── logger.ts                  # 日志管理
├── src/
│   ├── main/
│   │   └── index.ts                   # Electron 主进程入口（窗口创建、IPC注册、DB初始化）
│   ├── preload/
│   │   ├── index.ts                   # 主窗口 preload（contextBridge 暴露所有 IPC 方法）
│   │   └── player.ts                  # 播放器窗口 preload
│   └── renderer/src/                  # Vue 3 前端
│       ├── App.vue                    # 根组件
│       ├── main.ts                    # Vue 入口
│       ├── player.ts                  # 独立播放器模块（chunk 流式播放）
│       ├── router/index.ts            # 路由（Login → Lobby → Room 三页应用）
│       ├── views/                     # 页面
│       │   ├── LoginView.vue          # 登录页（账号密码 + License 验证）
│       │   ├── LobbyView.vue          # 大厅页（房间网格、CRUD、平台选择）
│       │   ├── RoomView.vue           # 房间页（6 Tab 工作区容器）
│       │   ├── room/                  # 房间子页面
│       │   │   ├── Tab1Assets.vue     # 素材库（形象视频管理、人脸检测）
│       │   │   ├── Tab2Profiles.vue   # 形象方案（语音、VAD、绿幕、摄像头）
│       │   │   ├── Tab3Scripts.vue    # 脚本管理（通用/商品/快捷脚本）
│       │   │   ├── Tab4Live.vue       # 直播台（控制面板、播放队列）
│       │   │   ├── Tab5Danmaku.vue    # 弹幕监控（多平台、自动回复、统计）
│       │   │   └── Tab6Settings.vue   # 系统设置
│       │   └── (遗留页面)
│       │       ├── AvatarSelect.vue   # 旧版形象选择
│       │       ├── DigitalChat.vue    # 旧版数字人对话
│       │       ├── DigitalLive.vue    # 旧版数字人直播
│       │       └── ParamSettings.vue  # 旧版参数设置
│       ├── components/
│       │   ├── avatar-select/         # 形象选择组件
│       │   ├── chat/                  # 聊天组件
│       │   ├── common/                # 通用组件（VideoPlayer）
│       │   ├── layout/                # 布局（AppHeader, AppSidebar）
│       │   ├── live/                  # 直播组件
│       │   └── profile/               # 方案组件
│       ├── stores/                    # Pinia 状态管理
│       │   ├── auth.store.ts          # 登录认证状态
│       │   ├── room.store.ts          # 房间状态
│       │   ├── danmaku.store.ts       # 弹幕状态（多平台连接管理）
│       │   ├── live.store.ts          # 直播状态
│       │   ├── avatar-select.store.ts # 形象选择状态
│       │   ├── chat.store.ts          # 对话状态
│       │   └── settings.store.ts      # 设置状态
│       └── i18n/                      # 国际化（zh-CN, en-US）
├── resources/
│   ├── ffmpeg/                        # FFmpeg 二进制（ffmpeg.exe, ffprobe.exe, ffplay.exe）
│   └── scripts/
│       ├── yundingyunbo_bridge.py     # ★ yundingyunbo 推理桥接脚本（主用）
│       ├── yundingyunbo_video_stream_bridge.py # 视频流式推理桥接
│       └── yundingyunbo_camera_proxy.py # 虚拟摄像头代理
├── scripts/                           # PowerShell 工具脚本
├── docs/                              # 文档
└── package.json
```

---

## 核心架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Electron 主进程 (Node.js)                    │
│                                                                  │
│  AiLoopService ──→ QwenService ──→ LlmService ──→ DashScope API │
│  (自动直播循环)     (批量话术)      (LLM 对话)     (阿里云 Qwen)  │
│       │                                                          │
│       ↓                                                          │
│  QueueManager ──→ LivePipelineService ──→ PipelineService        │
│  (播放队列)        (队列↔管线桥接)         (任务队列/帧同步)       │
│       │                                       │                  │
│       ↓                                       ↓                  │
│  TtsService ──→ UCloud API              LipSyncBackend (抽象)    │
│  (语音合成)     (IndexTTS-2)                  │                  │
│                                               ↓                  │
│                                     YundingyunboService          │
│                                     (本地 yundingyunbo 进程)     │
│                                               │                  │
│  EventBatcher ──→ AiLoopService         ↕ NDJSON stdin/stdout    │
│  (弹幕批处理)     (弹幕触发话术)                                   │
│                                                                  │
│  PlatformManager ──→ 抖音/TikTok/视频号/小红书/淘宝 Adapter      │
│  (多平台弹幕, 6平台)                                              │
├─────────────────────────────────────────────────────────────────┤
│                  yundingyunbo 本地 Python 进程                     │
│                                                                  │
│  yundingyunbo_bridge.py (持久进程，通过 child_process 启动)       │
│  ├── DINetV1    (口型合成, ~374MB 权重)                           │
│  ├── WeNet PPG  (音频特征提取, 50Hz)                              │
│  ├── SCRFD      (人脸检测, ONNX)                                  │
│  └── PFPLD      (98点关键点, ONNX)                                │
│                                                                  │
│  GPU 内存: 模型常驻，跨请求复用                                     │
├─────────────────────────────────────────────────────────────────┤
│  数据目录: D:\heygem_data\                                        │
│  ├── face2face\  (视频、音频、chunks、推理结果)                     │
│  └── voice\data  (TTS 数据)                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## F2F 口型同步引擎（核心）

### yundingyunbo 本地推理模式

F2F 引擎使用 **yundingyunbo 本地进程模式**。`yundingyunbo.service.ts` 通过 `child_process.spawn()` 直接启动本地 Python 进程 `yundingyunbo_bridge.py`，无需 Docker。

**yundingyunbo 安装目录搜索顺序**（`resolveYundingyunboBase()`）：
1. 环境变量 / 设置页 `yundingyunbo_base`
2. exe 同级目录
3. exe 上级目录

**验证标志**: 目录下存在 `heyi/python.exe` 即为有效安装。

**Python 解释器**: `yundingyunbo_base/heyi/python.exe`（自带 Python 环境，无需系统 Python）

**FFmpeg**: `yundingyunbo_base/heyi/ffmpeg/bin/ffmpeg.exe`（自带 FFmpeg）

### 通信协议（NDJSON）

YundingyunboService 通过 stdin 发送 JSON 命令，通过 stdout 读取 NDJSON 响应。所有路径均为本地 Windows 路径（无需容器路径转换）。

**Node → Python (stdin 命令):**
```json
{"cmd":"init_avatar","id":"<uuid>","video":"D:\\heygem_data\\face2face\\video.mp4","crop_scale":1.48}
{"cmd":"process_audio","id":"<uuid>","audio":"D:\\heygem_data\\face2face\\audio.wav","batch_size":4,"chunk_frames":16}
{"cmd":"set_start_frame","id":"<uuid>","start_frame":130}
{"cmd":"ping","id":"<uuid>"}
{"cmd":"shutdown"}
```

**Python → Node (stdout 响应):**
```json
{"type":"ready"}
{"id":"<uuid>","type":"result","fps":25,"width":1920,"height":1080,"n_frames":312}
{"id":"<uuid>","type":"ack","num_frames":510,"total_chunks":32}
{"id":"<uuid>","type":"chunk","chunk_idx":0,"path":"D:\\heygem_data\\face2face\\chunks\\<uuid>\\chunk_0000.mp4","n_frames":16}
{"id":"<uuid>","type":"frame_batch","codec":"jpeg","fps":25,"frames":["base64..."],"frame_indices":[0,1,2]}
{"id":"<uuid>","type":"done","total_chunks":32,"total_frames":510,"end_frame":295}
{"id":"<uuid>","type":"error","error":"<message>"}
```

### 环境变量

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `DIANJT_FRAME_INDEX_MODE` | `forward` | 帧循环模式: `forward` / `pingpong` |
| `DIANJT_STRICT_TEST_FLOW` | `1` | 严格测试流程（影响 frame_batch 行为） |

### 处理流程

1. **Avatar 初始化** (`init_avatar`):
   - 加载视频、在采样帧上检测人脸
   - 计算稳定裁剪区域（中值滤波）
   - 创建人脸轮廓 Alpha 蒙版（凸包 + 高斯模糊）
   - 预计算所有帧的 256x256 人脸裁剪
   - 结果缓存，同一视频不重复初始化

2. **音频处理** (`process_audio`):
   - Phase 1: WeNet PPG 音频特征提取
   - Phase 2: 发送 `ack`，等待 `set_start_frame`（帧同步）
   - Phase 3: 最后 8 帧音频特征二次衰减（嘴巴自然闭合）
   - Phase 4: 帧循环（forward 或 pingpong 模式）
   - Phase 5: 批量 GPU 推理（默认 batch_size=4）
   - Phase 6: 分块输出（chunk 模式: 首块 8 帧降低首帧延迟，后续 16 帧）或 frame_batch 模式（JPEG 序列）

3. **双阶段 Alpha 混合**:
   - Stage 1 (256x256 空间): 用 fuse_mask 混合模型输出与原始裁剪（只混合嘴/下巴区域）
   - Stage 2 (裁剪→原始帧): 用 face_alpha × fuse_alpha 将结果混合回全帧

### 流式输出模式

| 模式 | transport | 说明 |
|------|-----------|------|
| chunk | `chunk` | 每 16 帧输出一个 MP4 文件，播放器逐个播放 |
| frame_batch | `frame_batch` | 输出 JPEG 帧序列 + 元数据，适合 Canvas 直接渲染 |

---

## AI 自动直播系统

### 整体数据流

```
弹幕/礼物 → EventBatcher(4s窗口) → AiLoopService
                                        │
                              ┌─────────┼──────────┐
                              ↓         ↓          ↓
                         弹幕响应   自动轮播    队列补充
                              │         │          │
                              ↓         ↓          ↓
                         QwenService(批量话术生成, LLM)
                              │
                              ↓
                         QueueManager(播放队列)
                              │
                              ↓
                         TtsService(语音合成)
                              │
                              ↓
                    LivePipelineService(队列↔管线桥接)
                              │
                              ↓
                    PipelineService → YundingyunboService(GPU 推理)
                              │
                              ↓
                         播放器(chunk/frame 流式播放)
```

### AiLoopService（AI 循环核心）

- **定时检测**：每 1s（可配 `AI_LOOP_TICK_MS`）检查队列是否需要补充
- **补充阈值**：ready 项 < 3 且 总项 < 6 时触发（可配）
- **批量生成**：调用 QwenService 一次生成 10-15 条话术，减少 API 调用
- **弹幕响应**：收到弹幕批次后，将弹幕上下文注入下一次生成的 prompt
- **礼物累积**：收集礼物事件，汇总后在话术中感谢
- **优先回复**：关键词匹配的弹幕立即插入队列头部
- **自动轮播**：按商品链接顺序自动切换，每个商品生成指定批次的话术
- **弹幕打断**：弹幕中提到某商品关键词时，中断轮播切换到该商品

### QueueManager（播放队列）

- **PlaylistItem 状态流转**: `pending` → `ready` → `playing` → `buffered` → `done`
- `pending`: TTS 正在合成
- `ready`: 音频就绪，等待 F2F 处理
- `playing`: F2F 正在推理
- `buffered`: 推理完成，播放器正在播放
- `done`: 播放完毕
- **过期清理**: 120s 未消费的项自动丢弃
- **优先级插入**: `insertAfterCurrent()` 在当前播放项后插入

### RoomTemperature（房间热度）

- 60s 滑动窗口统计弹幕/礼物数量
- 4 级: `cold` → `warm` → `hot` → `fire`
- 滞后判定（连续 2 次同级才切换），避免抖动
- 热度影响 AI 话术风格（冷场多互动，热场顺势推进）

### 多语言输出

QwenService 支持 `zh-CN`、`en`、`es` 三种输出语言。参考资料（脚本）始终为中文，但生成的话术按目标语言输出。

---

## 多平台弹幕系统

### PlatformAdapter 接口

```typescript
interface LiveEvent {
  type: 'danmaku' | 'like' | 'follow' | 'gift' | 'enter' | 'share'
  userId: string
  userName: string
  text?: string
  giftName?: string
  count?: number
  timestamp: number
}

interface PlatformAdapter {
  readonly platform: string
  connect(credential: any): Promise<void>
  disconnect(): void
  getStatus(): 'connected' | 'disconnected' | 'error'
  onEvent(callback: (event: LiveEvent) => void): void
  offEvent(): void
}
```

### 已实现平台

| 平台 | 适配器 | 连接方式 | 凭证 |
|------|--------|---------|------|
| B站 | `danmaku.service.ts` | WebSocket `wss://broadcastlv.chat.bilibili.com/sub` | 房间号 |
| 抖音 | `douyin.adapter.ts` | WebSocket 代理 `localhost:2345` | — |
| TikTok | `tiktok.adapter.ts` | EulerStream `wss://ws.eulerstream.com` | 用户名 + API Key |
| 视频号 | `weixin-channel.adapter.ts` | BrowserWindow + CDP 网络拦截 | 微信扫码 |
| 小红书 | `xiaohongshu.adapter.ts` | BrowserWindow + CDP + DOM | 登录态 |
| 淘宝 | `taobao.adapter.ts` | BrowserWindow + CDP + DOM | 登录态 |

### 视频号适配器技术细节

- 创建 `BrowserWindow` 加载 `channels.weixin.qq.com/platform/live/liveBuild`
- 使用 `webContents.debugger` 附加 CDP，监听 `Network.webSocketFrameReceived` 捕获 WebSocket 帧
- 同时注入 JS WebSocket Hook 作为备用捕获通道（CDP 优先，有去重保护）
- `partition: 'persist:weixin_channel'` 持久化 session，重启保持登录
- 窗口关闭时通过 IPC `platform:disconnected` 通知渲染进程重置状态

### EventBatcher（弹幕事件处理管线）

```
平台事件 → EventBatcher → 禁词过滤(模糊正则) → 黑名单过滤 → 热度统计 → 4s批次回调 → AiLoopService
```

---

## 云端服务

### TTS — UCloud IndexTTS-2

- **端点**: `https://api.modelverse.cn/v1/audio/speech`
- **API Key 配置键**: `ucloud_tts_api_key`
- **模型**: `IndexTeam/IndexTTS-2`
- **预设音色**: `sales_voice`(销售), `jack_cheng`(男声成熟), `crystla_liu`(女声), `stephen_chow`(星爷风), `xiaoyueyue`(小岳岳), `entertain`(综艺), `novel`(有声书), `movie`(影视解说), `mkas`
- **长文本处理**: 超过 600 字按标点分段，逐段合成后 FFmpeg 拼接
- **声音克隆**: `POST /audio/voice/upload` 上传 5-30s 音频样本

### ASR — 阿里云 DashScope FunASR

- **端点**: `https://dashscope.aliyuncs.com/api/v1`
- **API Key 配置键**: `dashscope_api_key`
- **流程**: 获取 OSS 凭证 → 上传音频到 OSS → 提交异步转写任务 → 轮询（2s 间隔）→ 解析结果
- **能力**: 中文识别、说话人分离（最多 6 人）、带时间戳的逐句输出
- **重试**: 3 次，指数退避（2s, 4s, 8s）

### LLM — 阿里云 Qwen

- **端点**: `https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation`
- **API Key**: 与 ASR 共用 `dashscope_api_key`
- **模型降级**: `qwen-turbo-latest` → `qwen-plus` → `qwen-turbo`
- **两种用途**:
  1. **对话模式** (`llm.service.ts`): SSE 流式响应，token 实时推送到渲染进程
  2. **批量话术** (`qwen.service.ts`): 非流式调用，一次生成 10-15 条直播话术

---

## 页面结构（三页应用）

### 1. LoginView (`/login`)
- 账号密码登录（base64 token 本地存储）
- License 验证（过期自动登出）
- 记住登录选项

### 2. LobbyView (`/lobby`)
- 房间网格卡片视图
- 房间 CRUD（创建、复制、删除）
- 平台选择（抖音、淘宝、小红书、TikTok）
- License 状态提示（warn / critical）

### 3. RoomView (`/room/:id`)
6 个 Tab 工作区：

| Tab | 组件 | 功能 |
|-----|------|------|
| Tab1 素材库 | `Tab1Assets.vue` | 形象视频导入/管理、人脸检测验证 |
| Tab2 方案 | `Tab2Profiles.vue` | 数字人方案（语音、VAD、TTS、绿幕、摄像头设备） |
| Tab3 脚本 | `Tab3Scripts.vue` | 脚本管理（通用脚本/商品链接脚本/快捷脚本） |
| Tab4 直播台 | `Tab4Live.vue` | 直播控制面板、播放队列、启停 |
| Tab5 弹幕 | `Tab5Danmaku.vue` | 多平台弹幕连接、自动回复、统计 |
| Tab6 设置 | `Tab6Settings.vue` | API 密钥、系统参数 |

---

## 数据库

使用 sql.js (WASM SQLite)，数据库文件位于：
```
%APPDATA%\xiyiji\data\xiyiji.db
```

### 表结构

| 表 | 作用域 | 说明 |
|----|--------|------|
| `accounts` | 全局 | 账号、Token（加密）、License 信息 |
| `avatar_videos` | 全局 | 形象视频（fps、时长、人脸检测、缩略图） |
| `dh_profiles` | 全局 | 数字人方案（VAD、TTS 语音、绿幕、摄像头） |
| `api_keys` | 全局 | API 密钥（加密存储） |
| `platform_credentials` | 全局 | 平台登录凭证（加密） |
| `rooms` | — | 直播间（名称、平台、状态、关联方案） |
| `room_links` | 房间 | 商品链接（slot 编号、名称） |
| `scripts` | 房间 | 脚本（通用/商品链接/快捷，支持热键、启停） |
| `room_settings` | 房间 | AI prompt、模式、输出语言、自动轮播 |
| `forbidden_words` | 房间 | 禁词列表 |
| `blacklist` | 房间 | 黑名单用户 |
| `settings` | 全局 | 键值配置（API Key、路径、参数） |
| `avatars` | 遗留 | 旧版数字人形象 |
| `voices` | 遗留 | 旧版声音模型 |
| `synth_tasks` | 遗留 | 旧版合成任务 |
| `greenscreen_presets` | 遗留 | 旧版绿幕预设 |

### room_settings 字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `ai_system_prompt` | `''` | AI 角色设定 prompt |
| `ai_mode` | `'full_ai'` | AI 模式 |
| `output_language` | `'zh-CN'` | 输出语言（zh-CN / en / es） |
| `auto_rotation_enabled` | `0` | 自动商品轮播 |
| `auto_rotation_batches` | `1` | 每个商品生成几批话术后切换 |

### 默认配置键

| Key | 默认值 | 说明 |
|-----|--------|------|
| `dashscope_api_key` | `''` | DashScope API Key（ASR + LLM，需用户配置） |
| `ucloud_tts_api_key` | `''` | UCloud TTS API Key（需用户配置） |
| `ucloud_tts_model` | `IndexTeam/IndexTTS-2` | TTS 模型 |
| `ucloud_tts_base_url` | `https://api.modelverse.cn/v1` | TTS API 地址 |
| `dashscope_base_url` | `https://dashscope.aliyuncs.com/api/v1` | DashScope API 地址 |
| `data_dir` | `D:\heygem_data` | 数据目录 |
| `output_dir` | `D:\xiyiji_output` | 导出视频目录 |
| `lipsync_backend` | `heygem` | 口型同步后端 |
| `batch_size` | `4` | F2F 每批处理帧数 |
| `vad_threshold` | `0.6` | VAD 语音检测阈值 |
| `vad_energy_threshold` | `0.04` | VAD 能量阈值 |
| `f2f_port` | `8383` | F2F 端口（遗留配置，当前未使用） |

---

## IPC 通信

所有 IPC handler 在 `electron/ipc/index.ts` 统一注册（18 个模块）。渲染进程通过 `contextBridge` 调用。

### 关键 IPC 频道

| 频道 | 方向 | 说明 |
|------|------|------|
| `live:room-start` | R→M | 启动直播间（加载方案、初始化 AI 循环） |
| `live:room-stop` | R→M | 停止直播间 |
| `live:room-pause/resume` | R→M | 暂停/恢复直播 |
| `live:push-text` | R→M | 手动推送文本到队列 |
| `live:switch-link` | R→M | 切换当前商品链接 |
| `pipeline:submit` | R→M | 提交合成任务（音频路径） |
| `pipeline:submit-tts` | R→M | 提交 TTS 合成（文本→语音→视频） |
| `pipeline:set-avatar` | R→M | 设置当前形象视频 |
| `chat:send-stream` | R→M | 发送聊天消息（流式响应） |
| `chat:token` | M→R | LLM token 流式推送 |
| `platform:connect/disconnect` | R→M | 平台弹幕连接/断开 |
| `platform:event` | M→R | 平台弹幕事件推送 |
| `platform:disconnected` | M→R | 平台连接断开通知 |
| `live:queue-update` | M→R | 播放队列状态变更推送 |
| `live:temperature-update` | M→R | 房间热度变更推送 |
| `settings:get/set` | R→M | 配置读写 |
| `room:list/get/create/update/delete` | R→M | 房间 CRUD |
| `asset:import/rename/delete` | R→M | 素材管理 |
| `profile:list/get/create/update/delete` | R→M | 方案管理 |
| `script:*` | R→M | 脚本管理（通用/链接/快捷/禁词/黑名单） |
| `license:get-info/activate` | R→M | License 管理 |

---

## PipelineService 处理模式

| 模式 | 条件 | 流程 |
|------|------|------|
| Streaming | 后端支持 `processAudioStream` | 边生成边播放，低首帧延迟 |
| Parallel | 多实例可用 & 音频 > 6s | 音频分块→多实例并行→FFmpeg 拼接 |
| Single-shot | 回退模式 | 传统 submit→poll→完成 |

### 自适应帧同步

PipelineService 实现两阶段帧同步确保合成视频与播放器 idle 视频无缝衔接：

1. `onAck` 回调时查询播放器当前位置
2. 用 `estimatedInferenceDelay`（初始 1.8s）预测播放位置
3. 计算 `start_frame` 发送给 Python
4. 第一个 chunk 完成后测量实际推理耗时，用 EMA（70%/30%）更新估计值
5. 后续任务同步精度持续提升

### LivePipelineService（直播管线桥接）

- 确保同一时间仅一个队列项被提交到 PipelineService
- 跟踪 chunk 播放进度（`player:chunk-played` 事件驱动，非定时器）
- 状态流转: `playing`(F2F 处理中) → `buffered`(播放器播放中) → `done`(播放完毕)
- 背压控制: 当播放器缓冲 chunk 过多时暂停提交（`LIVE_MAX_BUFFERED_CHUNKS` 默认 4）

---

## 关键数据流

### AI 自动直播（主流程）

```
房间启动 (live:room-start)
  → 加载方案（形象视频 + TTS 语音 + VAD 参数 + 绿幕设置）
  → 打开播放器窗口（视频/摄像头）
  → YundingyunboService.initAvatar() → 加载形象
  → AiLoopService.start() → 启动 AI 循环
  → QwenService.generateBatch() → 批量生成话术（10-15 条）
  → QueueManager.pushBatch() → 话术入队
  → TtsService.synthesize() → 语音合成 → 更新队列项 audioPath
  → LivePipelineService → PipelineService.enqueue()
  → YundingyunboService.processAudioStream() → GPU 推理 → chunk 流式输出
  → 播放器即时播放 chunk
  → 队列消耗到阈值 → 触发下一轮 AI 生成
  → 循环...

弹幕打断:
  弹幕事件 → EventBatcher → AiLoopService.receiveBatch()
  → 检测关键词 → 切换商品链接 → 带弹幕上下文生成新话术
  → insertAfterCurrent() 插入队列头部 → 优先播放
```

### 数字人对话（遗留功能）

```
用户输入文字
  → chat.ipc.ts: chat:send-stream
  → LlmService.chatStream() → DashScope Qwen API (SSE)
  → 流式 token 推送到 UI (chat:token)
  → AI 回复完成
  → TtsService.synthesize() → UCloud API → WAV 文件
  → PipelineService.enqueue()
  → YundingyunboService → GPU 推理 → 分块输出
  → 播放器即时播放
```

---

## 文件改动注意事项

### 修改 Python 推理脚本后

`resources/scripts/yundingyunbo_bridge.py` 修改后，需要重启应用。YundingyunboService 会在 `startServer()` 时从 `resources/scripts/` 找到脚本并启动。

### 更换数据目录

如果 `data_dir` 不在 `D:\heygem_data`，需要同时修改：
1. `electron/config.ts` 中的 `DEFAULTS.data_dir`
2. `electron/db/index.ts` 中的 `insertDefaultSettings` 中的 `data_dir`

### 新增 IPC 模块

1. 在 `electron/ipc/` 创建 `xxx.ipc.ts`
2. 在 `electron/ipc/index.ts` 中导入并调用注册函数
3. 在 `src/preload/index.ts` 中通过 `contextBridge` 暴露给渲染进程

### 新增平台适配器

1. 在 `electron/services/platform/` 创建适配器，实现 `PlatformAdapter` 接口
2. 在 `platform.manager.ts` 中导入并注册
3. 在 `danmaku.store.ts` 中扩展 `DanmakuPlatform` 类型和 `connect()` 分支
4. 在 `Tab5Danmaku.vue` 中添加 UI 选项

---

## 迁移部署

### 客户部署（绿色版）

把 `release/xiyiji-release/` 整个文件夹复制到客户电脑任意位置，双击 `云映数字人.exe` 即可。
所有依赖（App、yundingyunbo_v163、heygem_data）都在同一文件夹内，通过相对路径自动定位。

客户电脑要求：NVIDIA 驱动（CUDA 支持），无需 Docker、无需 Python。

### 开发环境迁移

| 项目 | 路径 | 必须 |
|------|------|------|
| 项目源码 | `D:\yunyin\XYJ2\xiyiji\`（排除 node_modules/out/release） | 是 |
| yundingyunbo 推理引擎 | `yundingyunbo_v163/` 或 exe 同级目录 | 是 |
| 数据目录 | `heygem_data/` 或 exe 同级目录 | 是 |
| SQLite 数据库 | `%APPDATA%\xiyiji\data\xiyiji.db` | 建议 |
| 输出视频 | `xiyiji_output/` | 可选 |

---

## 遗留代码说明

以下代码为历史遗留，当前不再是主要功能路径但仍保留在代码中：

| 模块 | 说明 |
|------|------|
| `AvatarSelect.vue` / `DigitalChat.vue` / `DigitalLive.vue` / `ParamSettings.vue` | 旧版单页面视图，已被房间多 Tab 架构替代 |
| `avatars` / `voices` / `synth_tasks` / `greenscreen_presets` 表 | 旧版数据表 |

---

## 打包发布

### 构建方式：绿色版（免安装）

使用 `electron-builder --win --dir` 生成免安装绿色版，客户解压即用，无需任何安装步骤。

当前主脚本：

- `一键打包.bat` — 推荐，自动编译 Python .pyc + 更新绿色版
- `scripts/build-release.ps1` — 生成 / 更新绿色版目录
- `scripts/build-win.ps1` — 生成安装包
- `scripts/build-release.sh` — Bash 包装器，内部转发到 PowerShell 脚本
- `scripts/protect-ydb-scripts.ps1` — 编译 Python 脚本为 .pyc 字节码

### 命令

```bash
# 一键打包（推荐）：双击 一键打包.bat，自动编译 .pyc + 打包 release
# 或手动分步执行：

npm run release          # 仅更新 App 绿色版（日常更新）
npm run release:full     # 完整打包（App + yundingyunbo + heygem_data）
npm run build:win        # 生成 NSIS 安装包
```

### 产出目录结构

```
release/xiyiji-release/
├── 云映数字人.exe          ← 客户双击运行
├── *.dll, *.pak, ...       (Electron 运行时文件)
├── resources/
│   ├── app.asar            (应用代码，asar 打包)
│   └── resources/
│       ├── scripts/
│       │   ├── yundingyunbo_bridge.pyc  (推理桥接，.pyc 字节码)
│       │   ├── yundingyunbo_camera_proxy.pyc (摄像头代理，.pyc 字节码)
│       │   └── yundingyunbo_video_stream_bridge.compiled.cpython-310.pyc
│       ├── ffmpeg/          (FFmpeg 二进制)
│       └── OllamaSetup.exe
├── yundingyunbo_v163/       (云鼎云播推理引擎，完整包保留/复制)
├── heygem_data/             (数据目录，完整包保留/创建)
│   └── face2face/
└── xiyiji_output/           (输出目录，运行时自动创建)
```

### 影响范围

- **`out/`** — 中间编译产物，每次 build 覆盖重写
- **`release/`** — 最终发布目录
- **源代码、node_modules、开发配置完全不受影响**
- 完整打包时，只会读取已有的 yundingyunbo 源目录并复制，不会修改源目录内容

`release/` 和 `out/` 都是构建产物，可随时删除，下次打包会重新生成。

### 日常更新流程

改完代码后，双击 `一键打包.bat`，自动完成：
1. 编译 Python .py → .pyc 字节码（protect-ydb-scripts.ps1）
2. 编译 TS + Vue → electron-builder 打包
3. 更新 `release/xiyiji-release/`（afterPack 自动删除 Python 源码，只保留 .pyc）

如果只改了 JS/Vue（没改 Python 脚本），也可以直接 `npm run release`。

日常发版建议：

- **已有完整绿色包目录时**：以后每次改完代码，直接双击 `一键打包.bat` 即可
- 脚本会更新 App 文件，并保留 `release/xiyiji-release/yundingyunbo_v163`、`release/xiyiji-release/heygem_data`
- 如果运行库目录缺失，`一键打包.bat` 现在会自动补拷 `yundingyunbo_v163`
- 打包后会自动确保生成 `release/xiyiji-release/logs`、`heygem_data`、`xiyiji_output` 等目录
- 发给客户时，如果客户已有完整目录，只需覆盖 app 文件即可，不需要每次重传大模型/大引擎

### 首次交付流程

```bash
npm run release:full
```

生成完整的 `release/xiyiji-release/` 目录，包含：

- App
- `yundingyunbo_v163`
- `heygem_data`

客户使用：解压整个文件夹，双击「云映数字人.exe」即可，无需任何安装或复制操作。

### 完整包更新规则

- `npm run release:full` / `--full`：
  - 如果 `release/xiyiji-release/yundingyunbo_v163` 已存在，则跳过复制
  - 总是刷新 App 文件
- `--full-force`：
  - 删除旧的 `yundingyunbo_v163` 后重新复制
- 因此：
  - **第一次做完整交付** 用 `npm run release:full`
  - **之后的普通代码更新** 直接双击 `一键打包.bat`
  - **只有当你想重做完整引擎目录** 时，才需要 `--full-force`

### 路径自动检测

打包后的绿色版通过相对路径自动定位依赖，不再依赖固定盘符：

| 资源 | 检测逻辑 | 关键代码 |
|------|---------|---------|
| yundingyunbo | 环境变量 / 设置页 → exe 同级 → exe 上级 | `yundingyunbo.service.ts: resolveYundingyunboBase()` |
| heygem_data | exe 同级 → exe 上级；设置页可覆盖 | `config.ts` |
| xiyiji_output | exe 同级 → exe 上级 | `config.ts` |
| Python 脚本 | `resources/resources/scripts` → `resources/scripts` | `yundingyunbo.service.ts: findScriptPath()` |

设置页支持手动覆盖：

- `data_dir`
- `yundingyunbo_base`

### 构建环境要求

| 依赖 | 说明 |
|------|------|
| Node.js / npm | Electron 构建和 electron-builder 需要 |
| yundingyunbo Python 环境 | `heyi/python.exe`，用于编译 .pyc 字节码 |
| 国内镜像 | 已在 PowerShell 打包脚本中自动设置 |

### Python 脚本字节码保护

核心推理脚本通过编译为 `.pyc` 字节码保护，发布时不包含 `.py` 源码。

**源码目录结构**（`resources/scripts/`）：
```
yundingyunbo_bridge.py              ← 核心推理桥接（开发用源码）
yundingyunbo_bridge.pyc             ← 编译产物（字节码，发布）
yundingyunbo_camera_proxy.py        ← 虚拟摄像头代理（开发用源码）
yundingyunbo_camera_proxy.pyc       ← 编译产物（字节码，发布）
yundingyunbo_video_stream_bridge.py ← 视频流桥接（开发用源码）
```

**编译方式**：通过 `一键打包.bat` 自动编译，或手动运行 `scripts/protect-ydb-scripts.ps1`。

**afterPack 钩子**（`scripts/protect-asar.js`）：打包时自动从 release 中删除 `.py` 源码，只保留 `.pyc` 字节码。

### 代码保护

| 保护层 | 说明 |
|--------|------|
| Python .pyc 字节码 | 核心推理脚本编译为 .pyc 字节码，源码不随发布包分发 |
| ASAR 打包 | JS 代码打包在 app.asar 中，不直接暴露为文件 |
| Source Map 关闭 | 无 `.js.map` 文件 |
| DevTools 拦截 | 生产环境屏蔽 F12、Ctrl+Shift+I 等快捷键 |
| 反调试 | 检测 `--inspect` 启动参数 |
| API Key | 默认为空，用户首次使用需在设置页面填写 |

### 打包注意事项

- **不要修改 app.asar**：electron-builder 在 afterPack 之前已将 asar integrity hash 嵌入 exe，任何修改都会导致应用闪退
- **Vue Router 必须用静态导入**：asar 内不支持动态 `import()`，会导致白屏
- **Python .pyc 编译**：由 `scripts/protect-ydb-scripts.ps1` 自动完成，需要 yundingyunbo 的 Python 环境
- **首次完整交付**：推荐先执行一次 `npm run release:full`，这样可明确重建完整运行库
- **日常更新**：后续通常只需要双击 `一键打包.bat`；如果发现运行库目录缺失，脚本也会自动补齐

## Release Verify

- `一键打包.bat` 现在会在打包末尾自动执行 `scripts/verify-release.ps1`
- 只有看到控制台输出 `[verify] release verification passed`，才表示绿色包检查通过
- 该检查会确认：
  - `release/xiyiji-release` 关键目录齐全
  - `yundingyunbo_v163` / `ffmpeg` / `node.exe` 都在包内
  - `yundingyunbo` bridge 在”系统 PATH 没有 Node.js”时仍能启动到 ready
- 打包后的程序启动时，会在 `release/xiyiji-release/logs/*.log` 里自动写入 `[SelfCheck]` 行，记录：
  - 当前日志目录
  - data/output 目录
  - yundingyunbo / node / ffmpeg 的实际解析路径
  - 关键可执行文件版本探测结果
- 发客户时，优先整个替换 `release/xiyiji-release/`，不要只替换单个 exe

---

## 2026-03 Portable Release Notes

- `һ�����.bat` now does the full customer delivery flow:
  - rebuild app
  - refresh `release/xiyiji-release/data/xiyiji.db`
  - copy referenced avatar videos into `release/xiyiji-release/data/avatar_videos`
  - prewarm yundingyunbo character cache under `release/xiyiji-release/heygem_data/yundingyunbo_characters`
- Packaged runtime data is now portable:
  - DB: `release/xiyiji-release/data/xiyiji.db`
  - avatar assets: `release/xiyiji-release/data/avatar_videos`
  - logs: `release/xiyiji-release/logs`
- Packaged app no longer depends on the builder machine's AppData DB or hardcoded local avatar video paths.
- If the release folder is moved to another drive or another machine, startup will repair packaged paths back to the current folder automatically.

---

## 项目分析文档索引

| 文档 | 路径 | 生成日期 | 说明 |
|------|------|---------|------|
| 项目全面分析报告 | [docs/项目全面分析报告.md](docs/项目全面分析报告.md) | 2026-04-03 | 架构、技术栈、服务层、数据流、代码规模全面分析（基于 V28.0.0 快照，内容可能随代码演进而过时） |
