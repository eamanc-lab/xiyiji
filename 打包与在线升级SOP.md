# 打包与在线升级SOP

最后更新：2026-03-29  
当前有效版本：`V28`（内部包版本：`28.0.0`）

当前补充说明：

- 这次 `V28` 用于正式验证 `V27 -> V28` 在线升级闭环。
- `V22 -> V27` 期间客户日志反复出现 `Updater helper exited too early` / `startup timed out`，根因集中在旧的 `cmd/start + PowerShell 文件脚本 + 多命令行参数` 交接链路。
- 当前升级器已改为：主程序先写配置文件，再起一个 starter PowerShell，由它用 `Start-Process` 拉起真正的 helper PowerShell。
- 这样可以避免把中文 exe 名、长路径、ready/result/health 等一串参数直接经过 `cmd/start` 传递。
- 这版 `V28` 的定位是用于验证“客户已手动覆盖到 V27 后，能否稳定在线升级到 V28”。

## 1. 作用范围

这份文档是本项目所有“打包、发客户、在线升级、OSS 发布、版本号管理”的唯一权威说明。  
以后无论是谁接手，无论是人工还是新的 AI 对话，只要涉及以下任一动作，都必须先看本文件：

- 完整打包
- 在线升级包生成
- OSS 上传
- 发客户
- 验证客户升级链路
- 排查“检查更新失败 / 下载升级包失败 / 升级后打不开”

除本文件外，其它历史打包说明、旧聊天记录、旧 txt、旧 md 都只能作为参考，不能覆盖本文件。

## 2. 唯一正式工作目录

当前唯一正式项目目录：

`D:\yunyin\XYJ2\xiyiji`

旧目录：

`D:\XYJ2\xiyiji`

规则：

- 以后所有构建、打包、发布、OSS 上传，一律只在 `D:\yunyin\XYJ2\xiyiji` 执行。
- `D:\XYJ2\xiyiji` 是旧目录，只能当历史备份看，不能作为正式打包源目录。
- 如果看到两个目录内容不一致，以 `D:\yunyin\XYJ2\xiyiji` 为准。

## 3. 分发策略

本项目固定采用两条分发线：

- 完整包：给首次安装客户，或客户彻底重装时使用。完整包走百度网盘。
- 在线升级包：给已有客户程序内升级时使用。升级包走阿里云 OSS。

固定原则：

- 日常小版本更新，不再给客户发 `40G` 完整包。
- 日常只发在线升级包。
- 只有首次交付、重大故障、运行时整体变化时，才发完整包。

## 4. 产物说明

### 4.1 发给客户的完整包

完整包目录：

`D:\yunyin\XYJ2\xiyiji\release\xiyiji-release`

发客户时：

- 压缩整个 `release\xiyiji-release`
- 不要只发 exe
- 不要发 `release\online-update`
- 不要发 `win-unpacked`

### 4.2 程序内在线升级包

在线升级产物目录：

`D:\yunyin\XYJ2\xiyiji\release\online-update`

里面的关键文件：

- `manifest.json`
- `manifest.template.json`
- `xiyiji-app-update-x.x.x.zip`

其中：

- `manifest.json` 是程序检查更新时读取的升级清单
- `zip` 是程序实际下载的升级包
- `manifest.template.json` 只是本地参考副本

## 5. 当前固定地址

当前程序内置升级地址来自：

- `update-config.json`
- `electron/default-settings.ts`

当前有效地址：

- Manifest URL：`https://xiyijiupdate2.oss-cn-hangzhou.aliyuncs.com/manifest.json`
- Base URL：`https://xiyijiupdate2.oss-cn-hangzhou.aliyuncs.com`

当前线上升级包命名规则：

- `https://xiyijiupdate2.oss-cn-hangzhou.aliyuncs.com/xiyiji-app-update-28.0.0.zip`

固定规则：

- `manifest.json` 地址固定，不随版本变化
- `zip` 文件名带版本号
- 程序永远通过固定 `manifest.json` 找到当前最新 zip

## 6. 当前版本规则

### 6.1 版本号唯一来源

内部包版本仍以 `package.json` 中的 `version` 为准。

从这次开始，版本体系切换为：
- `20.0.0` 对外显示为 `V20`
- `21.0.0` 对外显示为 `V21`
- `22.0.0` 对外显示为 `V22`

