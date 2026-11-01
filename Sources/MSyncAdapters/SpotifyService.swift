import Foundation
import MSyncCore

public actor SpotifyService: MusicService {
    public nonisolated let platform: MusicPlatform = .spotify
    private var token: SpotifyToken
    private let clientID: String
    private let http: HTTPClient
    private let persist: @Sendable (SpotifyToken) throws -> Void
    public init(clientID: String, token: SpotifyToken, http: HTTPClient = HTTPClient(),
                persist: @escaping @Sendable (SpotifyToken) throws -> Void = { _ in }) {
        self.clientID = clientID; self.token = token; self.http = http; self.persist = persist
    }
    private func request(_ url: URL, method: String = "GET", body: Data? = nil) async throws -> Data {
        guard url.scheme == "https", url.host == "api.spotify.com", url.path.hasPrefix("/v1/") else { throw MSyncError.invalid("Spotify 返回了非预期分页地址") }
        if token.expiresAt.timeIntervalSinceNow < 60 {
            let refreshed = try await SpotifyAuthorization.refresh(token, clientID: clientID, http: http)
            try persist(refreshed); token = refreshed
        }
        return try await http.request(url, method: method, token: token.accessToken, body: body)
    }
    private func account() async throws -> String {
        struct User: Decodable { var account_id: String?; var id: String }
        let data = try await request(URL(string: "https://api.spotify.com/v1/me")!)
        let user = try JSONDecoder().decode(User.self, from: data); return user.account_id ?? user.id
    }
    public func snapshot(kind: CollectionKind) async throws -> LibrarySnapshot {
        let accountID = try await account()
        let endpoint: String
        switch kind { case .track: endpoint = "me/tracks"; case .album: endpoint = "me/albums"; case .artist: endpoint = "me/following?type=artist" }
        var next: URL? = URL(string: "https://api.spotify.com/v1/\(endpoint)\(kind == .artist ? "&" : "?")limit=50")
        var items: [MusicItem] = [], visited = Set<String>(), expectedTotal: Int?
        while let url = next {
            guard visited.insert(url.absoluteString).inserted else { throw MSyncError.transport("Spotify 分页异常") }
            let data = try await request(url)
            guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MSyncError.transport("Spotify 收藏响应无效") }
            if kind == .artist {
                guard let nested = object["artists"] as? [String: Any] else { throw MSyncError.transport("Spotify 艺人响应无效") }; object = nested
            }
            guard let rows = object["items"] as? [[String: Any]] else { throw MSyncError.transport("Spotify 收藏列表缺失") }
            if expectedTotal == nil { expectedTotal = object["total"] as? Int }
            for row in rows {
                let entity: [String: Any]
                if kind == .artist { entity = row }
                else {
                    guard let nested = row[kind.rawValue] as? [String: Any] else { throw MSyncError.transport("Spotify 有无法解析的收藏，扫描中止") }
                    entity = nested
                }
                items.append(try Self.item(entity, kind: kind))
            }
            next = (object["next"] as? String).flatMap(URL.init(string:))
        }
        let ids = Set(items.map(\.id))
        guard ids.count == items.count, expectedTotal == nil || items.count == expectedTotal else { throw MSyncError.transport("扫描期间 Spotify 列表变化，请重新扫描") }
        return .init(platform: platform, kind: kind, accountID: accountID, items: items, savedIDs: ids, isComplete: true)
    }
    public func search(for item: MusicItem) async throws -> [MusicItem] {
        let query = ([item.title] + item.artists + [item.release?.title].compactMap { $0 }).joined(separator: " ")
        let url = try HTTPClient.url("https://api.spotify.com/v1/search", query: [.init(name: "q", value: query), .init(name: "type", value: item.kind.rawValue), .init(name: "limit", value: "10")])
        let data = try await request(url)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let bucket = object?[item.kind.rawValue + "s"] as? [String: Any]
        guard let rows = bucket?["items"] as? [[String: Any]] else { throw MSyncError.transport("Spotify 搜索响应无效") }
        var results: [MusicItem] = []
        for row in rows {
            if item.kind == .album, let id = row["id"] as? String {
                let full = try await request(URL(string: "https://api.spotify.com/v1/albums/\(id)")!)
                guard let entity = try JSONSerialization.jsonObject(with: full) as? [String: Any] else { throw MSyncError.transport("Spotify 专辑响应无效") }
                results.append(try Self.item(entity, kind: .album))
            } else { results.append(try Self.item(row, kind: item.kind)) }
        }
        return results
    }
    public func setSaved(_ saved: Bool, item: MusicItem) async throws -> WriteOutcome {
        guard item.platform == platform, item.id.range(of: "^[A-Za-z0-9]+$", options: .regularExpression) != nil else { throw MSyncError.invalid("Spotify 条目 ID 无效") }
        // Generic library endpoints use the uris query parameter (not the legacy ids body).
        let uri = "spotify:\(item.kind.rawValue):\(item.id)"
        let url = try HTTPClient.url("https://api.spotify.com/v1/me/library", query: [.init(name: "uris", value: uri)])
        _ = try await request(url, method: saved ? "PUT" : "DELETE")
        return .applied
    }
    public static func item(_ object: [String: Any], kind: CollectionKind) throws -> MusicItem {
        guard let id = object["id"] as? String, !id.isEmpty, let name = object["name"] as? String else { throw MSyncError.transport("Spotify 元数据缺失") }
        let artists = (object["artists"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
        let album = kind == .album ? object : object["album"] as? [String: Any]
        let release: Release? = album.map {
            .init(title: $0["name"] as? String ?? "", artists: ($0["artists"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? [],
                  date: ($0["release_date"] as? String).map(ReleaseDate.init), barcode: ($0["external_ids"] as? [String: Any])?["upc"] as? String)
        }
        return .init(platform: .spotify, kind: kind, id: id, title: name, artists: kind == .artist ? [name] : artists, release: release,
                     isrc: (object["external_ids"] as? [String: Any])?["isrc"] as? String,
                     discNumber: object["disc_number"] as? Int, trackNumber: object["track_number"] as? Int,
                     durationMS: object["duration_ms"] as? Int, url: (object["external_urls"] as? [String: Any])?["spotify"] as? String)
    }
}
