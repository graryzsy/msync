import Foundation

public enum MusicPlatform: String, Codable, CaseIterable, Sendable {
    case spotify, appleMusic, netease
    public var label: String {
        switch self { case .spotify: "Spotify"; case .appleMusic: "Apple Music"; case .netease: "网易云音乐" }
    }
}

public enum CollectionKind: String, Codable, CaseIterable, Sendable {
    case track, album, artist
    public var label: String {
        switch self { case .track: "喜欢的歌曲"; case .album: "收藏的专辑"; case .artist: "收藏的艺人" }
    }
}

/// A calendar date, not a timestamp. Missing month/day is never fabricated.
public struct ReleaseDate: Codable, Equatable, Hashable, Sendable {
    public let value: String
    public init(_ value: String) { self.value = value }
    public var isExact: Bool {
        guard value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { return false }
        let pieces = value.split(separator: "-", omittingEmptySubsequences: false)
        guard pieces.count == 3, pieces[0].count == 4, pieces[1].count == 2, pieces[2].count == 2,
              let year = Int(pieces[0]), let month = Int(pieces[1]), let day = Int(pieces[2]), year > 0 else { return false }
        let calendar = Calendar(identifier: .gregorian)
        let components = DateComponents(year: year, month: month, day: day)
        guard let date = calendar.date(from: components) else { return false }
        let checked = calendar.dateComponents([.year, .month, .day], from: date)
        return checked.year == year && checked.month == month && checked.day == day
    }
}

public struct Release: Codable, Equatable, Hashable, Sendable {
    public var title: String
    public var artists: [String]
    public var date: ReleaseDate?
    public var barcode: String?
    public init(title: String, artists: [String], date: ReleaseDate? = nil, barcode: String? = nil) {
        self.title = title; self.artists = artists; self.date = date; self.barcode = barcode
    }
}

public struct MusicItem: Codable, Equatable, Identifiable, Sendable {
    public var platform: MusicPlatform
    public var kind: CollectionKind
    public var id: String
    public var title: String
    public var artists: [String]
    public var release: Release?
    public var isrc: String?
    public var discNumber: Int?
    public var trackNumber: Int?
    public var durationMS: Int?
    public var url: String?
    /// Music.app persistent ID, separate from this app's release identity.
    public var nativeReference: String?

    public init(platform: MusicPlatform, kind: CollectionKind, id: String, title: String,
                artists: [String] = [], release: Release? = nil, isrc: String? = nil,
                discNumber: Int? = nil, trackNumber: Int? = nil, durationMS: Int? = nil,
                url: String? = nil, nativeReference: String? = nil) {
        self.platform = platform; self.kind = kind; self.id = id; self.title = title
        self.artists = artists; self.release = release; self.isrc = isrc
        self.discNumber = discNumber; self.trackNumber = trackNumber; self.durationMS = durationMS
        self.url = url; self.nativeReference = nativeReference
    }
    public var key: String { "\(platform.rawValue):\(kind.rawValue):\(id)" }
}

public struct LibrarySnapshot: Codable, Equatable, Sendable {
    public var key: String { "\(platform.rawValue):\(kind.rawValue)" }
    public var platform: MusicPlatform
    public var kind: CollectionKind
    public var accountID: String
    public var capturedAt: Date
    public var items: [MusicItem]
    public var savedIDs: Set<String>
    /// Only a verified, exhaustive scan may infer removal from absence.
    public var isComplete: Bool
    public var notes: [String]
    public init(platform: MusicPlatform, kind: CollectionKind, accountID: String, capturedAt: Date = Date(),
                items: [MusicItem], savedIDs: Set<String>, isComplete: Bool, notes: [String] = []) {
        self.platform = platform; self.kind = kind; self.accountID = accountID
        self.capturedAt = capturedAt; self.items = items; self.savedIDs = savedIDs
        self.isComplete = isComplete; self.notes = notes
    }
    public func state(of id: String) -> Bool? {
        if savedIDs.contains(id) { return true }
        if items.contains(where: { $0.id == id }) { return false }
        return isComplete ? false : nil
    }
}

public struct ItemMapping: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var kind: CollectionKind
    public var items: [MusicItem]
    public var verified: Bool
    public var evidence: String
    public init(id: UUID = UUID(), kind: CollectionKind, items: [MusicItem], verified: Bool, evidence: String) {
        self.id = id; self.kind = kind; self.items = items; self.verified = verified; self.evidence = evidence
    }
    public var title: String { items.first(where: { $0.platform == .spotify })?.title ?? items.first?.title ?? "未命名" }
}

public struct SyncOperation: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var mappingID: UUID
    public var item: MusicItem
    public var saved: Bool
    public var reason: String
    public init(id: UUID = UUID(), mappingID: UUID, item: MusicItem, saved: Bool, reason: String) {
        self.id = id; self.mappingID = mappingID; self.item = item; self.saved = saved; self.reason = reason
    }
}

public struct ReviewIssue: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID = UUID()
    public var mappingID: UUID?
    public var message: String
    public init(mappingID: UUID? = nil, message: String) { self.mappingID = mappingID; self.message = message }
}

public enum WriteOutcome: Sendable, Equatable {
    case applied
    case needsInteraction(message: String, url: String?)
}

public protocol MusicService {
    var platform: MusicPlatform { get }
    func snapshot(kind: CollectionKind) async throws -> LibrarySnapshot
    func search(for item: MusicItem) async throws -> [MusicItem]
    func setSaved(_ saved: Bool, item: MusicItem) async throws -> WriteOutcome
}

public enum MSyncError: Error, LocalizedError, Sendable {
    case invalid(String), unavailable(String), transport(String), storage(String)
    public var errorDescription: String? {
        switch self { case .invalid(let s), .unavailable(let s), .transport(let s), .storage(let s): s }
    }
}

public enum JSONCoding {
    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601; return decoder
    }
}
