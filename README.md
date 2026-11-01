# MSync

macOS 15 个人音乐收藏同步工具的首版实现。主体为 **Swift + SwiftUI**，网易云接入为 **TypeScript + Node.js**，本地状态保存在 SQLite。

以 Spotify 建立初始基线；已经确认对应关系的收藏可由任意可读平台发起新增或取消。专辑、艺人、歌曲分别处理。第一版采用手动“扫描 → 核实对应版本 → 查看预览 → 执行同步”，没有后台无人值守任务。

## 当前能力与边界

| 平台 | 歌曲 | 专辑 | 艺人 |
| --- | --- | --- | --- |
| Spotify | 官方接口读取、搜索、增删喜欢 | 官方接口读取、搜索、增删收藏 | 官方接口读取、搜索、关注/取消关注 |
| 网易云音乐 | 社区接口读取、搜索、红心增删 | 社区接口读取、搜索、收藏增删 | 社区接口读取、搜索、收藏增删 |
| Apple Music | Music.app 资料库内喜爱状态的读取、查找、设置 | Music.app 资料库内专辑星标的读取、查找、设置 | **未实现自动读取和写入**；界面明确显示待处理原因 |

**Apple Music 不使用 MusicKit 开发者令牌，不需要付费开发者会员。** 它通过 macOS 自带的 JavaScript for Automation（AppleScript 同一套 Apple Events 机制）控制 Music.app，不读取 Apple 账户密码、Cookie 或客户端私有数据库。

该方案有实际能力限制：

- Apple Music 只对资料库中脚本明确返回的条目确认喜爱状态。资料库外收藏、未能读取的条目、整个条目消失均保持未知，不推断为主动取消收藏。
- 目标歌曲或专辑尚未在本机资料库时，请先在 Music.app 中找到**对应发行版本**并加入资料库，再回到 MSync 查找对应关系。
- Apple Music 专辑收藏在本版本中定义为**专辑星标**，不将加入资料库或某一首歌存在于资料库视为收藏整张专辑。
- 脚本不提供完整艺人喜爱列表，第一版没有假装实现这一能力。跨三个平台的艺人全自动同步仍需后续补足网页/界面接入并在真实 Mac 上验证。
- Apple Music 账户身份以本机资料库标识隔离，不能可靠识别“同一个资料库内更换云端账户”。更换 Apple 账户后，先导出记录，再通过连接页的“重新建立同步基线”清除旧对应关系。
- AI 图像辅助尚未接入，本版不调用收费模型接口。匹配模型保留完整证据和人工确认入口，后续 AI 只能提供候选和证据，不能直接授权删除。

SwiftUI、钥匙串、Music.app Apple Events、扫码登录和真实账户读写均需要 macOS 15 与本人账户实测。Linux 上可构建共享模块、运行离线命令行示例与自动化测试；Linux 上编译的桌面入口仅说明平台要求。

## 在 Mac 上运行

需要 macOS 15、Xcode 16（Swift 6）或更新版本，以及 Node.js 22+（启用网易云时）。使用免费 Xcode 工具即可构建；不需要 App Store 发布或付费开发者会员。

```sh
cd /你的目录/msync
cd Companion
npm ci --ignore-scripts --no-audit --no-fund
npm run build
cd ..
bash scripts/build-app.sh --with-companion
open dist/MSync.app
```

推荐从 `.app` 启动，确保系统能读取其中的 `NSAppleEventsUsageDescription`。也可 `swift run MSync` 调试，但 macOS 可能将自动化授权归于启动它的终端或 Xcode。

打包脚本生成本机架构的 `.app` 并作 ad-hoc 本地签名。它不上传应用、不申请公证，也不访问付费开发者服务。`--with-companion` 将网易云辅助模块加入应用，**不会打包 Node 运行时**；连接设置中填写本机 Node 的完整路径，例如 `/opt/homebrew/bin/node` 或 `/usr/local/bin/node`。不传该参数也能构建主应用，但网易云需要另行指定已构建的辅助模块路径。

### 连接与首次同步

