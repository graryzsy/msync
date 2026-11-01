import Foundation
import MSyncCore

public struct ProcessBridge: Sendable {
    public init() {}
    public func run(executable: String, arguments: [String], input: Data? = nil) async throws -> Data {
        try await Task.detached(priority: .utility) {
            let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
            let output = Pipe(), errors = Pipe(), stdin = Pipe()
            process.standardOutput = output; process.standardError = errors; process.standardInput = stdin
            // Drain stderr independently to prevent pipe-buffer deadlock; never echo third-party logs/secrets.
            try process.run()
            let errorDrain = Task.detached { errors.fileHandleForReading.readDataToEndOfFile() }
            let timeout = Task.detached {
                try? await Task.sleep(nanoseconds: 120_000_000_000)
                if !Task.isCancelled && process.isRunning { process.terminate() }
            }
            if let input { try stdin.fileHandleForWriting.write(contentsOf: input) }
            try stdin.fileHandleForWriting.close()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit(); timeout.cancel(); _ = await errorDrain.value
            guard process.terminationStatus == 0 else { throw MSyncError.unavailable("辅助进程未完成，请检查连接设置或在音乐 App 中完成操作") }
            guard data.count <= 64 * 1_024 * 1_024 else { throw MSyncError.transport("辅助进程返回数据过大") }
            return data
        }.value
    }
}