### 6.2 后续递增规则

- 以后每次正式更新，只递增主版本号 `+1`
- 固定按 `27.0.0 -> 28.0.0 -> 29.0.0` 继续走
- 不再继续使用 `4.0.x` 这一套版本号

### 6.3 在线升级触发规则

程序只会从旧版本升级到更高版本。

例如：
- `19.0.0` 可以升级到 `20.0.0`
- `20.0.0` 可以升级到 `21.0.0`
- `21.0.0` 可以升级到 `22.0.0`
- `22.0.0` 可以升级到 `23.0.0`
- `23.0.0` 可以升级到 `24.0.0`
- `24.0.0` 可以升级到 `25.0.0`
- `25.0.0` 可以升级到 `26.0.0`
- `26.0.0` 可以升级到 `27.0.0`
- `27.0.0` 可以升级到 `28.0.0`
- `27.0.0` 不会升级到 `27.0.0`

结论：
- 只要要测试“检查更新”和“下载升级包”，远端版本必须大于本地版本。
- 同版本不能拿来测试在线升级，这是硬规则。

### 6.4 发版前必须做的版本动作

如果要发布新的在线升级：

1. 先修改 `package.json` 的 `version`
2. 再执行打包
3. 再上传 OSS

禁止顺序：
- 先上传旧版本包，再改版本
- 不改版本直接测试升级

### 6.5 左上角版本显示规则

程序左上角标题栏必须显示：
- `云映数字人 V<主版本号>`

固定规则：
- 每次发布新版本，必须先递增 `package.json` 的 `version`
- `package.json`、`manifest.json`、升级 zip 文件名使用内部包版本，例如 `28.0.0`
- 左上角和升级面板统一显示对外版本，例如 `V28`
- 如果左上角没有显示版本号，视为本次发布不合格，不能发客户，不能上传 OSS

## 7. 标准命令

所有命令都在正式目录执行：

`D:\yunyin\XYJ2\xiyiji`

### 7.1 单元测试

```powershell
npm run test:unit
```

### 7.2 基础构建

```powershell
npm run build
```

### 7.3 只生成应用层发布包和在线升级包

```powershell
npm run release
```

适用场景：

- 日常代码更新
- 运行时没变化
- 只想更新程序层
- 只想生成在线升级包

### 7.4 生成完整客户交付包

```powershell
npm run release:full
```

适用场景：

- 首次交付客户
- 需要发完整包到百度网盘
- 要确认完整运行时一起打入交付目录

### 7.5 只上传当前已生成的在线升级包到 OSS

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-oss.ps1 -SkipBuild
```

### 7.6 一键发布 OSS

```powershell
.\一键发布OSS.bat
```

## 8. 标准发布流程

补充要求：

- 如果这次发布涉及在线升级链路改动，除了 `npm run test:unit`、`npm run build`、`npm run release` 外，还要至少做一次本机真实 handoff 烟测。
- 当前用于验证 updater helper 启动链路的烟测脚本：`tmp\updater_handoff_psstart.js`
- 验证命令：

```powershell
node tmp\updater_handoff_psstart.js
```

- 期望结果：
  - 输出 `ok: true`
  - `stdout` 至少包含 `STARTED`
  - `ready.launchExecutable` 能正常带出中文 exe 名

### 8.1 日常在线升级发布流程

适用于：程序逻辑改了，但不需要重新发完整包。

1. 在正式目录改代码
2. 递增 `package.json` 版本号
3. 执行：

```powershell
npm run test:unit
npm run build
npm run release
```

4. 检查本地产物：

- `release\online-update\manifest.json`
- `release\online-update\xiyiji-app-update-x.x.x.zip`
- 程序左上角显示 `云映数字人 V新版本`

5. 执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-oss.ps1 -SkipBuild
```

6. 用浏览器或命令拉取远端 `manifest.json`，确认远端已更新
7. 用旧版本客户端真实点一次“检查更新”

### 8.2 首次客户交付流程

适用于：要发完整包给新客户。

1. 在正式目录确认代码无误
2. 修改 `package.json` 到目标正式版本
3. 执行：

```powershell
npm run test:unit
npm run build
npm run release:full
```

