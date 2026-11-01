import XCTest
@testable import MSyncCore

final class PlannerTests: XCTestCase {
    let items = MusicPlatform.allCases.map { fixture($0) }
    func testAppleRemovalPropagatesToOtherTwo() {
        let previous = items.map { snap($0, saved: true) }
        let current = items.map { snap($0, saved: $0.platform != .appleMusic) }
        let plan = SyncPlanner().plan(mappings: [mapped(items)], previous: previous, current: current)
        XCTAssertEqual(Set(plan.operations.map { $0.item.platform }), [.spotify, .netease])
        XCTAssertTrue(plan.operations.allSatisfy { !$0.saved })
    }
    func testInitialMissingItemDoesNotDeleteSpotify() {
        let plan = SyncPlanner().plan(mappings: [mapped(items)], previous: [], current: items.map { snap($0, saved: $0.platform == .spotify) })
        XCTAssertEqual(plan.operations.count, 2)
        XCTAssertTrue(plan.operations.allSatisfy(\.saved))
    }
    func testUnknownAbsenceCannotProduceDeletion() {
        let old = items.map { snap($0, saved: true) }
        let now = items.map { snap($0, saved: $0.platform != .appleMusic, complete: $0.platform != .appleMusic, included: $0.platform != .appleMusic) }
        let plan = SyncPlanner().plan(mappings: [mapped(items)], previous: old, current: now)
        XCTAssertTrue(plan.operations.isEmpty)
        XCTAssertFalse(plan.issues.isEmpty)
    }
    func testExplicitFalseInPartialSnapshotCanPropagate() {
        let old = items.map { snap($0, saved: true) }
        let now = items.map { snap($0, saved: $0.platform != .appleMusic, complete: false) }
        let plan = SyncPlanner().plan(mappings: [mapped(items)], previous: old, current: now)
        XCTAssertEqual(plan.operations.count, 2)
        XCTAssertTrue(plan.operations.allSatisfy { !$0.saved })
    }
    func testOfflinePlatformDoesNotResurrectTombstone() {
        let mapping = mapped(items)
        let previous = items.map { snap($0, saved: $0.platform == .netease) }
        let plan = SyncPlanner().plan(mappings: [mapping], previous: previous, current: previous, desired: [mapping.id.uuidString: false])
        XCTAssertEqual(plan.operations.map { $0.item.platform }, [.netease])
        XCTAssertEqual(plan.operations.first?.saved, false)
    }
    func testNewFavoriteCanRestoreAfterRecordedRemoval() {
        let mapping = mapped(items)
        let previous = items.map { snap($0, saved: false) }
        let current = items.map { snap($0, saved: $0.platform == .netease) }
        let plan = SyncPlanner().plan(mappings: [mapping], previous: previous, current: current, desired: [mapping.id.uuidString: false])
        XCTAssertEqual(plan.operations.count, 2)
        XCTAssertTrue(plan.operations.allSatisfy(\.saved))
    }
    func testAccountSwitchBlocksWholeMapping() {
        let previous = items.map { snap($0, saved: true) }
        let current = items.map { snap($0, saved: false, account: $0.platform == .appleMusic ? "other-account" : "account") }
        let plan = SyncPlanner().plan(mappings: [mapped(items)], previous: previous, current: current)
        XCTAssertTrue(plan.operations.isEmpty)
        XCTAssertTrue(plan.issues.contains { $0.message.contains("账户") })
    }
    func testSpotifyWinsOnlyWhenItActuallyChanged() {
        let old = items.map { snap($0, saved: $0.platform != .spotify) }
        let now = items.map { snap($0, saved: $0.platform != .netease) }
        let plan = SyncPlanner().plan(mappings: [mapped(items)], previous: old, current: now)
        XCTAssertEqual(plan.operations.map { $0.item.platform }, [.netease])
        XCTAssertTrue(plan.operations.allSatisfy(\.saved))
    }
    func testUnverifiedMappingNeverWrites() {
        var mapping = mapped(items); mapping.verified = false
        let plan = SyncPlanner().plan(mappings: [mapping], previous: [], current: items.map { snap($0, saved: $0.platform == .spotify) })
        XCTAssertTrue(plan.operations.isEmpty)
    }
    func testKindsRemainIndependent() {
        let track = mapped(items)
        let albumItems = MusicPlatform.allCases.map { fixture($0, kind: .album) }
        let album = mapped(albumItems)
        let old = (items + albumItems).map { snap($0, saved: true) }
        let now = (items + albumItems).map { snap($0, saved: !($0.kind == .album && $0.platform == .appleMusic)) }
        let plan = SyncPlanner().plan(mappings: [track, album], previous: old, current: now)
        XCTAssertEqual(plan.operations.count, 2)
        XCTAssertTrue(plan.operations.allSatisfy { $0.item.kind == .album })
    }
}
