#if os(macOS)
import Foundation
import SwiftUI
import AppKit
import UniformTypeIdentifiers
import MSyncCore
import MSyncAdapters

@MainActor
final class AppModel: ObservableObject {
    @Published var clientID = UserDefaults.standard.string(forKey: "spotifyClientID") ?? ""
    @Published var appleEnabled = UserDefaults.standard.bool(forKey: "appleEnabled")
    @Published var nodePath = UserDefaults.standard.string(forKey: "nodePath") ?? Self.defaultNodePath
    @Published var companionPath = UserDefaults.standard.string(forKey: "companionPath") ?? Self.defaultCompanionPath
    @Published var busy = false
    @Published var message = "连接账户后，扫描收藏并确认对应版本。"
    @Published var error: String?
    @Published var plan: SyncPlan?
    @Published var state = StoredState()
    @Published var spotifyConnected = false
    @Published var neteaseConnected = false
    @Published var qrImage: NSImage?
    @Published var qrKey: String?
    @Published var snapshots: [LibrarySnapshot] = []
    let store: SyncStore
    let coordinator: SyncCoordinator
    private let login = SpotifyLogin()
    private var services: [any MusicService] = []
    let dataDirectory: URL
    static var defaultNodePath: String {
        let embedded = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node").path
        return [embedded, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) ?? "/opt/homebrew/bin/node"
    }
    static var defaultCompanionPath: String {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("Companion/dist/bridge.js").path ?? ""
        if FileManager.default.fileExists(atPath: packaged) { return packaged }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("Companion/dist/bridge.js").path
    }
    init() throws {
        dataDirectory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("MSync", isDirectory: true)
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        store = try SyncStore(path: dataDirectory.appendingPathComponent("state.sqlite").path)
        coordinator = SyncCoordinator(store: store)
        state = try store.load()
        spotifyConnected = try Credentials.read("spotify") != nil
        neteaseConnected = try Credentials.read("netease") != nil
    }
    func saveSettings() {
        UserDefaults.standard.set(clientID.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "spotifyClientID")
        UserDefaults.standard.set(appleEnabled, forKey: "appleEnabled")
        UserDefaults.standard.set(nodePath, forKey: "nodePath"); UserDefaults.standard.set(companionPath, forKey: "companionPath")
        plan = nil
        message = "设置已保存；请重新扫描。"
    }
    func connectSpotify() async {
        await perform {
            let token = try await self.login.authorize(clientID: self.clientID.trimmingCharacters(in: .whitespacesAndNewlines))
            try Credentials.save(JSONCoding.encoder().encode(token), account: "spotify")
            self.spotifyConnected = true; self.saveSettings(); self.message = "Spotify 已连接。"
        }
    }
    func cancelSpotifyLogin() { login.cancel() }
    func startNeteaseLogin() async {
        await perform {
            let qr = try await NeteaseService.startLogin(nodePath: self.nodePath, scriptPath: self.companionPath)
            guard let comma = qr.image.firstIndex(of: ","), let data = Data(base64Encoded: String(qr.image[qr.image.index(after: comma)...])), let image = NSImage(data: data) else {
                throw MSyncError.transport("二维码响应无效，请检查辅助模块")
            }
            self.qrImage = image; self.qrKey = qr.key; self.message = "使用网易云音乐 App 扫码，然后点击检查登录。"
        }
    }
    func checkNeteaseLogin() async {
        guard let qrKey else { return }
        await perform {
            let result = try await NeteaseService.checkLogin(nodePath: self.nodePath, scriptPath: self.companionPath, key: qrKey)
            switch result.code {
            case 803:
                guard let cookie = result.cookie, !cookie.isEmpty else { throw MSyncError.transport("登录凭据缺失") }
                try Credentials.save(Data(cookie.utf8), account: "netease")
                self.neteaseConnected = true; self.qrImage = nil; self.qrKey = nil; self.plan = nil
                self.message = "网易云已连接。"
            case 800: self.qrImage = nil; self.qrKey = nil; self.message = "二维码已过期，请重新生成。"
            case 802: self.message = "请在网易云 App 中确认登录。"
            default: self.message = "等待扫码。"
            }
        }
    }
    private func configuredServices() throws -> [any MusicService] {
        var result: [any MusicService] = []
        if let data = try Credentials.read("spotify") {
            let token = try JSONCoding.decoder().decode(SpotifyToken.self, from: data)
            result.append(SpotifyService(clientID: clientID, token: token, persist: { token in
                try Credentials.save(JSONCoding.encoder().encode(token), account: "spotify")
            }))
        }
        if appleEnabled { result.append(AppleMusicService()) }
        if let data = try Credentials.read("netease"), let cookie = String(data: data, encoding: .utf8) {
            guard FileManager.default.isExecutableFile(atPath: nodePath), FileManager.default.fileExists(atPath: companionPath) else {
                throw MSyncError.invalid("网易云辅助模块路径无效，请先构建 Companion 并检查 Node 路径")
            }
            result.append(NeteaseService(nodePath: nodePath, scriptPath: companionPath, cookie: cookie))
        }
        guard !result.isEmpty else { throw MSyncError.invalid("请先连接至少一个账户") }; return result
    }
    func scan() async {
        await perform {
            self.plan = nil
            self.services = try self.configuredServices()
            let plan = try await self.coordinator.preview(services: self.services)
            self.plan = plan; self.snapshots = plan.observations
            self.message = "扫描完成：\(plan.operations.count) 项待同步，\(plan.issues.count) 项需留意。首次扫描不会修改收藏。"
        }
    }
    func apply() async {
        guard let plan else { return }
        await perform {
            self.plan = nil
            let report = try await self.coordinator.apply(plan, services: self.services)
            self.state = try self.store.load()
            self.message = "完成 \(report.applied) 项同步。\(report.pending.isEmpty ? "" : "另有 \(report.pending.count) 项待处理。")"
            if !report.pending.isEmpty { self.error = report.pending.joined(separator: "\n") }
        }
    }
    func candidates(for item: MusicItem, platform: MusicPlatform) async throws -> [MusicItem] {
        let configured = try configuredServices()
        guard let service = configured.first(where: { $0.platform == platform }) else { throw MSyncError.invalid("请先连接 \(platform.label)") }
        return try await service.search(for: item)
    }
    func addMapping(source: MusicItem, target: MusicItem, evidence: String) throws {
        let mapping = ItemMapping(kind: source.kind, items: [source, target], verified: true, evidence: evidence)
        try store.addMapping(mapping); state = try store.load(); plan = nil
        message = "已确认对应关系；重新扫描可查看同步预览。"
    }
    func removeMapping(_ id: UUID) {
        do { try store.removeMapping(id: id); state = try store.load(); plan = nil } catch { self.error = error.localizedDescription }
    }
    func exportState() {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "msync-backup.json"; panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try JSONCoding.encoder().encode(store.load()).write(to: url, options: .atomic); message = "已导出本地状态，不包含登录凭据。" }
        catch { self.error = error.localizedDescription }
    }
    func disconnect(_ platform: MusicPlatform) {
        do {
            try Credentials.remove(platform == .spotify ? "spotify" : "netease")
            if platform == .spotify { spotifyConnected = false } else { neteaseConnected = false }
            services = []; plan = nil; message = "已移除本机登录凭据；对应关系和平台收藏保持原样。"
        } catch { self.error = error.localizedDescription }
    }
    func resetLocalHistory() {
        do {
            try store.resetLocalHistory(); state = try store.load(); plan = nil; snapshots = []; services = []
            message = "本地历史已重置，请重新扫描并确认对应版本。"
        } catch { self.error = error.localizedDescription }
    }
    private func perform(_ work: () async throws -> Void) async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do { try await work() } catch { self.error = error.localizedDescription }
    }
}
#endif
