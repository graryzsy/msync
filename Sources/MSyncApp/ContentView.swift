#if os(macOS)
import SwiftUI
import AppKit
import MSyncCore
import MSyncAdapters

@MainActor
struct ContentView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Image(systemName: "music.note.list").font(.system(size: 28, weight: .semibold)).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 4) {
                    Text("收藏同步").font(.title2.bold())
                    Text("保留每个发行版本，让三个音乐收藏保持一致。").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button("导出记录", systemImage: "square.and.arrow.up") { model.exportState() }.disabled(model.busy)
                Button("扫描收藏", systemImage: "arrow.clockwise") { Task { await model.scan() } }
                    .buttonStyle(.borderedProminent).disabled(model.busy).keyboardShortcut("r")
            }.padding(22)
            Divider()
            TabView {
                LibraryView(model: model).tabItem { Label("收藏", systemImage: "heart") }
                PreviewView(model: model).tabItem { Label("同步预览", systemImage: "arrow.triangle.2.circlepath") }
                MappingsView(model: model).tabItem { Label("对应关系", systemImage: "link") }
                ConnectionsView(model: model).tabItem { Label("连接", systemImage: "person.crop.circle") }
            }.padding(12)
            Divider()
            HStack {
                Text(model.message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Spacer()
                Text("\(model.state.mappings.count) 组已确认对应关系").font(.caption).foregroundStyle(.secondary)
            }.padding(12)
        }
        .alert("需要处理", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了") { model.error = nil }
        } message: { Text(model.error ?? "") }
    }
}

@MainActor
struct ItemDetails: View {
    let item: MusicItem
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.title).font(.headline).textSelection(.enabled)
            Text(item.artists.joined(separator: "、")).foregroundStyle(.secondary)
            if let release = item.release {
                LabeledContent("所属发行", value: release.title)
                LabeledContent("发行日期", value: release.date?.value ?? "未提供完整日期")
            }
            if let isrc = item.isrc { LabeledContent("ISRC", value: isrc) }
            if let value = item.trackNumber { LabeledContent("曲序", value: String(value)) }
            if let url = item.url, let link = URL(string: url) { Link("打开平台页面", destination: link) }
            Text(item.platform.label).font(.caption).foregroundStyle(.secondary)
        }
    }
}

@MainActor
struct LibraryView: View {
    @ObservedObject var model: AppModel
    @State private var platform = MusicPlatform.spotify
    @State private var kind = CollectionKind.track
    @State private var selectedKey: String?
    @State private var destination = MusicPlatform.appleMusic
    @State private var candidates: [MusicItem] = []
    @State private var searching = false
    @State private var review: MusicItem?
    @State private var query = ""
    private var items: [MusicItem] {
        let snapshot = model.snapshots.first { $0.platform == platform && $0.kind == kind }
        return (snapshot?.items ?? []).filter {
            snapshot?.savedIDs.contains($0.id) == true && (query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.artists.joined().localizedCaseInsensitiveContains(query))
        }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }
    private var selected: MusicItem? { items.first { $0.key == selectedKey } }
    var body: some View {
        HSplitView {
            VStack(alignment: .leading) {
                Picker("平台", selection: $platform) { ForEach(MusicPlatform.allCases, id: \.self) { Text($0.label).tag($0) } }.labelsHidden()
                Picker("收藏类型", selection: $kind) { ForEach(CollectionKind.allCases, id: \.self) { Text($0.label).tag($0) } }.labelsHidden()
                TextField("搜索已扫描收藏", text: $query).textFieldStyle(.roundedBorder)
                if items.isEmpty {
                    ContentUnavailableView("暂无扫描结果", systemImage: "music.note", description: Text("先在“连接”中配置账户，再点击“扫描收藏”。"))
                } else {
                    List(selection: $selectedKey) {
                        ForEach(items, id: \.key) { item in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.title).lineLimit(1)
                                Text(item.release?.title ?? item.artists.joined(separator: "、")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }.padding(.vertical, 4).tag(item.key)
                        }
                    }
                }
            }.padding(12).frame(minWidth: 270, idealWidth: 340, maxWidth: 420)
            ScrollView {
                if let selected {
                    VStack(alignment: .leading, spacing: 20) {
                        ItemDetails(item: selected)
                        Divider()
                        HStack {
                            Text("查找对应版本").font(.headline)
                            Spacer()
                            Picker("目标平台", selection: $destination) {
                                ForEach(MusicPlatform.allCases.filter { $0 != selected.platform }, id: \.self) { Text($0.label).tag($0) }
                            }.labelsHidden().frame(width: 150)
                            Button("查找") { search(selected) }.disabled(searching || model.busy)
                        }
                        if searching { ProgressView("正在查找…") }
                        if destination == .appleMusic {
                            Text("Apple Music 查找范围为本机资料库。缺少的版本请先在 Music.app 中加入资料库；艺人收藏暂需在音乐 App 中管理。")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        ForEach(candidates, id: \.key) { candidate in
                            let assessment = StrictMatcher().assess(selected, candidate)
                            VStack(alignment: .leading, spacing: 10) {
                                ItemDetails(item: candidate)
                                Text(assessment.evidence.joined(separator: "；")).font(.callout).foregroundStyle(assessment.decision == .different ? Color.red : Color.secondary)
                                Button("核实对应关系") { review = candidate }.disabled(assessment.decision == .different || model.busy)
                            }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
                        }
                    }.padding(22)
                } else {
                    ContentUnavailableView("选择一项收藏", systemImage: "link", description: Text("核对所属专辑与完整发行日期，再确认跨平台对应关系。"))
                        .frame(maxWidth: .infinity, minHeight: 380)
                }
            }.frame(minWidth: 480)
        }
        .onChange(of: selectedKey) { _, _ in
            candidates = []; review = nil
            if destination == selected?.platform { destination = MusicPlatform.allCases.first { $0 != selected?.platform } ?? .spotify }
        }
        .onChange(of: platform) { _, _ in selectedKey = nil; candidates = [] }
        .onChange(of: kind) { _, _ in selectedKey = nil; candidates = [] }
        .onChange(of: destination) { _, _ in candidates = [] }
        .sheet(item: $review) { target in
            if let selected { MappingReview(model: model, source: selected, target: target) }
        }
    }
    private func search(_ item: MusicItem) {
        searching = true; candidates = []
        let target = destination
        Task {
            defer { searching = false }
            do {
                let result = try await model.candidates(for: item, platform: target)
                if selectedKey == item.key && destination == target { candidates = result }
                if result.isEmpty { model.message = "未找到对应版本，请保留原收藏并核实目标平台曲库。" }
            } catch { model.error = error.localizedDescription }
        }
    }
}

