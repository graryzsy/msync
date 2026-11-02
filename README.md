# MSync

**TypeScript + Electron + React** 编写的音乐收藏同步桌面应用。macOS、Windows、Linux 共享界面、同步核心与平台适配器。SQLite 使用 WebAssembly 实现，没有需要针对 CPU 架构重新编译的数据库插件。

以 Spotify 作为首次基准；对已确认对应关系的收藏，识别并传播实际观察到的新增与取消。歌曲点赞、专辑收藏、艺人关注分别记录，保留发行版本与完整发行日期的严格约束。

当前版本已移除 Swift 工程与 SwiftUI 界面。构建业务代码无需 Swift、Xcode 或付费 Apple Developer 会员。安装包自带 Electron/Node 运行时，**部署电脑无需额外安装 Node.js**。

## 平台接入的实际能力

| 平台与模式 | 读取 / 查找 | 添加与取消 |
| --- | --- | --- |
| Spotify（所有系统） | 官方 API：歌曲、专辑、艺人 | 官方 API |
| 网易云（所有系统） | 社区接口：歌曲、专辑、艺人 | 社区接口 |
| Apple Music 本机模式（macOS） | Music.app 资料库内歌曲、专辑的喜爱星标 | 使用 macOS 自带 JXA / Apple Events 设置星标 |
| Apple Music 网页确认（所有系统） | 仅记录用户逐项核实的网页条目和状态 | 在系统浏览器操作，再回到软件确认 |

Apple Music 不使用开发者令牌或借用第三方令牌。macOS 本机模式通过系统自带的 JavaScript for Automation 控制 Music.app，代码也是 JavaScript，不含 Swift。艺人完整喜爱列表、资料库外曲目与消失条目无法由该脚本完整覆盖；缺失状态保持未知。

Windows、Linux 没有本机 Music.app 接口，因此提供明确标记的网页确认流程。**当前没有实现 Apple Music 网页全自动读取或点击**，也不会将手动记录伪装成实时云端状态。全自动三平台同步的 Apple Music 接入仍有上述限制。

## 开发与运行

构建电脑安装 **Node.js 24 LTS**（最低 22.12）和 Git；三个系统的命令一致：

```sh
git clone --branch develop https://github.com/graryzsy/msync.git
cd msync
npm ci
npm test
npm run build
npm start
```

开发模式使用 Vite 页面热更新；主进程改动后重新启动：

```sh
npm run dev
```

首页有“体验离线演示”，使用独立的内存数据库与模拟平台，不连接真实账户。进入“同步预览”，可以模拟 Apple Music 取消第一首歌曲的收藏，查看另外两平台的取消操作并执行，再模拟重新收藏。退出演示后回到原来的个人记录。

命令行离线示例：

```sh
npm run demo
```

## 在 M 系列 Mac 上为 Intel Mac 打包

通用版合并使用 Apple 的 `lipo` 命令。构建那台 Mac 如果尚未安装 Apple Command Line Tools，先运行 `xcode-select --install`；无需安装完整 Xcode，也无需付费开发者会员。部署目标电脑不需要这些构建工具。

```sh
npm ci
npm run package:mac
```

Universal 通用版同时包含 `arm64` 与 `x86_64`，可分别部署到 M 系列 macOS 26 和 Intel macOS 15。应用声明最低 macOS **15.0**。只需要 Intel 版本时：

```sh
npm run package:mac:x64
```

产物在 `release/`。将 `.zip` 中完整的 `MSync.app` 或 `.dmg` 中的应用复制到目标电脑。在 M 系列 Mac 构建不代表已经在 Intel macOS 15 运行验证；目标机器仍应检查启动、Music.app 自动化、钥匙串和真实账户读写。

Mac 构建使用个人本地 ad-hoc 签名，不申请付费 Developer ID，也不公证。目标电脑若被 Gatekeeper 拦截，需要在系统设置中确认你自己构建的应用；此配置不代表 App Store 或公开分发所需的签名与公证已经完成。

## Windows 与 Linux 打包

建议在相应系统构建与测试：

```sh
# Windows x64：NSIS 安装程序
npm run package:win

# Linux x64：AppImage
npm run package:linux

# 当前系统的应用目录，用于本机验证
npm run package:dir
```

三个系统不共用同一个安装包，但共享 TypeScript 业务代码。GitHub Actions 配置 Windows、Linux、macOS 的测试、桌面集成检查和打包；macOS 作业构建 Universal `.zip`。是否通过以工作流的实际运行结果为准。

## 首次使用

