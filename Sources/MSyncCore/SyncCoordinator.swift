import Foundation

public struct ApplyReport: Sendable {
    public var applied: Int = 0
    public var pending: [String] = []
    public init() {}
}

public actor SyncCoordinator {
    private let store: SyncStore
    private var running = false
    public init(store: SyncStore) { self.store = store }

    public func preview(services: [any MusicService]) async throws -> SyncPlan {
        guard !running else { throw MSyncError.invalid("已有同步任务正在执行") }
        running = true; defer { running = false }
        let state = try store.load()
        var snapshots: [LibrarySnapshot] = [], failures: [ReviewIssue] = []
        for service in services {
            for kind in CollectionKind.allCases {
                do { snapshots.append(try await service.snapshot(kind: kind)) }
                catch { failures.append(.init(message: "\(service.platform.label) · \(kind.label)：\(error.localizedDescription)")) }
            }
        }
        var plan = SyncPlanner().plan(mappings: state.mappings, previous: state.snapshots,
                                      current: snapshots, desired: state.desired, revision: state.revision)
        plan.issues += failures
        return plan
    }

    public func apply(_ plan: SyncPlan, services: [any MusicService]) async throws -> ApplyReport {
        guard !running else { throw MSyncError.invalid("已有同步任务正在执行") }
        running = true; defer { running = false }
        // Verify every observed mapping state before starting. Never apply an old preview blindly.
        let state = try store.load()
        guard state.revision == plan.baseRevision else { throw MSyncError.invalid("预览已过期，请重新扫描") }
        for observed in plan.observations {
            guard let service = services.first(where: { $0.platform == observed.platform }) else { throw MSyncError.invalid("连接配置已改变") }
            let fresh = try await service.snapshot(kind: observed.kind)
            guard fresh.accountID == observed.accountID else { throw MSyncError.invalid("账户已改变，请重新扫描") }
            let ids = Set(state.mappings.flatMap(\.items).filter { $0.platform == fresh.platform && $0.kind == fresh.kind }.map(\.id))
            guard ids.allSatisfy({ observed.state(of: $0) == fresh.state(of: $0) }) else {
                throw MSyncError.invalid("预览后收藏状态已改变，请重新扫描")
            }
        }
        try store.begin(plan)
        var report = ApplyReport()
        for operation in plan.operations {
            guard let service = services.first(where: { $0.platform == operation.item.platform }) else { continue }
            do {
                let fresh = try await service.snapshot(kind: operation.item.kind)
                guard let original = plan.observations.first(where: { $0.platform == fresh.platform && $0.kind == fresh.kind }),
                      original.accountID == fresh.accountID else { throw MSyncError.invalid("账户已改变，停止写入") }
                if fresh.state(of: operation.item.id) != operation.saved {
                    guard fresh.state(of: operation.item.id) == original.state(of: operation.item.id) else {
                        throw MSyncError.invalid("条目状态在执行期间变化，保留待处理")
                    }
                    switch try await service.setSaved(operation.saved, item: operation.item) {
                    case .applied: break
                    case .needsInteraction(let message, _):
                        report.pending.append("\(operation.item.title)：\(message)"); continue
                    }
                }
                let confirmation = try await service.snapshot(kind: operation.item.kind)
                try store.acknowledge(operation, planID: plan.id, snapshot: confirmation)
                report.applied += 1
            } catch { report.pending.append("\(operation.item.platform.label) · \(operation.item.title)：\(error.localizedDescription)") }
        }
        return report
    }
}
