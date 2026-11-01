import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import MSyncCore

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}
public struct URLSessionTransport: HTTPTransport {
    public init() {}
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw MSyncError.transport("服务器响应无效") }
        return (data, response)
    }
}

public struct HTTPClient: Sendable {
    public let transport: any HTTPTransport
    public init(transport: any HTTPTransport = URLSessionTransport()) { self.transport = transport }
    public func request(_ url: URL, method: String = "GET", token: String? = nil,
                        body: Data? = nil, contentType: String = "application/json") async throws -> Data {
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 40
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = body
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 { throw MSyncError.transport("登录已过期，请重新连接账户") }
            if response.statusCode == 429 { throw MSyncError.transport("平台请求限流，请稍后重新扫描") }
            throw MSyncError.transport("平台请求失败（HTTP \(response.statusCode)）；本次结果不会视为取消收藏")
        }
        return data
    }
    public static func url(_ base: String, query: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(string: base) else { throw MSyncError.invalid("地址无效") }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw MSyncError.invalid("地址无效") }; return url
    }
}