1. **Spotify**：在 [Developer Dashboard](https://developer.spotify.com/dashboard) 创建个人应用，回调地址设为 `http://127.0.0.1:19428/callback`。设置页填写 Client ID 并连接；采用浏览器授权和 PKCE，不保存 Client Secret。
2. **网易云**：在设置页生成二维码，使用手机网易云 App 扫码并确认，再检查登录状态。社区接口可能受限流、登录过期或协议变化影响。
3. **Apple Music / Mac 本机模式**：先打开 Music.app 并完成资料库同步，选择本机模式，允许 MSync 控制音乐 App。歌曲与专辑按喜爱星标同步，加入资料库不视为点赞或收藏整张专辑。
4. **Apple Music / 网页确认模式**：在浏览器登录 Apple Music，在软件的“网页确认”页登记链接、艺人、所属发行、完整日期并确认状态。歌曲专辑页面链接应包含 `?i=曲目ID`，也支持 `/song/…/ID` 页面。
5. 扫描收藏，从条目详情查找对应版本，核实后填写证据。可以先建立两平台关系，再为同一 Spotify 条目增加第三个平台。
6. 查看预览后执行。首次以 Spotify 状态对齐已确认关系；未映射收藏保留。记录基线后才能通过历史判断主动取消。

网页模式下，Apple Music 待同步操作生成附平台页面链接的人工待办。请在网页完成后确认状态，再重新扫描。也可以主动在网页确认页记录取消，让下一次同步将取消传播到其他平台。

更换 Apple 账户、Music 资料库或切换本机/网页模式后，先导出记录，再重新建立本地基线。本机模式无法可靠识别同一资料库内更换云端 Apple 账户的情况。

## 身份匹配与删除传播

- 对象是具体发行版本中的曲目，原专辑、精选集、单曲、豪华版与重制版分别处理。
- 同 ISRC、同名、同封面不足以判定相同；完整发行年月日必须核实一致。只有年份或年月时不补成完整日期。
- 规范化大小写、空白和 Unicode 兼容形式，保留版本文字。不同发行名称保守拒绝；翻译、别名或平台元数据问题可能需要补充证据或后续扩展。
- 艺人同名始终需要确认。“信息一致”只代表候选，没有自动赋予已核实状态。
- 可靠的完整列表缺失或明确未收藏才允许推断取消；读取失败、分页失败、未知状态不作为空列表。
- 预览不写入基线；执行前重新读取状态，拒绝过期预览。先持久化目标与待办，再执行远程操作，回读确认后标记完成。
- 删除目标持久保存；离线平台恢复时不会仅凭旧收藏复活条目。真正观察到的后续新增可以重新收藏。
- 失败保留意图，可重新扫描继续。相反操作仅在 Spotify 本身有主动变更时优先采用它；其他冲突等待处理。
- 平台间没有统一事务，轮询无法还原全部中间操作；当前以观察到的状态实现最终一致。

AI 图像辅助尚未接入，不调用收费模型。后续 AI 只能提供候选和可检查的证据，不能放宽日期条件或直接授权删除。

## 数据与安全存储

收藏、映射、历史和删除目标位于 `collections.sqlite`，是标准 SQLite 文件。写入先完成临时文件与 fsync，再替换目标；发现其他进程修改时拒绝覆盖。Electron 限制同一用户目录的多实例运行。

凭据通过 Electron `safeStorage` 调用 macOS 钥匙串、Windows 系统加密或 Linux 密钥环，写入 `credentials.enc`。Linux 缺少密钥环或使用 `basic_text` 后端时，**只在内存保留本次登录，不保存明文凭据**。

界面通过隔离 preload 与白名单 IPC 调用服务，没有 Node.js 访问能力，也不会收到 Token/Cookie。外部链接限制为受支持音乐平台的 HTTPS 页面。

备份包含对应关系与历史，不包含凭据；另一电脑导入后需单独登录。导入不直接执行备份中的未完成写入。旧版导出的 JSON 也可导入，**不会自动读取旧钥匙串或覆盖旧 `state.sqlite`**。网页确认记录位于 `apple-web.json`，目前不包含在历史备份中，迁移到另一台电脑后应重新核实。

默认用户目录：macOS 为 `~/Library/Application Support/MSync/`，Windows 为 `%APPDATA%/MSync/`，Linux 为 `~/.config/MSync/`（受 XDG 配置影响）。

## 验证与结构

```sh
npm run typecheck
npm test
npm run build
npm run test:ui
```

界面测试使用项目中的 Electron，无需另行下载 Playwright 浏览器。测试使用独立临时目录和离线演示；Linux 使用无显示器的 Ozone 后端。设置 `MSYNC_ELECTRON_EXECUTABLE` 可对已打包应用运行相同的桌面测试。

```text
src/core/        共享模型、严格匹配、计划、SQLite 与执行协调
src/adapters/    Spotify / 网易云 / Apple Music 接入
src/main/        Electron 主进程、安全存储、白名单 IPC
src/renderer/    React 界面
src/shared/      界面与主进程接口
resources/      可选 macOS Music.app JavaScript 脚本
tests/          规则、持久化、授权、适配器与安全边界测试
e2e/            真实 Electron 桌面流程测试
```
