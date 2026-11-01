import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import MSyncAdapters
import MSyncCore

actor FixtureTransport: HTTPTransport {
    var responses: [(Int, Data)]
    var requests: [URLRequest] = []
    init(_ responses: [(Int, String)]) { self.responses = responses.map { ($0.0, Data($0.1.utf8)) } }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard !responses.isEmpty else { throw MSyncError.transport("No fixture response") }
        let next = responses.removeFirst()
        return (next.1, HTTPURLResponse(url: request.url!, statusCode: next.0, httpVersion: nil, headerFields: nil)!)
    }
    func recorded() -> [URLRequest] { requests }
}

final class AdapterTests: XCTestCase {
    func testPKCEChallengeMatchesRFC7636() {
        let authorization = SpotifyAuthorization(clientID: "client", verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", state: "state")
        XCTAssertEqual(authorization.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
    func testOAuthRejectsWrongStateHostAndDuplicateParameters() throws {
        let authorization = SpotifyAuthorization(clientID: "client", state: "expected")
        for address in ["http://127.0.0.1:19428/callback?code=x&state=other", "http://evil.example:19428/callback?code=x&state=expected",
                        "http://127.0.0.1:19428/callback?code=x&state=expected&state=expected"] {
            XCTAssertThrowsError(try authorization.code(from: URL(string: address)!))
        }
        XCTAssertEqual(try authorization.code(from: URL(string: "http://127.0.0.1:19428/callback?code=abc&state=expected")!), "abc")
    }
    func testRefreshTokenFormEscapesPlus() async throws {
        let transport = FixtureTransport([(200, #"{"access_token":"new","expires_in":3600}"#)])
        let token = SpotifyToken(accessToken: "old", refreshToken: "a+b", expiresAt: .distantPast)
        let refreshed = try await SpotifyAuthorization.refresh(token, clientID: "client", http: HTTPClient(transport: transport))
        let requests = await transport.recorded()
        XCTAssertTrue(String(decoding: requests[0].httpBody!, as: UTF8.self).contains("refresh_token=a%2Bb"))
        XCTAssertEqual(refreshed.refreshToken, "a+b")
    }
    func testUsesCurrentSpotifyLibraryEndpoint() async throws {
        let transport = FixtureTransport([(200, "")])
        let service = SpotifyService(clientID: "client", token: .init(accessToken: "test", refreshToken: "test", expiresAt: .distantFuture), http: HTTPClient(transport: transport))
        let outcome = try await service.setSaved(false, item: .init(platform: .spotify, kind: .track, id: "abc123", title: "Song"))
        let requests = await transport.recorded()
        XCTAssertEqual(outcome, .applied)
        XCTAssertEqual(requests.first?.httpMethod, "DELETE")
        XCTAssertEqual(requests.first?.url?.path, "/v1/me/library")
        XCTAssertEqual(URLComponents(url: requests[0].url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "spotify:track:abc123")
    }
    func testPaginationFailureNeverReturnsEmptySuccessfulSnapshot() async throws {
        let firstPage = #"{"total":2,"next":"https://api.spotify.com/v1/me/tracks?offset=1","items":[{"track":{"id":"a","name":"Song","artists":[{"name":"Artist"}],"album":{"name":"Album","artists":[{"name":"Artist"}],"release_date":"2024-01-01"}}}]}"#
        let transport = FixtureTransport([(200, #"{"id":"user"}"#), (200, firstPage), (429, "")])
        let service = SpotifyService(clientID: "client", token: .init(accessToken: "test", refreshToken: "test", expiresAt: .distantFuture), http: HTTPClient(transport: transport))
        do { _ = try await service.snapshot(kind: .track); XCTFail("Should not return a partial successful snapshot") }
        catch { XCTAssertTrue(error.localizedDescription.contains("限流")) }
    }
    func testRejectsForeignPaginationHostBeforeSendingCredentials() async throws {
        let transport = FixtureTransport([(200, #"{"id":"user"}"#), (200, #"{"total":1,"items":[],"next":"https://evil.example/v1/page"}"#)])
        let service = SpotifyService(clientID: "client", token: .init(accessToken: "test", refreshToken: "test", expiresAt: .distantFuture), http: HTTPClient(transport: transport))
        do { _ = try await service.snapshot(kind: .track); XCTFail("Should reject external host") } catch {}
        let requests = await transport.recorded()
        XCTAssertEqual(requests.count, 2)
    }
}