4. 确认完整包目录：

`D:\yunyin\XYJ2\xiyiji\release\xiyiji-release`

5. 压缩整个 `xiyiji-release`
6. 上传百度网盘
7. 如果同版本还需要已有客户在线升级，再额外上传 OSS

### 8.3 重大版本的推荐顺序

最稳顺序如下：

1. 先跑 `npm run release:full`
2. 用完整包自测
3. 确认没问题后，再跑 `publish-oss.ps1 -SkipBuild`
4. 最后再发给客户

## 9. 在线升级技术规则

### 9.1 清单文件规则

升级清单文件：

`release\online-update\manifest.json`

必须满足：

- 必须是合法 JSON
- 编码必须是 UTF-8 无 BOM
- `version` 必须高于客户端当前版本
- `appPackage.url` 必须是可直接访问的 zip 地址
- `sha256` 必须和 zip 实际一致

### 9.2 已修复的关键坑

2026-03-28 已确认修复以下问题：

- `manifest.json` 以前可能带 UTF-8 BOM，导致程序报“更新清单不是合法的 JSON”
- 当前脚本已改成输出无 BOM
- 当前客户端代码也已兼容 BOM 清单

对应修复文件：

- `scripts/build-update-package.ps1`
- `electron/services/app-updater.service.ts`
- `electron/services/app-updater.spec.ts`

### 9.4 启动时更新提示规则

从 `V21` 开始，程序启动后会自动检查一次更新，但不会自动下载，也不会自动安装。

固定规则：

- 如果远端有新版本，程序弹出提示，让客户自己选择是否现在下载
- 如果升级包已经下载完成，程序弹出提示，让客户自己选择是否现在安装
- 关闭程序后不会自动强制重启安装
- 客户不处理也可以继续使用当前版本

结论：

- “重新打开软件时，如果有更新，要提示更新，客户可以自己选择” 已纳入正式规则
- 后续如修改升级交互，必须同步修改本文件

### 9.3 升级覆盖范围

在线升级会替换：

- 根目录 exe
- `resources/app.asar`
- 应用层 Electron 文件

在线升级不会覆盖：

- `data`
- `heygem_data`
- `logs`
- `xiyiji_output`
- `yundingyunbo_v163`
- `.runtime`

结论：

- 在线升级只更新程序层
- 客户数据、素材、输出、运行时目录不会被升级覆盖

## 10. OSS 发布规则

### 10.1 当前 Bucket

当前使用：

`oss://xiyijiupdate2`

### 10.2 当前线上地址

- `manifest.json`：`https://xiyijiupdate2.oss-cn-hangzhou.aliyuncs.com/manifest.json`
- zip：`https://xiyijiupdate2.oss-cn-hangzhou.aliyuncs.com/xiyiji-app-update-<version>.zip`

### 10.3 发布脚本

发布脚本：

`scripts/publish-oss.ps1`

脚本作用：

- 自动读取 `update-config.json`
- 自动读取 `release\online-update\manifest.json`
- 自动识别 zip 文件名
- 自动上传 zip 和 `manifest.json`
- 自动做远端 HTTP 可访问性校验

### 10.4 OSS 工具

已验证可用 `ossutil.exe` 路径：

`D:\XYJ2\xiyiji\docs\ossutil-2.2.1-windows-amd64\ossutil.exe`

如果 PATH 里没有 `ossutil`，脚本也会优先尝试常见固定路径。

## 11. 客户交付规则

### 11.1 发客户什么

首次客户交付：

- 发 `release\xiyiji-release` 的压缩包

已有客户日常更新：

- 不发 `40G` 完整包
- 让客户在程序内点“检查更新”

### 11.2 不要发什么

禁止发给客户：

- `release\online-update`
- `release\win-unpacked`
- 单独 exe
- 旧目录 `D:\XYJ2\xiyiji` 下的打包结果

### 11.3 百度网盘和程序内完整包按钮

当前策略：

- 完整包走百度网盘
- 在线升级包走 OSS

如果希望程序里“完整包下载”按钮可用，需要把以下字段填到：

`update-config.json`

字段：

- `fullPackageUrl`
- `fullPackageCode`

## 12. 每次发布前的强制检查清单

发布前必须全部满足：

