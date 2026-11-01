import Foundation
import MSyncCore

public struct SpotifyToken: Codable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date
    public init(accessToken: String, refreshToken: String, expiresAt: Date) {
        self.accessToken = accessToken; self.refreshToken = refreshToken; self.expiresAt = expiresAt
    }
}

public struct SpotifyAuthorization: Sendable {
    public static let redirectURI = "http://127.0.0.1:19428/callback"
    public let clientID: String
    public let verifier: String
    public let state: String
    public init(clientID: String, verifier: String? = nil, state: String? = nil) {
        self.clientID = clientID
        self.verifier = verifier ?? Self.randomString(length: 64)
        self.state = state ?? Self.randomString(length: 32)
    }
    private static func randomString(length: Int) -> String {
        let chars = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return String((0..<length).map { _ in chars.randomElement()! })
    }
    public var challenge: String {
        Data(SHA256.hash(Array(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public func authorizationURL() throws -> URL {
        guard !clientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MSyncError.invalid("请先填写 Spotify Client ID") }
        return try HTTPClient.url("https://accounts.spotify.com/authorize", query: [
            .init(name: "client_id", value: clientID), .init(name: "response_type", value: "code"),
            .init(name: "redirect_uri", value: Self.redirectURI), .init(name: "state", value: state),
            .init(name: "code_challenge_method", value: "S256"), .init(name: "code_challenge", value: challenge),
            .init(name: "scope", value: "user-library-read user-library-modify user-follow-read user-follow-modify")
        ])
    }
    public func code(from callback: URL) throws -> String {
        guard callback.scheme == "http", callback.host == "127.0.0.1", callback.port == 19428, callback.path == "/callback",
              let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems else {
            throw MSyncError.invalid("Spotify 回调地址无效")
        }
        let states = query.filter { $0.name == "state" }
        let codes = query.filter { $0.name == "code" }
        guard states.count == 1, states.first?.value == state else { throw MSyncError.invalid("Spotify 授权校验失败，请重新连接") }
        guard !query.contains(where: { $0.name == "error" }), codes.count == 1, let code = codes.first?.value, !code.isEmpty else {
            throw MSyncError.invalid("Spotify 授权未完成")
        }
        return code
    }
    public func exchange(callback: URL, http: HTTPClient = HTTPClient()) async throws -> SpotifyToken {
        let code = try code(from: callback)
        return try await Self.tokenRequest(fields: ["grant_type": "authorization_code", "code": code, "redirect_uri": Self.redirectURI,
                                                    "client_id": clientID, "code_verifier": verifier], oldRefresh: nil, http: http)
    }
    public static func refresh(_ token: SpotifyToken, clientID: String, http: HTTPClient) async throws -> SpotifyToken {
        try await tokenRequest(fields: ["grant_type": "refresh_token", "refresh_token": token.refreshToken, "client_id": clientID],
                               oldRefresh: token.refreshToken, http: http)
    }
    private static func tokenRequest(fields: [String: String], oldRefresh: String?, http: HTTPClient) async throws -> SpotifyToken {
        var components = URLComponents(); components.queryItems = fields.sorted(by: { $0.key < $1.key }).map { .init(name: $0.key, value: $0.value) }
        let data = try await http.request(URL(string: "https://accounts.spotify.com/api/token")!, method: "POST",
                                          body: components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8), contentType: "application/x-www-form-urlencoded")
        struct Response: Decodable { var access_token: String; var refresh_token: String?; var expires_in: Double }
        let response = try JSONDecoder().decode(Response.self, from: data)
        guard let refresh = response.refresh_token ?? oldRefresh, !refresh.isEmpty else { throw MSyncError.transport("未获得 Spotify 刷新令牌") }
        return .init(accessToken: response.access_token, refreshToken: refresh, expiresAt: Date().addingTimeInterval(response.expires_in))
    }
}

// Small dependency-free SHA-256 implementation for the standard OAuth PKCE challenge.
enum SHA256 {
    static let constants: [UInt32] = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
    static func rotate(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
    static func hash(_ input: [UInt8]) -> [UInt8] {
        var bytes = input; let length = UInt64(bytes.count) * 8; bytes.append(0x80)
        while bytes.count % 64 != 56 { bytes.append(0) }
        bytes += (0..<8).reversed().map { UInt8(truncatingIfNeeded: length >> ($0 * 8)) }
        var h: [UInt32] = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
        for offset in stride(from: 0, to: bytes.count, by: 64) {
            var w = [UInt32](repeating: 0, count: 64)
            for i in 0..<16 { for j in 0..<4 { w[i] = (w[i] << 8) | UInt32(bytes[offset + 4*i + j]) } }
            for i in 16..<64 {
                let s0 = rotate(w[i-15], 7) ^ rotate(w[i-15], 18) ^ (w[i-15] >> 3)
                let s1 = rotate(w[i-2], 17) ^ rotate(w[i-2], 19) ^ (w[i-2] >> 10)
                w[i] = w[i-16] &+ s0 &+ w[i-7] &+ s1
            }
            var a=h[0], b=h[1], c=h[2], d=h[3], e=h[4], f=h[5], g=h[6], z=h[7]
            for i in 0..<64 {
                let t1 = z &+ (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) &+ ((e & f) ^ (~e & g)) &+ constants[i] &+ w[i]
                let t2 = (rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) &+ ((a & b) ^ (a & c) ^ (b & c))
                z=g; g=f; f=e; e=d &+ t1; d=c; c=b; b=a; a=t1 &+ t2
            }
            for (i, v) in [a,b,c,d,e,f,g,z].enumerated() { h[i] = h[i] &+ v }
        }
        return h.flatMap { value in (0..<4).reversed().map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) } }
    }
}