@MainActor
struct MappingReview: View {
    @ObservedObject var model: AppModel
    let source: MusicItem
    let target: MusicItem
    @State private var sourceDate: String
    @State private var targetDate: String
    @State private var evidence = ""
    @State private var confirmed = false
    @Environment(\.dismiss) private var dismiss
    init(model: AppModel, source: MusicItem, target: MusicItem) {
        self.model = model; self.source = source; self.target = target
        _sourceDate = State(initialValue: source.release?.date?.value ?? "")
        _targetDate = State(initialValue: target.release?.date?.value ?? "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("确认对应版本").font(.title2.bold())
            HStack(alignment: .top, spacing: 28) { ItemDetails(item: source); Divider(); ItemDetails(item: target) }.fixedSize(horizontal: false, vertical: true)
            if source.kind != .artist {
                Text("完整日期是必要条件。缺失时，请查看专辑详情或发行方资料后填写，并记录来源。").font(.callout).foregroundStyle(.secondary)
                TextField("\(source.platform.label) 已核实发行日期（YYYY-MM-DD）", text: $sourceDate).disabled(source.release?.date?.isExact == true)
                TextField("\(target.platform.label) 已核实发行日期（YYYY-MM-DD）", text: $targetDate).disabled(target.release?.date?.isExact == true)
            }
            TextField("核实依据或来源链接", text: $evidence, axis: .vertical).lineLimit(3...5)
            Toggle(source.kind == .artist ? "已核实为同一艺人，排除了同名情况" : "已核实为同一发行版本中的同一曲目，且发行年月日一致", isOn: $confirmed)
            HStack {
                Spacer(); Button("取消") { dismiss() }
                Button("保存对应关系") {
                    do {
                        var a = source, b = target
                        if source.kind != .artist {
                            guard ReleaseDate(sourceDate).isExact, sourceDate == targetDate else { throw MSyncError.invalid("请填写一致且真实的完整发行日期") }
                            a.release?.date = ReleaseDate(sourceDate); b.release?.date = ReleaseDate(targetDate)
                        }
                        try model.addMapping(source: a, target: b, evidence: evidence); dismiss()
                    } catch { model.error = error.localizedDescription }
                }.buttonStyle(.borderedProminent).disabled(!confirmed || evidence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 680)
    }
}

@MainActor
struct PreviewView: View {
    @ObservedObject var model: AppModel
    @State private var confirmApply = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let plan = model.plan {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("\(plan.operations.count) 项操作等待执行").font(.title3.bold())
                        Text("执行前会重新读取相关收藏；预览后状态变化时，需要重新扫描。").font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(plan.operations.isEmpty ? "记录本次基线" : "执行本次同步") { confirmApply = true }
                        .buttonStyle(.borderedProminent).disabled(model.busy)
                }
                List {
                    ForEach(plan.observations, id: \.key) { snapshot in
                        if !snapshot.notes.isEmpty {
                            Section("\(snapshot.platform.label) · \(snapshot.kind.label)") {
                                ForEach(snapshot.notes, id: \.self) { Text($0).font(.callout).foregroundStyle(.secondary) }
                            }
                        }
                    }
                    Section("待同步") {
                        if plan.operations.isEmpty { Text("当前没有需要修改的已确认条目。").foregroundStyle(.secondary) }
                        ForEach(plan.operations) { operation in
                            HStack {
                                Image(systemName: operation.saved ? "heart.fill" : "heart.slash").foregroundStyle(operation.saved ? .green : .red)
                                VStack(alignment: .leading) {
                                    Text(operation.item.title)
                                    Text("\(operation.item.platform.label) · \(operation.item.kind.label) · \(operation.reason)").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(); Text(operation.saved ? "添加收藏" : "取消收藏")
                            }.padding(.vertical, 4)
                        }
                    }
                    if !plan.issues.isEmpty { Section("待处理") { ForEach(plan.issues) { Text($0.message).textSelection(.enabled) } } }
                }
            } else { ContentUnavailableView("先扫描收藏", systemImage: "arrow.triangle.2.circlepath", description: Text("扫描完成后，在这里查看将要添加或取消的收藏。")) }
        }.padding(16)
        .confirmationDialog("执行已预览的同步操作？", isPresented: $confirmApply, titleVisibility: .visible) {
            Button("执行同步") { Task { await model.apply() } }
        } message: { Text("取消收藏会传播到对应平台。未确认版本、未知状态和不支持的操作会保留待处理。") }
    }
}

