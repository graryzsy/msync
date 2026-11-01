import Foundation

public struct SyncPlan: Codable, Equatable, Sendable {
    public var id: UUID
    public var baseRevision: Int
    public var createdAt: Date
    public var observations: [LibrarySnapshot]
    public var operations: [SyncOperation]
    public var issues: [ReviewIssue]
    public var desired: [String: Bool]
    public init(baseRevision: Int = 0, observations: [LibrarySnapshot], operations: [SyncOperation], issues: [ReviewIssue], desired: [String: Bool]) {
        id = UUID(); self.baseRevision = baseRevision; createdAt = Date(); self.observations = observations
        self.operations = operations; self.issues = issues; self.desired = desired
    }
}

/// Pure planning: building a preview does not advance the acknowledged baseline.
public struct SyncPlanner {
    public init() {}
    public func plan(mappings: [ItemMapping], previous: [LibrarySnapshot], current: [LibrarySnapshot],
                     desired priorDesired: [String: Bool] = [:], revision: Int = 0) -> SyncPlan {
        var operations: [SyncOperation] = [], issues: [ReviewIssue] = []
        var desired = priorDesired
        let duplicates = Dictionary(grouping: mappings.flatMap { mapping in mapping.items.map { ($0.key, mapping.id) } }, by: { $0.0 })
        let multiplyMapped = Set(duplicates.filter { $0.value.count > 1 }.keys)
        for mapping in mappings {
            guard mapping.verified, !mapping.items.isEmpty else { continue }
            guard Set(mapping.items.map(\.platform)).count == mapping.items.count,
                  mapping.items.allSatisfy({ $0.kind == mapping.kind && !multiplyMapped.contains($0.key) }) else {
                issues.append(.init(mappingID: mapping.id, message: "映射冲突：同一平台或条目存在多重对应关系")); continue
            }
            var observations: [(MusicItem, Bool)] = []
            var changes: [(MusicPlatform, Bool)] = []
            var accountMismatch = false
            for item in mapping.items {
                guard let now = current.first(where: { $0.platform == item.platform && $0.kind == item.kind }) else { continue }
                let old = previous.first(where: { $0.platform == item.platform && $0.kind == item.kind })
                if let old, old.accountID != now.accountID {
                    accountMismatch = true
                    issues.append(.init(mappingID: mapping.id, message: "\(item.platform.label) 账户或资料库已改变，需重新建立基线")); continue
                }
                guard let state = now.state(of: item.id) else {
                    issues.append(.init(mappingID: mapping.id, message: "\(item.platform.label) 未读到可靠状态，保留上次记录")); continue
                }
                observations.append((item, state))
                if let before = old?.state(of: item.id), before != state { changes.append((item.platform, state)) }
            }
            guard !accountMismatch else { continue }
            let key = mapping.id.uuidString
            let target: Bool
            if !changes.isEmpty {
                let states = Set(changes.map(\.1))
                if states.count == 1 { target = changes[0].1 }
                else if let spotify = changes.first(where: { $0.0 == .spotify }) {
                    target = spotify.1
                    issues.append(.init(mappingID: mapping.id, message: "同一窗口内出现相反操作，采用 Spotify 的主动变更"))
                } else {
                    issues.append(.init(mappingID: mapping.id, message: "Apple Music 和网易云出现相反变更，等待人工处理")); continue
                }
            } else if let pending = priorDesired[key] { target = pending }
            else if let anchor = observations.first(where: { $0.0.platform == .spotify }) { target = anchor.1 }
            else {
                issues.append(.init(mappingID: mapping.id, message: "首次初始化需读取 Spotify；其他平台独有收藏保留待处理")); continue
            }
            desired[key] = target
            for (item, state) in observations where state != target {
                operations.append(.init(mappingID: mapping.id, item: item, saved: target,
                                        reason: changes.isEmpty ? "按已记录目标对齐" : "传播平台主动变更"))
            }
        }
        return .init(baseRevision: revision, observations: current, operations: operations, issues: issues, desired: desired)
    }
}
