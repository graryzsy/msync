import Foundation
import CSQLite

public struct AuditEntry: Codable, Identifiable, Sendable {
    public var id = UUID()
    public var time = Date()
    public var message: String
    public init(_ message: String) { self.message = message }
}

public struct StoredState: Codable, Sendable {
    public var revision = 0
    public var mappings: [ItemMapping] = []
    public var snapshots: [LibrarySnapshot] = []
    public var desired: [String: Bool] = [:]
    public var audit: [AuditEntry] = []
    public var activePlanID: UUID?
    public var outstanding: [SyncOperation] = []
    public init() {}
}

/// One transactional state document keeps mappings, baselines and tombstones consistent.
public final class SyncStore: @unchecked Sendable {
    private var db: OpaquePointer?
    private let lock = NSRecursiveLock()
    public init(path: String) throws {
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            if let db { sqlite3_close(db) }; db = nil
            throw MSyncError.storage("无法打开本地状态库")
        }
        do {
            try execute("PRAGMA journal_mode=WAL;")
            try execute("PRAGMA synchronous=FULL;")
            try execute("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL);")
        } catch { sqlite3_close(db); db = nil; throw error }
    }
    deinit { sqlite3_close(db) }
    private func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw MSyncError.storage("本地数据库操作失败") }
    }
    public func load() throws -> StoredState {
        lock.lock(); defer { lock.unlock() }
        var query: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT payload FROM state WHERE id=1", -1, &query, nil) == SQLITE_OK else {
            throw MSyncError.storage("读取状态失败")
        }
        defer { sqlite3_finalize(query) }
        let status = sqlite3_step(query)
        if status == SQLITE_DONE { return StoredState() }
        guard status == SQLITE_ROW, let bytes = sqlite3_column_blob(query, 0) else { throw MSyncError.storage("状态库内容损坏") }
        return try JSONCoding.decoder().decode(StoredState.self, from: Data(bytes: bytes, count: Int(sqlite3_column_bytes(query, 0))))
    }
    private func mutate(_ body: (inout StoredState) throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        try execute("BEGIN IMMEDIATE;")
        do {
            var state = try load()
            try body(&state)
            state.revision += 1
            state.audit = Array(state.audit.suffix(500))
            let data = try JSONCoding.encoder().encode(state)
            var query: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT INTO state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", -1, &query, nil) == SQLITE_OK else {
                throw MSyncError.storage("保存状态失败")
            }
            defer { sqlite3_finalize(query) }
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            let bound = data.withUnsafeBytes { sqlite3_bind_blob(query, 1, $0.baseAddress, Int32($0.count), transient) }
            guard bound == SQLITE_OK, sqlite3_step(query) == SQLITE_DONE else { throw MSyncError.storage("写入状态失败") }
            try execute("COMMIT;")
        } catch { try? execute("ROLLBACK;"); throw error }
    }
    public func addMapping(_ mapping: ItemMapping) throws {
        guard mapping.verified, mapping.items.count >= 2,
              Set(mapping.items.map(\.platform)).count == mapping.items.count,
              mapping.items.allSatisfy({ $0.kind == mapping.kind }), !mapping.evidence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MSyncError.invalid("请确认至少两个平台的对应条目，并记录核实依据")
        }
        let matcher = StrictMatcher()
        if mapping.kind != .artist {
            guard mapping.items.allSatisfy({ $0.release?.date?.isExact == true }) else {
                throw MSyncError.invalid("发行日期不完整，请先核实并补齐年月日；不能用推测日期建立同步关系")
            }
        }
        for item in mapping.items.dropFirst() {
            guard matcher.assess(mapping.items[0], item).decision != .different else {
                throw MSyncError.invalid("发行版本或日期存在硬冲突，不能建立对应关系")
            }
        }
        try mutate { state in
            guard state.outstanding.isEmpty else { throw MSyncError.invalid("请先完成或重新预览未完成的同步") }
            let incoming = Set(mapping.items.map(\.key))
            let overlaps = state.mappings.indices.filter { !Set(state.mappings[$0].items.map(\.key)).isDisjoint(with: incoming) }
            if let index = overlaps.first {
                guard overlaps.count == 1 else { throw MSyncError.invalid("条目属于不同对应关系，不能自动合并") }
                let existing = state.mappings[index]
                let additions = mapping.items.filter { !existing.items.map(\.key).contains($0.key) }
                guard !additions.isEmpty,
                      Set((existing.items + additions).map(\.platform)).count == existing.items.count + additions.count else {
                    throw MSyncError.invalid("同一平台已有对应版本，不能重复映射")
                }
                for item in mapping.items where existing.items.contains(where: { $0.key == item.key }) {
                    guard let prior = existing.items.first(where: { $0.key == item.key }),
                          prior.release?.date == item.release?.date else { throw MSyncError.invalid("已核实条目的日期发生变化，请先核查原对应关系") }
                }
                for item in additions {
                    guard matcher.assess(existing.items[0], item).decision != .different else { throw MSyncError.invalid("与原对应版本存在冲突") }
                }
                state.mappings[index].items += additions
                state.mappings[index].evidence += "\n" + mapping.evidence
            } else { state.mappings.append(mapping) }
            state.audit.append(.init("确认对应关系：\(mapping.title)"))
        }
    }
    public func removeMapping(id: UUID) throws {
        try mutate { state in
            guard state.outstanding.isEmpty else { throw MSyncError.invalid("存在未完成同步，暂时不能移除对应关系") }
            state.mappings.removeAll { $0.id == id }; state.desired.removeValue(forKey: id.uuidString)
            state.audit.append(.init("移除本地对应关系；未修改平台收藏"))
        }
    }
    /// Commit observed user intent before attempting any remote writes.
    public func begin(_ plan: SyncPlan) throws {
        try mutate { state in
            guard state.revision == plan.baseRevision else { throw MSyncError.invalid("预览已过期，请重新扫描") }
            guard Set(plan.observations.map(\.key)).count == plan.observations.count else { throw MSyncError.invalid("扫描包含重复的收藏列表") }
            for snapshot in plan.observations {
                if let old = state.snapshots.first(where: { $0.key == snapshot.key }), old.accountID != snapshot.accountID {
                    throw MSyncError.invalid("\(snapshot.platform.label) 账户或资料库已改变。请先导出记录，再重新建立基线")
                }
            }
            for snapshot in plan.observations { Self.merge(snapshot, into: &state.snapshots) }
            state.desired = plan.desired
            state.activePlanID = plan.id; state.outstanding = plan.operations
            state.audit.append(.init("接受同步预览：\(plan.operations.count) 项操作"))
        }
    }
    public func acknowledge(_ operation: SyncOperation, planID: UUID, snapshot: LibrarySnapshot) throws {
        guard snapshot.platform == operation.item.platform, snapshot.kind == operation.item.kind,
              snapshot.state(of: operation.item.id) == operation.saved else { throw MSyncError.invalid("写入后未确认目标状态") }
        try mutate { state in
            guard state.activePlanID == planID, state.outstanding.contains(where: { $0.id == operation.id }) else {
                throw MSyncError.invalid("操作已过期")
            }
            // Acknowledge only our own target. Other changes in this read remain detectable next scan.
            guard let index = state.snapshots.firstIndex(where: { $0.platform == snapshot.platform && $0.kind == snapshot.kind }),
                  state.snapshots[index].accountID == snapshot.accountID else { throw MSyncError.invalid("账户在写入期间改变") }
            if !state.snapshots[index].items.contains(where: { $0.id == operation.item.id }) { state.snapshots[index].items.append(operation.item) }
            if operation.saved { state.snapshots[index].savedIDs.insert(operation.item.id) }
            else { state.snapshots[index].savedIDs.remove(operation.item.id) }
            state.outstanding.removeAll { $0.id == operation.id }
            state.audit.append(.init("\(operation.saved ? "收藏" : "取消收藏") · \(operation.item.platform.label) · \(operation.item.title)"))
        }
    }
    public func log(_ message: String) throws { try mutate { $0.audit.append(.init(message)) } }
    public func resetLocalHistory() throws {
        try mutate { state in
            state.mappings = []; state.snapshots = []; state.desired = [:]
            state.outstanding = []; state.activePlanID = nil
            state.audit.append(.init("重新建立本地基线：已清除对应关系和历史；未修改平台收藏"))
        }
    }
    private static func merge(_ snapshot: LibrarySnapshot, into snapshots: inout [LibrarySnapshot]) {
        guard let index = snapshots.firstIndex(where: { $0.platform == snapshot.platform && $0.kind == snapshot.kind }) else {
            snapshots.append(snapshot); return
        }
        if snapshot.isComplete || snapshots[index].accountID != snapshot.accountID { snapshots[index] = snapshot; return }
        let explicit = Set(snapshot.items.map(\.id)).union(snapshot.savedIDs)
        let retained = snapshots[index].items.filter { !explicit.contains($0.id) }
        let retainedSaved = snapshots[index].savedIDs.subtracting(explicit)
        var merged = snapshot; merged.items += retained; merged.savedIDs.formUnion(retainedSaved)
        snapshots[index] = merged
    }
}
