import Foundation
import MSyncCore

struct PlanInput: Codable { var mappings: [ItemMapping]; var snapshots: [LibrarySnapshot] }

func demo() throws {
    let release = Release(title: "示例原专辑", artists: ["示例艺人"], date: ReleaseDate("2024-05-17"))
    let items = MusicPlatform.allCases.map { MusicItem(platform: $0, kind: .track, id: $0.rawValue + "-track", title: "示例歌曲", artists: ["示例艺人"], release: release, isrc: "EXAMPLE00001") }
    let mapping = ItemMapping(kind: .track, items: items, verified: true, evidence: "离线示例：同一发行版本与完整发行日期")
    let previous = items.map { LibrarySnapshot(platform: $0.platform, kind: .track, accountID: "demo-\($0.platform.rawValue)", items: [$0], savedIDs: [$0.id], isComplete: true) }
    var current = previous
    current[1].savedIDs = [] // User unfavorited on Apple Music.
    let plan = SyncPlanner().plan(mappings: [mapping], previous: previous, current: current)
    print("离线示例：Apple Music 取消喜爱后，生成 Spotify 和网易云的取消收藏操作。")
    print("操作数：\(plan.operations.count)；真实平台写入数：0")
    print(String(decoding: try JSONCoding.encoder().encode(plan), as: UTF8.self))
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    switch args.first {
    case "demo": try demo()
    case "plan":
        guard args.count == 2 || args.count == 3 else { throw MSyncError.invalid("用法：msync plan input.json [state.sqlite]") }
        let input = try JSONCoding.decoder().decode(PlanInput.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
        let state = args.count == 3 ? try SyncStore(path: args[2]).load() : StoredState()
        let plan = SyncPlanner().plan(mappings: input.mappings, previous: state.snapshots, current: input.snapshots, desired: state.desired, revision: state.revision)
        print(String(decoding: try JSONCoding.encoder().encode(plan), as: UTF8.self))
    case "inspect":
        guard args.count == 2 else { throw MSyncError.invalid("用法：msync inspect state.sqlite") }
        let state = try SyncStore(path: args[1]).load()
        print(String(decoding: try JSONCoding.encoder().encode(state), as: UTF8.self))
    default:
        print("""
        MSync — 收藏同步核心工具
          msync demo                         运行离线删除传播示例
          msync plan input.json [state.sqlite] 生成离线预览，不修改任何平台
          msync inspect state.sqlite          查看本地状态，不含登录凭据
        macOS 桌面界面：swift run MSync
        """)
    }
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
