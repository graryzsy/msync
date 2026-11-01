import XCTest
@testable import MSyncCore

func fixture(_ platform: MusicPlatform, kind: CollectionKind = .track, id: String? = nil, album: String = "Original Album", date: String = "2024-02-29") -> MusicItem {
    .init(platform: platform, kind: kind, id: id ?? platform.rawValue, title: kind == .album ? album : "Song", artists: ["Artist"],
          release: kind == .artist ? nil : Release(title: album, artists: ["Artist"], date: ReleaseDate(date)),
          isrc: kind == .track ? "USABC0000001" : nil, discNumber: 1, trackNumber: 2, durationMS: 180000)
}
func snap(_ item: MusicItem, saved: Bool, complete: Bool = true, included: Bool = true, account: String = "account") -> LibrarySnapshot {
    .init(platform: item.platform, kind: item.kind, accountID: account, items: included ? [item] : [], savedIDs: saved ? [item.id] : [], isComplete: complete)
}
func mapped(_ items: [MusicItem]) -> ItemMapping { .init(kind: items[0].kind, items: items, verified: true, evidence: "Verified edition and complete release day") }

final class MatcherTests: XCTestCase {
    func testCalendarPrecisionAndValidation() {
        XCTAssertTrue(ReleaseDate("2024-02-29").isExact)
        for date in ["2023-02-29", "2024", "2024-02", "2024-13-01", "2024-04-31", "2024-1-01", "0000-01-01", "+024-01-01"] { XCTAssertFalse(ReleaseDate(date).isExact, date) }
    }
    func testSameISRCOnCompilationIsDifferent() {
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify), fixture(.netease, album: "Greatest Hits")).decision, .different)
    }
    func testTitleDifferenceCannotHideHardReleaseConflict() {
        var other = fixture(.netease, album: "Greatest Hits"); other.title = "Translated Song"
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify), other).decision, .different)
        other = fixture(.netease, date: "2024-03-01"); other.title = "Translated Song"
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify), other).decision, .different)
    }
    func testSingleAndAlbumAreDifferent() {
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify, album: "Song - Single"), fixture(.appleMusic)).decision, .different)
    }
    func testDeluxeEditionRemainsDistinct() {
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify), fixture(.appleMusic, album: "Original Album (Deluxe)")).decision, .different)
    }
    func testDateDifferenceIsNeverTolerated() {
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify), fixture(.appleMusic, date: "2024-03-01")).decision, .different)
    }
    func testYearAloneCannotMatch() {
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify), fixture(.appleMusic, date: "2024")).decision, .needsReview)
    }
    func testMatchingEditionIsCompatibleButNotAutoVerified() {
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify), fixture(.appleMusic)).decision, .compatible)
    }
    func testSameArtistNameRequiresIdentityReview() {
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify, kind: .artist), fixture(.netease, kind: .artist)).decision, .needsReview)
    }
    func testDifferentRecordingCannotMatch() {
        var other = fixture(.appleMusic); other.isrc = "OTHER"
        XCTAssertEqual(StrictMatcher().assess(fixture(.spotify), other).decision, .different)
    }
}
