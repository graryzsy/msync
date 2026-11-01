import Foundation
import MSyncCore

public struct NeteaseService: MusicService {
    public let platform: MusicPlatform = .netease
    private let nodePath: String
    private let scriptPath: String
    private let cookie: String
    public init(nodePath: String, scriptPath: String, cookie: String) {
        self.nodePath = nodePath; self.scriptPath = scriptPath; self.cookie = cookie
    }
    private func invoke(_ action: String, payload: [String: Any] = [:]) async throws -> Data {
        var request = payload; request["action"] = action; request["cookie"] = cookie
        let data = try JSONSerialization.data(withJSONObject: request)
        let response = try await ProcessBridge().run(executable: nodePath, arguments: [scriptPath], input: data)
        struct Failure: Decodable { var error: String? }
        if let error = try? JSONDecoder().decode(Failure.self, from: response).error, !error.isEmpty { throw MSyncError.transport(error) }
        return response
    }
    public func snapshot(kind: CollectionKind) async throws -> LibrarySnapshot {
        try JSONCoding.decoder().decode(LibrarySnapshot.self, from: await invoke("snapshot", payload: ["kind": kind.rawValue]))
    }
    public func search(for item: MusicItem) async throws -> [MusicItem] {
        try JSONCoding.decoder().decode([MusicItem].self, from: await invoke("search", payload: ["kind": item.kind.rawValue, "query": ([item.title] + item.artists).joined(separator: " ")]))
    }
    public func setSaved(_ saved: Bool, item: MusicItem) async throws -> WriteOutcome {
        guard item.platform == platform else { throw MSyncError.invalid("平台不一致") }
        _ = try await invoke("write", payload: ["kind": item.kind.rawValue, "id": item.id, "saved": saved])
        return .applied
    }
    public static func startLogin(nodePath: String, scriptPath: String) async throws -> (key: String, image: String) {
        let data = try await ProcessBridge().run(executable: nodePath, arguments: [scriptPath], input: Data(#"{"action":"qrStart"}"#.utf8))
        struct QR: Decodable { var key: String; var image: String }
        let qr = try JSONDecoder().decode(QR.self, from: data); return (qr.key, qr.image)
    }
    public static func checkLogin(nodePath: String, scriptPath: String, key: String) async throws -> (code: Int, cookie: String?) {
        let input = try JSONSerialization.data(withJSONObject: ["action": "qrCheck", "key": key])
        let data = try await ProcessBridge().run(executable: nodePath, arguments: [scriptPath], input: input)
        struct Check: Decodable { var code: Int; var cookie: String? }
        let check = try JSONDecoder().decode(Check.self, from: data); return (check.code, check.cookie)
    }
}
