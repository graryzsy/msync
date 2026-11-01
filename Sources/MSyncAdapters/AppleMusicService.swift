import Foundation
import MSyncCore

public actor AppleMusicService: MusicService {
    public nonisolated let platform: MusicPlatform = .appleMusic
    private var libraryID: String?
    private let bridge = ProcessBridge()
    public init() {}
    private struct NativeRow: Decodable {
        var persistentID: String; var title: String; var artist: String; var album: String; var albumArtist: String
        var date: String?; var durationMS: Int?; var discNumber: Int?; var trackNumber: Int?
        var favorited: Bool?; var albumFavorited: Bool?
    }
    private struct NativeScan: Decodable { var accountID: String; var rows: [NativeRow] }
    private func invoke(_ payload: [String: Any]) async throws -> Data {
        #if os(macOS)
        guard let script = Bundle.main.url(forResource: "MusicBridge", withExtension: "js") ?? Bundle.module.url(forResource: "MusicBridge", withExtension: "js") else { throw MSyncError.unavailable("Music.app 脚本资源缺失") }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try await bridge.run(executable: "/usr/bin/osascript", arguments: ["-l", "JavaScript", script.path, String(decoding: data, as: UTF8.self)])
        #else
        throw MSyncError.unavailable("Music.app 自动化需要 macOS 15")
        #endif
    }
    public func snapshot(kind: CollectionKind) async throws -> LibrarySnapshot {
        if kind == .artist {
            throw MSyncError.unavailable("Music.app 脚本没有完整艺人喜爱列表接口；艺人收藏需人工核实，暂不自动传播")
        }
        let scan = try JSONDecoder().decode(NativeScan.self, from: await invoke(["action": "scan"]))
        libraryID = scan.accountID
        var items: [MusicItem] = [], saved = Set<String>()
        var albums: [String: (MusicItem, Bool)] = [:]
        for row in scan.rows {
            let release = Release(title: row.album, artists: [row.albumArtist], date: row.date.map(ReleaseDate.init))
            if kind == .track, let favorite = row.favorited {
                let item = MusicItem(platform: .appleMusic, kind: .track, id: row.persistentID, title: row.title, artists: [row.artist], release: release,
                                     discNumber: row.discNumber, trackNumber: row.trackNumber, durationMS: row.durationMS, nativeReference: row.persistentID)
                items.append(item); if favorite { saved.insert(item.id) }
            } else if kind == .album, let favorite = row.albumFavorited, !row.album.isEmpty {
                // Preserve the exact strings used by Music.app; no fuzzy identity or synthesized date.
                let key = [row.album, row.albumArtist, row.date ?? "unknown"].map { Data($0.utf8).base64EncodedString() }.joined(separator: ".")
                let id = "local-album:" + key
                let item = MusicItem(platform: .appleMusic, kind: .album, id: id, title: row.album, artists: [row.albumArtist], release: release, nativeReference: row.persistentID)
                if let previous = albums[id], previous.1 != favorite { throw MSyncError.transport("同一专辑的喜爱属性不一致，需在 Music.app 中核实") }
                albums[id] = (item, favorite)
            }
        }
        if kind == .album { for (id, entry) in albums { items.append(entry.0); if entry.1 { saved.insert(id) } } }
        guard !scan.rows.isEmpty || items.isEmpty else { throw MSyncError.transport("Music.app 响应无效") }
        if !scan.rows.isEmpty && items.isEmpty { throw MSyncError.unavailable("当前 Music.app 未提供所需喜爱属性；请使用 macOS 15 并检查脚本权限") }
        return .init(platform: platform, kind: kind, accountID: scan.accountID, items: items.sorted { $0.id < $1.id }, savedIDs: saved, isComplete: false,
                     notes: ["只确认资料库内可读取条目的喜爱状态；资料库外歌曲和消失条目不推断为取消收藏", "专辑收藏按专辑星标处理；更换 Apple 账户或 Music 资料库后请重新建立本地状态库"])
    }
    public func search(for item: MusicItem) async throws -> [MusicItem] {
        // Query the actual local library so matches have a writable persistent ID.
        let snapshot = try await snapshot(kind: item.kind)
        let name = StrictMatcher.normalized(item.title)
        return snapshot.items.filter { StrictMatcher.normalized($0.title).contains(name) || name.contains(StrictMatcher.normalized($0.title)) }
    }
    public func setSaved(_ saved: Bool, item: MusicItem) async throws -> WriteOutcome {
        guard item.platform == .appleMusic else { throw MSyncError.invalid("平台不一致") }
        guard item.kind != .artist, let release = item.release else {
            return .needsInteraction(message: "请在 Music.app 中打开对应发行版本并完成收藏，然后重新扫描", url: item.url)
        }
        let current = try await snapshot(kind: item.kind)
        guard let live = current.items.first(where: { $0.id == item.id }), let persistentID = live.nativeReference, let libraryID else {
            return .needsInteraction(message: "对应条目已不在本机资料库，请在 Music.app 中核实", url: item.url)
        }
        if let observed = live.release?.date, observed.isExact, let verified = release.date, observed != verified {
            throw MSyncError.invalid("Music.app 的发行日期与已核实映射不同，停止写入")
        }
        let data = try await invoke(["action": "write", "persistentID": persistentID, "kind": item.kind.rawValue, "saved": saved,
                                     "accountID": libraryID, "title": item.title, "album": release.title,
                                     "albumArtist": release.artists.first ?? "", "date": live.release?.date?.value as Any? ?? NSNull()])
        struct Result: Decodable { var applied: Bool }
        guard try JSONDecoder().decode(Result.self, from: data).applied else { throw MSyncError.transport("Music.app 未确认写入") }
        return .applied
    }
}
