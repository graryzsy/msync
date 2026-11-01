#if os(macOS)
import SwiftUI
import AppKit

@main
@MainActor
struct MSyncApp: App {
    private let model: AppModel?
    private let startupError: String?
    init() {
        do { model = try AppModel(); startupError = nil }
        catch { model = nil; startupError = error.localizedDescription }
    }
    var body: some Scene {
        WindowGroup("MSync") {
            if let model { ContentView(model: model).frame(minWidth: 940, minHeight: 640) }
            else { ContentUnavailableView("无法打开本地状态库", systemImage: "externaldrive.badge.exclamationmark", description: Text(startupError ?? "请检查应用数据目录权限")) }
        }
        .defaultSize(width: 1120, height: 760)
        MenuBarExtra("MSync", systemImage: "arrow.triangle.2.circlepath") {
            if let model {
                Button("显示 MSync") { NSApp.activate(ignoringOtherApps: true); NSApp.windows.first?.makeKeyAndOrderFront(nil) }
                Button("扫描收藏") { Task { await model.scan() } }.disabled(model.busy)
            } else { Text("本地状态库不可用") }
            Divider()
            Button("退出") { NSApp.terminate(nil) }
        }
    }
}
#else
import Foundation
@main
enum MSyncApp {
    static func main() {
        print("MSync 桌面界面需要 macOS 15。可在 Linux 上运行 swift test 或 swift run msync demo 验证同步核心。")
    }
}
#endif
