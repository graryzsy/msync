import Foundation

public enum MatchDecision: String, Codable, Sendable { case compatible, different, needsReview }
public struct MatchAssessment: Codable, Equatable, Sendable {
    public var decision: MatchDecision
    public var evidence: [String]
    public init(_ decision: MatchDecision, _ evidence: [String]) { self.decision = decision; self.evidence = evidence }
}

public struct StrictMatcher: Sendable {
    public init() {}
    /// Keep punctuation/version words: removing them could merge distinct releases.
    public static func normalized(_ value: String) -> String {
        value.precomposedStringWithCompatibilityMapping.lowercased()
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
    private func artists(_ values: [String]) -> Set<String> { Set(values.map(Self.normalized).filter { !$0.isEmpty }) }

    public func assess(_ lhs: MusicItem, _ rhs: MusicItem) -> MatchAssessment {
        guard lhs.kind == rhs.kind else { return .init(.different, ["收藏类型不同"]) }
        if lhs.kind == .artist {
            return .init(.needsReview, ["艺人同名不能证明身份一致；请核对官方艺人页面"])
        }
        guard let a = lhs.release, let b = rhs.release else { return .init(.needsReview, ["缺少所属发行版本"]) }
        guard !Self.normalized(a.title).isEmpty, !Self.normalized(b.title).isEmpty else { return .init(.needsReview, ["所属发行名称缺失"]) }
        guard Self.normalized(a.title) == Self.normalized(b.title) else {
            return .init(.different, ["所属专辑或发行版本不同；禁止用精选集替代原专辑"])
        }
        if let ad = a.date, let bd = b.date, ad.isExact, bd.isExact, ad != bd {
            return .init(.different, ["发行日期不同：\(ad.value) / \(bd.value)"])
        }
        if let x = lhs.isrc, let y = rhs.isrc, !x.isEmpty, !y.isEmpty, x.uppercased() != y.uppercased() {
            return .init(.different, ["ISRC 不同"])
        }
        if let x = lhs.discNumber, let y = rhs.discNumber, x > 0, y > 0, x != y {
            return .init(.different, ["碟号不同"])
        }
        if let x = lhs.trackNumber, let y = rhs.trackNumber, x > 0, y > 0, x != y {
            return .init(.different, ["曲序不同"])
        }
        guard let ad = a.date, let bd = b.date, ad.isExact, bd.isExact else {
            return .init(.needsReview, ["发行日期必须精确到年月日，不补全缺失日期"])
        }
        guard Self.normalized(lhs.title) == Self.normalized(rhs.title) else {
            return .init(.needsReview, ["名称不同；可能包含翻译、别名或版本差异，需人工核实"])
        }
        guard !artists(a.artists).isEmpty, artists(a.artists) == artists(b.artists),
              !artists(lhs.artists).isEmpty, artists(lhs.artists) == artists(rhs.artists) else {
            return .init(.needsReview, ["艺人信息不一致或缺失，需核实别名和合作艺人"])
        }
        if let x = a.barcode, let y = b.barcode, !x.isEmpty, !y.isEmpty, x != y {
            return .init(.needsReview, ["发行条码不同；需核实地区或版本差异"])
        }
        if let x = lhs.durationMS, let y = rhs.durationMS, x > 0, y > 0, abs(x - y) > 2_000 {
            return .init(.needsReview, ["时长相差超过两秒"])
        }
        return .init(.compatible, ["名称、艺人、所属发行版本和完整发行日期一致；仍需确认对应关系"])
    }
}