1. **Spotify**：在 [Developer Dashboard](https://developer.spotify.com/dashboard) 创建个人应用，将回调地址设为 `http://127.0.0.1:19428/callback`；在 MSync 连接页填写 Client ID，点击连接。使用 PKCE，不需要在软件里保存 Client Secret。
2. **Apple Music**：先打开 Music.app，等待资料库同步完成；在连接页启用本机接入。首次扫描时允许 MSync 控制音乐 App。系统设置 → 隐私与安全性 → 自动化中可以检查该权限。
3. **网易云**：检查 Node 与 `Companion/dist/bridge.js` 路径，生成二维码，用网易云 App 扫码确认，再点击“检查登录”。Cookie 经标准输入传给辅助进程，不出现在进程参数或日志里。
4. 扫描收藏，在“收藏”中选择条目并查找另一平台的对应版本。逐项核实日期、所属发行版本和艺人，填写证据，再保存对应关系。可以先确认 Spotify ↔ Apple Music，再为同一 Spotify 条目增加网易云，系统会扩展成三平台对应关系。
5. 再次扫描，在“同步预览”中核对操作。执行前会再次检查账户和相关收藏状态；状态变化时旧预览会被拒绝。
6. 第一次以 Spotify 状态对齐**已经确认的对应关系**；其他未映射收藏保留，不会自动清空。执行“记录本次基线”后，之后的真实新增/取消才可根据历史判断。

Apple Music 能力的只读检查（输出属性与数量，不修改收藏）：

```sh
bash scripts/probe-apple-music.sh
```

## 严格的歌曲身份

内部实体为“某一发行版本中的曲目”。同 ISRC、同封面或同名都不足以确认相同：

- 原专辑、精选集、单曲发行分别处理。
- 所属发行名称、版本标记与完整 `YYYY-MM-DD` 必须核实一致。
- 年份或年月不会补成完整日期；缺失日期可以由用户在查证后补充，并必须保存证据。
- 日期冲突、曲序冲突、ISRC 冲突不会自动合并；艺人同名始终需要人工确认身份。
- 大小写、空白与 Unicode 兼容形式可规范化，Live、Deluxe、Remastered 等版本信息保留。
- 网易云使用**所属专辑**的 `publishTime`，按该平台的中国标准时间日历解释；不将歌曲最早发行时间当成当前专辑日期。

匹配器的 `compatible` 仅表示没有发现规则冲突，不会自动将候选标记为已核实。没有证据和确认的对应关系不进入同步计划。

## 状态与恢复

- SQLite 同一事务持久化快照、目标状态、待执行操作和日志。删除目标会持久保存，离线平台回来时不会仅因保留旧收藏而把条目复活。
- 只有完整列表的缺失，或条目明确返回未收藏，才能推断移除。读取失败、限流、缺页、未知状态均不当作空收藏。
- 预览是只读操作；执行后才记录本次观察到的意图。远程写入成功后必须回读目标状态再确认本地完成。
- 部分操作失败会保留目标意图和待处理记录。重新扫描、查看新预览后可以继续；不要直接重复执行旧预览。
- 有相反变化且 Spotify 本身有变化时，以 Spotify 这次变化为准。只有其他两平台相互冲突时等待人工处理；不把扫描顺序当作用户操作时间。
- 账户/资料库 ID 变化时拒绝沿用旧基线。可以导出后通过连接页重新建立本地基线，平台收藏不会被重置。
- 平台之间没有跨服务事务；实时并发操作或在两次扫描之间完成的反复操作无法全部还原。首版以已观察状态实现最终一致。

数据位于 `~/Library/Application Support/MSync/state.sqlite`；登录凭据放在 macOS 钥匙串。导出 JSON 包含收藏、对应关系与历史，不包含登录凭据。导出文件目前用于备份和人工查看，尚无界面导入恢复功能。

## 开发验证

```sh
swift test
swift run msync demo
cd Companion && npm test
```

`msync demo` 完全离线，展示 Apple Music 取消收藏后生成另外两平台取消操作，不连接也不修改真实账户。`msync plan input.json [state.sqlite]` 可离线生成 JSON 预览；输入为 `{ "mappings": [...], "snapshots": [...] }`，结构见 `Sources/MSyncCore/Models.swift`。`msync inspect state.sqlite` 只读取本地记录。

`.github/workflows/ci.yml` 配置了 macOS 15 原生构建/测试/打包，以及 Node 辅助模块的构建/测试。工作流需要代码推送到 GitHub 后才会运行；仓库中的配置不代表远程检查已经通过。

## 目录

```text
Sources/MSyncCore/       发行身份、匹配、同步计划、SQLite、协调执行
Sources/MSyncAdapters/   Spotify API/PKCE、Music.app 脚本、网易云进程桥
Sources/MSyncApp/        SwiftUI 界面、钥匙串、浏览器授权回调
Sources/MSyncCLI/        离线预览与演示
Companion/              网易云 TypeScript 辅助模块及锁定依赖
Tests/                  版本匹配、删除传播、持久化、授权及故障测试
scripts/                Mac 打包和 Music.app 只读能力检查
```

## 参考

- [Spotify 当前开发模式迁移说明](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [Spotify 统一收藏写入接口](https://developer.spotify.com/documentation/web-api/reference/save-library-items)
- [网易云社区接口库](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)

当前实现是个人使用的首版，不宣称已经完成三平台所有收藏类别的无人值守同步。