- 当前工作目录是 `D:\yunyin\XYJ2\xiyiji`
- `package.json` 版本号已经改到新版本
- `npm run test:unit` 通过
- `npm run build` 通过
- `npm run release` 或 `npm run release:full` 通过
- `release\online-update\manifest.json` 已生成
- `manifest.json` 文件头不是 `EF BB BF`
- `manifest.json` 里的 `version`、`url`、`sha256`、`size` 正确
- 左上角标题栏显示 `云映数字人 V当前版本`
- 若要测试在线升级，本地客户端版本必须低于远端版本

## 13. 每次发布后的强制验收清单

### 13.1 在线升级验收

至少做以下检查：

1. 拉远端 `manifest.json`，确认可解析
2. 用旧版本客户端点击“检查更新”
3. 能看到新版本号
4. 点击“下载升级包”能成功
5. 点击“立即重启升级”能成功
6. 升级后版本号变成新版本
7. 升级后左上角显示 `云映数字人 V新版本`
8. 升级后 `data`、`heygem_data`、`xiyiji_output`、`yundingyunbo_v163` 仍在

### 13.2 完整包验收

至少做以下检查：

1. `release\xiyiji-release` 目录存在
2. `云映数字人.exe` 时间是本次打包时间
3. `resources\app.asar` 时间是本次打包时间
4. `yundingyunbo_v163` 存在
5. `data` 存在
6. `heygem_data` 存在
7. 左上角显示 `云映数字人 V当前版本`
8. `npm run release:full` 输出里看到 `release verification passed`

## 14. 典型问题与处理

### 14.1 检查更新提示“更新清单不是合法的 JSON”

优先检查：

- `manifest.json` 是否带 BOM
- OSS 上是不是旧的错误 manifest
- 远端文件是否被手工编辑坏了

当前解决办法：

- 重新执行 `npm run release`
- 重新执行 `publish-oss.ps1 -SkipBuild`

### 14.2 点击下载升级包报错

优先检查：

- `manifest.json` 是否能正常解析
- `appPackage.url` 是否能直接访问
- `sha256` 是否和 zip 一致
- 版本号是否高于客户端本地版本

### 14.3 为什么发给客户的包还是 40G

因为完整包本来就包含运行时和素材目录。  
这不是日常更新包。日常更新应该走程序内在线升级，而不是每次重发完整包。

### 14.4 为什么客户安装最新完整包后看不到升级

因为完整包和线上版本号相同。  
同版本不升级，这是正常行为。

## 15. 禁止事项

以后严禁：

- 在 `D:\XYJ2\xiyiji` 做正式打包
- 不改版本号就测试在线升级
- 手工改 OSS 上的 `manifest.json` 而不核对 sha256
- 发 `online-update` 给客户
- 发旧目录里的 `xiyiji-release` 给客户
- 看到有两个项目目录时，凭感觉选一个打包

## 16. 未来 AI 对话的强制执行规则

以后任何新的 AI 对话，只要用户提到：

- 打包
- 发客户
- 检查更新
- 在线升级
- OSS
- manifest

必须先遵守以下规则：

1. 先确认正式工作目录是 `D:\yunyin\XYJ2\xiyiji`
2. 先阅读本文件 `打包与在线升级SOP.md`
3. 禁止使用 `D:\XYJ2\xiyiji` 作为正式打包目录
4. 凡是在线升级，先确认版本号是否比客户版本高
5. 凡是发客户完整包，只能发 `release\xiyiji-release`

## 17. 当前有效结果

截至 2026-03-29，当前已确认：

- 当前版本：`V28`（内部包版本：`28.0.0`）
- 本地完整包目录：`D:\yunyin\XYJ2\xiyiji\release\xiyiji-release`
- 本地在线升级目录：`D:\yunyin\XYJ2\xiyiji\release\online-update`
- 线上 manifest：`https://xiyijiupdate2.oss-cn-hangzhou.aliyuncs.com/manifest.json`
- 线上 zip：`https://xiyijiupdate2.oss-cn-hangzhou.aliyuncs.com/xiyiji-app-update-28.0.0.zip`

## 18. 本文档关联入口

以下文件必须与本文档保持一致：

- `CLAUDE.md`
- `本次进度交接.txt`

如果三者冲突：

以本文件为准。

