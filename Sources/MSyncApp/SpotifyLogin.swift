#if os(macOS)
import Foundation
import Network
import AppKit
import MSyncCore
import MSyncAdapters

@MainActor
final class SpotifyLogin {
    private var listener: NWListener?
    private var continuation: CheckedContinuation<URL, Error>?
    private var timeout: Task<Void, Never>?
    func authorize(clientID: String) async throws -> SpotifyToken {
        let authorization = SpotifyAuthorization(clientID: clientID)
        let url = try authorization.authorizationURL()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 19428)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    switch state {
                    case .ready:
                        if !NSWorkspace.shared.open(url) { self?.finish(.failure(MSyncError.unavailable("无法打开浏览器"))) }
                    case .failed: self?.finish(.failure(MSyncError.unavailable("无法启动本地授权回调，请检查端口 19428")))
                    default: break
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                connection.start(queue: .main)
                connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, _, _ in
                    Task { @MainActor in
                        guard let self, let data, let request = String(data: data, encoding: .utf8),
                              let firstLine = request.components(separatedBy: "\r\n").first else { connection.cancel(); return }
                        let pieces = firstLine.split(separator: " ")
                        guard pieces.count == 3, pieces[0] == "GET", pieces[1].hasPrefix("/callback?"),
                              let callback = URL(string: "http://127.0.0.1:19428\(pieces[1])") else { connection.cancel(); return }
                        do {
                            _ = try authorization.code(from: callback)
                            let body = "授权完成，可以返回 MSync。"
                            let message = "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                            connection.send(content: Data(message.utf8), completion: .contentProcessed { _ in connection.cancel() })
                            self.finish(.success(callback))
                        } catch { connection.cancel() /* Ignore unsolicited or invalid-state requests. */ }
                    }
                }
            }
            listener.start(queue: .main)
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(300)); self?.finish(.failure(MSyncError.unavailable("授权等待超时，请重试"))) } catch {}
            }
        }
        return try await authorization.exchange(callback: callback)
    }
    func cancel() { finish(.failure(MSyncError.unavailable("已取消授权"))) }
    private func finish(_ result: Result<URL, Error>) {
        guard let continuation else { return }
        self.continuation = nil; timeout?.cancel(); timeout = nil; listener?.cancel(); listener = nil
        continuation.resume(with: result)
    }
}
#endif
