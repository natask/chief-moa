import CryptoKit
import Foundation
@testable import MoaMacCore
import XCTest

final class CurrentAppAskTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let origin = URL(string: "https://moa.example")!

    func testSemanticOnlyRequestMatchesGatewayContractAndContainsNoScreenshot() throws {
        let request = try GatewayScreenAwareChatRequest(
            origin: origin,
            sessionID: "mac-session",
            prompt: "  Draft a response  ",
            process: process(),
            observation: observation(),
            includeScreenshot: false
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(request.endpoint.absoluteString, "https://moa.example/v1/chat")
        XCTAssertEqual(json["delivery_intent"] as? String, "assistant_response")
        XCTAssertEqual(json["source"] as? String, "moa-macos")
        let messages = try XCTUnwrap(json["messages"] as? [[String: String]])
        XCTAssertEqual(messages, [["role": "user", "content": "Draft a response"]])
        let evidence = try XCTUnwrap(json["screen_evidence"] as? [String: Any])
        XCTAssertEqual(evidence["surface"] as? String, "macos")
        XCTAssertNil(evidence["screenshot"])
        XCTAssertNotNil(evidence["semantic_summary"] as? String)
        XCTAssertEqual(request.screenshotBytes, 0)
        XCTAssertNil(request.screenshotSHA256)
        XCTAssertNoThrow(try request.validateApproval(request.bodySHA256))
        XCTAssertThrowsError(try request.validateApproval("wrong"))
    }

    func testEnabledScreenshotIncludesExactBytesCountAndDigest() throws {
        let bytes = Data([0xff, 0xd8, 0xff, 0xd9])
        let digest = sha256(bytes)
        let screenshot = ScreenshotEvidence(
            dataBase64: bytes.base64EncodedString(),
            sha256: digest,
            width: 1,
            height: 1
        )
        let request = try GatewayScreenAwareChatRequest(
            origin: origin,
            sessionID: "mac-session",
            prompt: "Describe this",
            process: process(),
            observation: observation(screenshot: screenshot),
            includeScreenshot: true
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        let evidence = try XCTUnwrap(json["screen_evidence"] as? [String: Any])
        let encoded = try XCTUnwrap(evidence["screenshot"] as? [String: Any])
        XCTAssertEqual(encoded["data_base64"] as? String, bytes.base64EncodedString())
        XCTAssertEqual(encoded["bytes"] as? Int, bytes.count)
        XCTAssertEqual(encoded["sha256"] as? String, digest)
        XCTAssertEqual(request.screenshotBytes, bytes.count)
        XCTAssertEqual(request.screenshotSHA256, digest)
    }

    func testScreenshotCannotRideDisabledGrantAndMalformedScreenshotFails() throws {
        let bytes = Data([0xff, 0xd8, 0xff, 0xd9])
        let screenshot = ScreenshotEvidence(
            dataBase64: bytes.base64EncodedString(),
            sha256: sha256(bytes),
            width: 1,
            height: 1
        )
        XCTAssertThrowsError(try GatewayScreenAwareChatRequest(
            origin: origin,
            sessionID: "s",
            prompt: "ask",
            process: process(),
            observation: observation(screenshot: screenshot),
            includeScreenshot: false
        ))
        let malformed = ScreenshotEvidence(dataBase64: "not base64", sha256: "bad", width: 0, height: 1)
        XCTAssertThrowsError(try GatewayScreenAwareChatRequest(
            origin: origin,
            sessionID: "s",
            prompt: "ask",
            process: process(),
            observation: observation(screenshot: malformed),
            includeScreenshot: true
        ))
    }

    func testRequestRejectsOversizedPromptAndWrongProcessBinding() throws {
        XCTAssertThrowsError(try GatewayScreenAwareChatRequest(
            origin: origin,
            sessionID: "s",
            prompt: String(repeating: "a", count: GatewayChatRequest.maximumPromptBytes + 1),
            process: process(),
            observation: observation(),
            includeScreenshot: false
        ))
        let other = ProcessIdentity(
            bundleID: "com.example.other", pid: 77, processStart: now, signingIdentity: "TEAM:other"
        )
        XCTAssertThrowsError(try GatewayScreenAwareChatRequest(
            origin: origin,
            sessionID: "s",
            prompt: "ask",
            process: other,
            observation: observation(),
            includeScreenshot: false
        ))
    }

    func testSemanticSummaryIsBoundedByDroppingNodes() throws {
        let nodes = (0..<128).map {
            AXNode(id: "n\($0)", parentID: nil, role: "AXStaticText", subrole: nil,
                   label: String(repeating: "z", count: 240), enabled: true, focused: false, actions: [])
        }
        let value = Observation(
            observationID: "obs",
            capturedAt: now,
            app: .init(bundleID: process().bundleID, name: "Editor"),
            window: .init(title: "Draft"),
            ax: .init(nodes: nodes, truncated: false, dropped: 0),
            screenshot: nil
        )
        let request = try GatewayScreenAwareChatRequest(
            origin: origin,
            sessionID: "s",
            prompt: "ask",
            process: process(),
            observation: value,
            includeScreenshot: false
        )
        XCTAssertLessThanOrEqual(request.semanticSummary.utf8.count, 6_000)
        XCTAssertTrue(request.semanticSummary.contains("\"truncated\":true"))
    }

    func testCoordinatorSendsOnceAfterExactApprovalThenStripsEvidence() async throws {
        let current = now
        let coordinator = CurrentAppAskCoordinator()
        try await coordinator.publishVerified(
            grant: try grant(), observation: observation(), focusedWindowID: 44
        )
        let initiallyAvailable = await coordinator.hasEvidence(now: now.addingTimeInterval(1))
        XCTAssertTrue(initiallyAvailable)
        let sender = RecordingScreenSender()
        let reply = try await coordinator.ask(
            origin: origin,
            sessionID: "s",
            prompt: "draft it",
            bearerToken: "token",
            now: { current.addingTimeInterval(1) },
            approver: ExactAskApprover(),
            scope: FixedAskScope(allowed: true),
            sender: sender
        )
        XCTAssertEqual(reply.text, "derived candidate")
        let callCount = await sender.calls()
        let hasEvidence = await coordinator.hasEvidence(now: now.addingTimeInterval(2))
        XCTAssertEqual(callCount, 1)
        XCTAssertFalse(hasEvidence)
        await XCTAssertThrowsErrorAsync {
            _ = try await coordinator.ask(
                origin: self.origin,
                sessionID: "s",
                prompt: "again",
                bearerToken: "token",
                now: { current.addingTimeInterval(2) },
                approver: ExactAskApprover(),
                scope: FixedAskScope(allowed: true),
                sender: sender
            )
        }
    }

    func testFutureEvidenceAndPostResponseFocusChangeDiscardCandidate() async throws {
        let current = now
        let coordinator = CurrentAppAskCoordinator()
        try await coordinator.publishVerified(grant: try grant(), observation: observation(), focusedWindowID: 1)
        await XCTAssertThrowsErrorAsync {
            _ = try await coordinator.ask(
                origin: self.origin, sessionID: "s", prompt: "ask", bearerToken: "t",
                now: { current.addingTimeInterval(-1) }, approver: ExactAskApprover(),
                scope: FixedAskScope(allowed: true), sender: RecordingScreenSender()
            )
        }

        try await coordinator.publishVerified(grant: try grant(), observation: observation(), focusedWindowID: 1)
        let sender = RecordingScreenSender()
        await XCTAssertThrowsErrorAsync {
            _ = try await coordinator.ask(
                origin: self.origin, sessionID: "s", prompt: "ask", bearerToken: "t",
                now: { current.addingTimeInterval(1) }, approver: ExactAskApprover(),
                scope: SequencedAskScope([true, false]), sender: sender
            )
        }
        let calls = await sender.calls()
        XCTAssertEqual(calls, 1)
    }

    func testCoordinatorRejectsLocalGrantDestinationDriftExpiryAndScopeChange() async throws {
        let current = now
        let configuredOrigin = origin
        let coordinator = CurrentAppAskCoordinator()
        await XCTAssertThrowsErrorAsync {
            try await coordinator.publishVerified(
                grant: try self.grant(mode: .localOnly, destination: nil),
                observation: self.observation(),
                focusedWindowID: nil
            )
        }

        try await coordinator.publishVerified(grant: try grant(), observation: observation(), focusedWindowID: 1)
        await XCTAssertThrowsErrorAsync {
            _ = try await coordinator.ask(
                origin: URL(string: "https://other.example")!, sessionID: "s", prompt: "ask", bearerToken: "t",
                now: { current.addingTimeInterval(1) }, approver: ExactAskApprover(),
                scope: FixedAskScope(allowed: true), sender: RecordingScreenSender()
            )
        }

        try await coordinator.publishVerified(grant: try grant(), observation: observation(), focusedWindowID: 1)
        await XCTAssertThrowsErrorAsync {
            _ = try await coordinator.ask(
                origin: configuredOrigin, sessionID: "s", prompt: "ask", bearerToken: "t",
                now: { current.addingTimeInterval(901) }, approver: ExactAskApprover(),
                scope: FixedAskScope(allowed: true), sender: RecordingScreenSender()
            )
        }

        try await coordinator.publishVerified(grant: try grant(), observation: observation(), focusedWindowID: 1)
        let sender = RecordingScreenSender()
        await XCTAssertThrowsErrorAsync {
            _ = try await coordinator.ask(
                origin: configuredOrigin, sessionID: "s", prompt: "ask", bearerToken: "t",
                now: { current.addingTimeInterval(1) }, approver: ExactAskApprover(),
                scope: FixedAskScope(allowed: false), sender: sender
            )
        }
        let scopeCalls = await sender.calls()
        XCTAssertEqual(scopeCalls, 0)
    }

    func testApprovalMismatchAndRevocationDuringApprovalSendNothing() async throws {
        let current = now
        let configuredOrigin = origin
        let coordinator = CurrentAppAskCoordinator()
        let sender = RecordingScreenSender()
        try await coordinator.publishVerified(grant: try grant(), observation: observation(), focusedWindowID: 1)
        await XCTAssertThrowsErrorAsync {
            _ = try await coordinator.ask(
                origin: configuredOrigin, sessionID: "s", prompt: "ask", bearerToken: "t",
                now: { current.addingTimeInterval(1) }, approver: MismatchedAskApprover(),
                scope: FixedAskScope(allowed: true), sender: sender
            )
        }
        let mismatchCalls = await sender.calls()
        XCTAssertEqual(mismatchCalls, 0)

        try await coordinator.publishVerified(grant: try grant(), observation: observation(), focusedWindowID: 1)
        await XCTAssertThrowsErrorAsync {
            _ = try await coordinator.ask(
                origin: configuredOrigin, sessionID: "s", prompt: "ask", bearerToken: "t",
                now: { current.addingTimeInterval(1) }, approver: RevokingAskApprover(coordinator: coordinator),
                scope: FixedAskScope(allowed: true), sender: sender
            )
        }
        let revokedCalls = await sender.calls()
        XCTAssertEqual(revokedCalls, 0)
    }

    private func process() -> ProcessIdentity {
        ProcessIdentity(bundleID: "com.example.editor", pid: 42, processStart: now.addingTimeInterval(-20), signingIdentity: "TEAM:editor")
    }

    private func grant(
        mode: ReleaseMode = .askEachTime,
        destination: URL? = URL(string: "https://moa.example")
    ) throws -> ObservationGrant {
        try ObservationGrant(
            process: process(), mode: mode, includeScreenshot: false,
            issuedAt: now.addingTimeInterval(-5), expiresAt: now.addingTimeInterval(895),
            destinationOrigin: destination
        )
    }

    private func observation(screenshot: ScreenshotEvidence? = nil) -> Observation {
        Observation(
            observationID: "obs-1", capturedAt: now,
            app: .init(bundleID: process().bundleID, name: "Editor"),
            window: .init(title: "Draft"),
            ax: .init(nodes: [
                AXNode(id: "n0", parentID: nil, role: "AXWindow", subrole: nil, label: "Draft", enabled: true, focused: true, actions: [])
            ], truncated: false, dropped: 0),
            screenshot: screenshot
        )
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

private struct ExactAskApprover: CurrentAppAskApproving {
    func approve(_ preview: CurrentAppAskPreview) async throws -> String { preview.bodySHA256 }
}

private struct MismatchedAskApprover: CurrentAppAskApproving {
    func approve(_ preview: CurrentAppAskPreview) async throws -> String { "mismatch" }
}

private struct RevokingAskApprover: CurrentAppAskApproving {
    let coordinator: CurrentAppAskCoordinator
    func approve(_ preview: CurrentAppAskPreview) async throws -> String {
        await coordinator.revoke()
        return preview.bodySHA256
    }
}

private struct FixedAskScope: CurrentAppAskScopeValidating {
    let allowed: Bool
    func validate(process: ProcessIdentity, focusedWindowID: UInt32?) async -> Bool { allowed }
}

private actor SequencedAskScope: CurrentAppAskScopeValidating {
    private var values: [Bool]
    init(_ values: [Bool]) { self.values = values }
    func validate(process: ProcessIdentity, focusedWindowID: UInt32?) async -> Bool {
        values.isEmpty ? false : values.removeFirst()
    }
}

private actor RecordingScreenSender: ScreenAwareChatSending {
    private var count = 0
    func send(_ request: GatewayScreenAwareChatRequest, bearerToken: String) async throws -> GatewayChatReply {
        count += 1
        return GatewayChatReply(text: "derived candidate")
    }
    func calls() -> Int { count }
}

private func XCTAssertThrowsErrorAsync(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("Expected error", file: file, line: line)
    } catch {}
}
