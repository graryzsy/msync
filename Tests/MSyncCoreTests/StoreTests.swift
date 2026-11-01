import XCTest
@testable import MSyncCore

final class StoreTests: XCTestCase {
    func testChangedAccountCannotBeAcceptedAsNewBaselineImplicitly() throws {
        let store = try SyncStore(path: ":memory:")
        let item = fixture(.spotify)
        try store.begin(.init(observations: [snap(item, saved: true)], operations: [], issues: [], desired: [:]))
        let revision = try store.load().revision
        XCTAssertThrowsError(try store.begin(.init(baseRevision: revision, observations: [snap(item, saved: false, account: "other")], operations: [], issues: [], desired: [:])))
        XCTAssertEqual(try store.load().snapshots[0].accountID, "account")
    }
    func testPreviewIsReadOnlyAndStaleCommitRejected() throws {
        let store = try SyncStore(path: ":memory:")
        let a = fixture(.spotify), b = fixture(.appleMusic)
        let mapping = mapped([a, b]); try store.addMapping(mapping)
        let state = try store.load()
        let plan = SyncPlanner().plan(mappings: state.mappings, previous: [], current: [snap(a, saved: true), snap(b, saved: false)], revision: state.revision)
        XCTAssertTrue(try store.load().snapshots.isEmpty)
        try store.log("changed")
        XCTAssertThrowsError(try store.begin(plan))
        XCTAssertTrue(try store.load().snapshots.isEmpty)
    }
    func testPartialScanPreservesPreviouslyKnownState() throws {
        let store = try SyncStore(path: ":memory:")
        let a = fixture(.appleMusic)
        try store.begin(.init(observations: [snap(a, saved: true)], operations: [], issues: [], desired: [:]))
        try store.begin(.init(baseRevision: store.load().revision, observations: [snap(a, saved: false, complete: false, included: false)], operations: [], issues: [], desired: [:]))
        XCTAssertEqual(try store.load().snapshots.first?.state(of: a.id), true)
    }
    func testCanExtendPairIntoThreePlatformMapping() throws {
        let store = try SyncStore(path: ":memory:")
        try store.addMapping(mapped([fixture(.spotify), fixture(.appleMusic)]))
        try store.addMapping(mapped([fixture(.spotify), fixture(.netease)]))
        XCTAssertEqual(try store.load().mappings.count, 1)
        XCTAssertEqual(try store.load().mappings.first?.items.count, 3)
    }
    func testCannotMapTwoVersionsOnOnePlatform() throws {
        let store = try SyncStore(path: ":memory:")
        try store.addMapping(mapped([fixture(.spotify), fixture(.appleMusic)]))
        XCTAssertThrowsError(try store.addMapping(mapped([fixture(.spotify), fixture(.appleMusic, id: "other")])))
    }
    func testUnknownDateCannotBeApproved() throws {
        let store = try SyncStore(path: ":memory:")
        XCTAssertThrowsError(try store.addMapping(mapped([fixture(.spotify), fixture(.appleMusic, date: "2024")])))
    }
    func testWrongAlbumCannotBeManuallyApproved() throws {
        let store = try SyncStore(path: ":memory:")
        XCTAssertThrowsError(try store.addMapping(mapped([fixture(.spotify), fixture(.appleMusic, album: "Greatest Hits")])))
    }
    func testPendingOperationsAndTombstonesSurviveReopen() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite")
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: url.path + suffix) } }
        let mapping = mapped([fixture(.spotify), fixture(.appleMusic)])
        let operation = SyncOperation(mappingID: mapping.id, item: fixture(.spotify), saved: false, reason: "User removal")
        do {
            let store = try SyncStore(path: url.path)
            try store.begin(.init(observations: [snap(fixture(.spotify), saved: true)], operations: [operation], issues: [], desired: [mapping.id.uuidString: false]))
        }
        let restored = try SyncStore(path: url.path).load()
        XCTAssertEqual(restored.desired[mapping.id.uuidString], false)
        XCTAssertEqual(restored.outstanding, [operation])
    }
    func testAcknowledgmentDoesNotSwallowOtherUserChanges() throws {
        let store = try SyncStore(path: ":memory:")
        let first = fixture(.spotify), second = fixture(.spotify, id: "second")
        let before = LibrarySnapshot(platform: .spotify, kind: .track, accountID: "account", items: [first, second], savedIDs: [first.id, second.id], isComplete: true)
        let operation = SyncOperation(mappingID: UUID(), item: first, saved: false, reason: "remove")
        let plan = SyncPlan(observations: [before], operations: [operation], issues: [], desired: [:])
        try store.begin(plan)
        var confirmation = before; confirmation.savedIDs = []
        try store.acknowledge(operation, planID: plan.id, snapshot: confirmation)
        let saved = try store.load().snapshots[0]
        XCTAssertEqual(saved.state(of: first.id), false)
        XCTAssertEqual(saved.state(of: second.id), true)
    }
}