@MainActor
struct MappingsView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        List {
            Section("已核实的跨平台对应关系") {
                if model.state.mappings.isEmpty { Text("从“收藏”中选择条目并查找对应版本。").foregroundStyle(.secondary) }
                ForEach(model.state.mappings) { mapping in
                    VStack(alignment: .leading, spacing: 9) {
                        HStack {
                            Text(mapping.title).font(.headline); Spacer()
                            Text(mapping.items.map { $0.platform.label }.joined(separator: " ↔ ")).font(.caption).foregroundStyle(.secondary)
                            Button("移除对应关系") { model.removeMapping(mapping.id) }.disabled(model.busy)
                        }
                        Text(mapping.evidence).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    }.padding(.vertical, 8)
                }
            }
            Section("最近操作") {
                ForEach(model.state.audit.reversed()) { entry in
                    HStack { Text(entry.message); Spacer(); Text(entry.time, style: .time).foregroundStyle(.secondary) }
                }
            }
        }.padding(16)
    }
}

@MainActor
struct ConnectionsView: View {
    @ObservedObject var model: AppModel
    @State private var confirmReset = false
    var body: some View {
        Form {
            Section("Spotify") {
                TextField("Client ID", text: $model.clientID)
                Text("在 Spotify Developer Dashboard 创建自己的应用，将回调地址配置为 \(SpotifyAuthorization.redirectURI)。").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                HStack {
                    Button(model.spotifyConnected ? "重新授权" : "连接 Spotify") { Task { await model.connectSpotify() } }.disabled(model.busy)
                    if model.spotifyConnected { Label("已连接", systemImage: "checkmark.circle.fill").foregroundStyle(.green); Button("断开连接") { model.disconnect(.spotify) }.disabled(model.busy) }
                    if model.busy { Button("取消授权等待") { model.cancelSpotifyLogin() } }
                }
            }
            Section("Apple Music") {
                Toggle("启用本机 Music.app 接入", isOn: $model.appleEnabled)
                Text("无需付费开发者会员。请先打开 Music.app 并完成资料库同步；首次扫描时允许 MSync 控制 Music。歌曲与专辑按喜爱星标同步。")
                    .font(.callout).foregroundStyle(.secondary)
                Text("艺人喜爱列表与资料库外曲目暂需人工处理；更换 Apple 账户或资料库后应重新建立基线。").font(.callout).foregroundStyle(.secondary)
                Button("打开音乐 App") { NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Music.app")) }
            }
            Section("网易云音乐") {
                TextField("Node 可执行文件路径", text: $model.nodePath)
                TextField("Companion/dist/bridge.js 路径", text: $model.companionPath)
                HStack {
                    Button("生成登录二维码") { Task { await model.startNeteaseLogin() } }.disabled(model.busy)
                    if model.qrKey != nil { Button("检查登录") { Task { await model.checkNeteaseLogin() } }.disabled(model.busy) }
                    if model.neteaseConnected { Label("已连接", systemImage: "checkmark.circle.fill").foregroundStyle(.green); Button("断开连接") { model.disconnect(.netease) }.disabled(model.busy) }
                }
                if let image = model.qrImage { Image(nsImage: image).interpolation(.none).resizable().frame(width: 180, height: 180) }
                Text("使用社区维护的接口；登录凭据保存在本机钥匙串，不写入状态库和导出文件。").font(.caption).foregroundStyle(.secondary)
            }
            Section {
                Button("保存连接设置") { model.saveSettings() }.buttonStyle(.borderedProminent).disabled(model.busy)
                Button("打开本地数据目录") { NSWorkspace.shared.open(model.dataDirectory) }
                Button("重新建立同步基线", role: .destructive) { confirmReset = true }.disabled(model.busy)
            }
        }.formStyle(.grouped)
        .confirmationDialog("清除本机的对应关系与同步历史？", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("清除本地历史", role: .destructive) { model.resetLocalHistory() }
        } message: { Text("平台收藏和登录凭据保持原样。建议先用“导出记录”备份现有对应关系。") }
    }
}
#endif
