import XCTest
@testable import MSyncCore

actor MemoryService: MusicService {
    nonisolated let platform: MusicPlatform
    var data: [CollectionKind: LibrarySnapshot]
    var failWrites = false
    var writeCount = 0
    init(item: MusicItem, saved: Bool) { platform = item.platform; data = [item.kind: snap(item, saved: saved)] }
    func snapshot(kind: CollectionKind) async throws -> LibrarySnapshot {
        data[kind] ?? .init(platform: platform, kind: kind, accountID: "account", items: [], savedIDs: [], isComplete: true)
    }
    func search(for item: MusicItem) async throws -> [MusicItem] { data[item.kind]?.items ?? [] }
    func setSaved(_ saved: Bool, item: MusicItem) async throws -> WriteOutcome {
        writeCount += 1
        if failWrites { throw MSyncError.transport("Simulated write failure") }
        if saved { data[item.kind]?.savedIDs.insert(item.id) } else { data[item.kind]?.savedIDs.remove(item.id) }
        return .applied
    }
    func change(_ item: MusicItem, saved: Bool) { data[item.kind] = snap(item, saved: saved) }
    func setFailure() { failWrites = true }
    func writes() -> Int { writeCount }
}

final class CoordinatorTests: XCTestCase {
    func testPreviewMakesNoWritesAndApplyReadsBack() async throws {
        let store = try SyncStore(path: ":memory:")
        let a = fixture(.spotify), b = fixture(.netease)
        try store.addMapping(mapped([a, b]))
        let spotify = MemoryService(item: a, saved: true), netease = MemoryService(item: b, saved: false)
        let services: [any MusicService] = [spotify, netease]
        let coordinator = SyncCoordinator(store: store)
        let plan = try await coordinator.preview(services: services)
        let before = await netease.writes(); XCTAssertEqual(before, 0)
        XCTAssertTrue(try store.load().snapshots.isEmpty)
        let report = try await coordinator.apply(plan, services: services)
        XCTAssertEqual(report.applied, 1)
        XCTAssertTrue(report.pending.isEmpty)
        XCTAssertTrue(try store.load().outstanding.isEmpty)
        let next = try await coordinator.preview(services: services)
        XCTAssertTrue(next.operations.isEmpty)
    }
    func testRemoteChangeAfterPreviewAbortsBeforeAnyWrites() async throws {
        let store = try SyncStore(path: ":memory:")
        let a = fixture(.spotify), b = fixture(.netease)
        try store.addMapping(mapped([a, b]))
        let spotify = MemoryService(item: a, saved: true), netease = MemoryService(item: b, saved: false)
        let services: [any MusicService] = [spotify, netease]
        let coordinator = SyncCoordinator(store: store)
        let plan = try await coordinator.preview(services: services)
        await spotify.change(a, saved: false)
        do { _ = try await coordinator.apply(plan, services: services); XCTFail("Stale preview should fail") } catch {}
        let writes = await netease.writes(); XCTAssertEqual(writes, 0)
        XCTAssertTrue(try store.load().snapshots.isEmpty)
    }
    func testFailedWriteKeepsDurableIntentAndRetries() async throws {
        let store = try SyncStore(path: ":memory:")
        let a = fixture(.spotify), b = fixture(.netease)
        let mapping = mapped([a, b]); try store.addMapping(mapping)
        let spotify = MemoryService(item: a, saved: true), netease = MemoryService(item: b, saved: false)
        await netease.setFailure()
        let services: [any MusicService] = [spotify, netease]
        let coordinator = SyncCoordinator(store: store)
        let plan = try await coordinator.preview(services: services)
        let report = try await coordinator.apply(plan, services: services)
        XCTAssertEqual(report.applied, 0)
        XCTAssertEqual(report.pending.count, 1)
        XCTAssertEqual(try store.load().outstanding.count, 1)
        let retry = try await coordinator.preview(services: services)
        XCTAssertEqual(retry.operations.count, 1)
        XCTAssertEqual(retry.operations.first?.saved, true)
    }
}
