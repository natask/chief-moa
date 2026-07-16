import Foundation
import Testing
#if os(macOS)
import AppKit
import ApplicationServices
#endif
@testable import MoaMacCore
@testable import MoaMacShell
@testable import MoaMacUI

private let now = Date(timeIntervalSince1970: 1_700_000_000)
private let process = ProcessIdentity(bundleID: "com.example.Editor", pid: 42, processStart: now.addingTimeInterval(-10), signingIdentity: "TEAM:com.example.Editor")

@Test func grantIsBoundedMemoryOnlyAndRevokesOnScopeChange() async throws {
    let store = GrantStore(); let grant = try ObservationGrant(process: process, mode: .localOnly, issuedAt: now, expiresAt: now.addingTimeInterval(900)); await store.start(grant)
    #expect(try await store.current(now: now.addingTimeInterval(1), process: process) == grant)
    let replacement = ProcessIdentity(bundleID: process.bundleID, pid: process.pid, processStart: now, signingIdentity: process.signingIdentity)
    await #expect(throws: MoaMacError.scopeChanged) { try await store.current(now: now.addingTimeInterval(2), process: replacement) }
    await #expect(throws: MoaMacError.invalidGrant) { try await store.current(now: now.addingTimeInterval(3), process: process) }
    #expect(throws: MoaMacError.invalidGrant) { try ObservationGrant(process: process, mode: .localOnly, issuedAt: now, expiresAt: now.addingTimeInterval(901)) }
}

@Test func destinationIsConfiguredCanonicalAndPrivateByDefault() throws {
    #expect(try DestinationPolicy.endpoint(origin: URL(string: "https://moa.example")!).absoluteString == "https://moa.example/v1/proactive/macos")
    #expect(try DestinationPolicy.endpoint(origin: URL(string: "http://127.0.0.1:8787")!).absoluteString == "http://127.0.0.1:8787/v1/proactive/macos")
    #expect(throws: MoaMacError.invalidDestination) { try DestinationPolicy.endpoint(origin: URL(string: "http://moa.example")!) }
    #expect(throws: MoaMacError.invalidDestination) { try DestinationPolicy.endpoint(origin: URL(string: "https://moa.example/other")!) }
}

@Test func chatRequestIsBoundedCanonicalAndContainsNoScreenEvidence() throws {
    let request = try GatewayChatRequest(origin: URL(string: "https://moa.example")!, sessionID: "mac-test", prompt: "  Help me plan this  ")
    #expect(request.endpoint.absoluteString == "https://moa.example/v1/chat")
    let raw = try #require(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
    #expect(raw["source"] as? String == "moa-macos")
    #expect(raw["session_id"] as? String == "mac-test")
    #expect(raw["screen"] == nil)
    #expect(raw["ax"] == nil)
    let messages = try #require(raw["messages"] as? [[String: String]])
    #expect(messages == [["role": "user", "content": "Help me plan this"]])
    #expect(throws: MoaMacError.invalidDestination) {
        try GatewayChatRequest(origin: URL(string: "https://moa.example/v1/chat")!, sessionID: "mac-test", prompt: "hello")
    }
    #expect(throws: GatewayChatError.emptyPrompt) {
        try GatewayChatRequest(origin: URL(string: "https://moa.example")!, sessionID: "mac-test", prompt: "   ")
    }
    #expect(throws: GatewayChatError.promptTooLarge) {
        try GatewayChatRequest(origin: URL(string: "https://moa.example")!, sessionID: "mac-test", prompt: String(repeating: "a", count: GatewayChatRequest.maximumPromptBytes + 1))
    }
}

@Test func chatReplyIsInertAndBounded() throws {
    let safe = Data(#"{"text":"Review this first","context":{"action":"continue","branch_id":"default","persisted":true}}"#.utf8)
    #expect(try GatewayChatReplyDecoder.decode(safe) == GatewayChatReply(text: "Review this first"))
    let withProposal = Data(#"{"text":"Review this first","actions":[{"kind":"press"}]}"#.utf8)
    #expect(try GatewayChatReplyDecoder.decode(withProposal) == GatewayChatReply(text: "Review this first"))
    #expect(throws: GatewayChatError.invalidResponse) { try GatewayChatReplyDecoder.decode(Data(#"{"actions":[]}"#.utf8)) }
    #expect(throws: GatewayChatError.responseTooLarge) {
        try GatewayChatReplyDecoder.decode(Data(repeating: 0x20, count: GatewayChatReplyDecoder.maximumResponseBytes + 1))
    }
}

@Test func boundsRedactAndTruncate() throws {
    let nodes = (0..<150).map { AXNode(id: "n\($0)", parentID: nil, role: "AXTextField", subrole: nil, label: $0 == 0 ? "password secret" : String(repeating: "é", count: 300), enabled: true, focused: false, actions: ["AXPress"]) }
    let result = ObservationBounds.snapshot(nodes); #expect(result.nodes.count <= 128); #expect(result.truncated); #expect(result.nodes[0].label == nil); #expect((result.nodes[1].label?.utf8.count ?? 0) <= 256)
}

@Test func observationRedactsTitlesNamesLabelsAndURLPaths() {
    let value = Observation(observationID: "o", capturedAt: now, app: .init(bundleID: "com.test", name: "person@example.com"),
        window: .init(title: "https://example.com/private?token=secret"),
        ax: .init(nodes: [.init(id: "n", parentID: nil, role: "AXStaticText", subrole: nil, label: "/Users/alice/private", enabled: true, focused: false, actions: [])], truncated: false, dropped: 0), screenshot: nil)
    #expect(value.app.name == "[redacted]"); #expect(value.window.title == "https://example.com"); #expect(value.ax.nodes[0].label == nil)
}

@Test func previewBytesAreImmutableAndDigestBound() throws {
    let observation = Observation(observationID: "obs-1", capturedAt: now, app: .init(bundleID: process.bundleID, name: "Editor"), window: .init(title: "Document"), ax: .init(nodes: [], truncated: false, dropped: 0), screenshot: nil)
    let preview = try RequestPreview(origin: URL(string: "https://moa.example")!, mode: .askEachTime, observation: observation)
    try preview.validateApproval(digest: preview.bodySHA256); #expect(throws: MoaMacError.approvalMismatch) { try preview.validateApproval(digest: "changed") }
    #expect(String(data: preview.body, encoding: .utf8)?.contains("\"screenshot\":null") == true)
}

@Test func requestPreviewUsesGatewayOnePointFiveMiBLimit() {
    let huge = ScreenshotEvidence(dataBase64: String(repeating: "A", count: 1_572_864), sha256: "x", width: 1, height: 1)
    let value = Observation(observationID: "oversize", capturedAt: now, app: .init(bundleID: process.bundleID, name: "Editor"), window: .init(title: "Document"), ax: .init(nodes: [], truncated: false, dropped: 0), screenshot: huge)
    #expect(throws: MoaMacError.tooLarge) { try RequestPreview(origin: URL(string: "https://moa.example")!, mode: .askEachTime, observation: value) }
}

@Test func suggestionsMustRemainInertAndBounded() throws {
    let safe = Data(#"{"version":1,"suggestion":"Want help?","actions":[]}"#.utf8); #expect(try SuggestionDecoder.decode(safe).suggestion == "Want help?")
    let active = Data(#"{"version":1,"suggestion":"Do it","actions":["click"]}"#.utf8); #expect(throws: MoaMacError.invalidResponse) { try SuggestionDecoder.decode(active) }
    let unknown = Data(#"{"version":1,"suggestion":"Do it","actions":[],"persisted":false}"#.utf8); #expect(throws: MoaMacError.invalidResponse) { try SuggestionDecoder.decode(unknown) }
    let empty = Data(#"{"version":1,"suggestion":"","actions":[]}"#.utf8); #expect(throws: MoaMacError.invalidResponse) { try SuggestionDecoder.decode(empty) }
    let oversized = try JSONSerialization.data(withJSONObject: ["version": 1, "suggestion": String(repeating: "é", count: 1025), "actions": []]); #expect(throws: MoaMacError.invalidResponse) { try SuggestionDecoder.decode(oversized) }
}

@Test func responseBufferRejectsBeforeAllocatingBeyond64KiB() throws {
    var buffer = BoundedResponseBuffer(); for _ in 0..<BoundedResponseBuffer.limit { try buffer.append(0x20) }
    #expect(buffer.value.count == 64 * 1024); #expect(throws: MoaMacError.tooLarge) { try buffer.append(0x20) }
}

private actor FakeTransport: SuggestionTransport {
    var calls = 0; var preview: RequestPreview?
    func send(preview: RequestPreview, bearerToken: String) async throws -> Data {
        calls += 1; self.preview = preview
        return Data(#"{"version":1,"suggestion":"Want help?","actions":[]}"#.utf8)
    }
}
private struct MatchingApprover: PreviewApprover { func approve(_ preview: RequestPreview) async throws -> String { preview.bodySHA256 } }
private struct BadApprover: PreviewApprover { func approve(_ preview: RequestPreview) async throws -> String { "wrong" } }
private actor SequenceScope: ObservationScopeValidator {
    var values: [Bool]; init(_ values: [Bool]) { self.values = values }
    func validate(process: ProcessIdentity, observation: Observation, focusedWindowID: UInt32?) async -> Bool { values.isEmpty ? false : values.removeFirst() }
}
private struct ExactWindowScope: ObservationScopeValidator {
    let current: UInt32
    func validate(process: ProcessIdentity, observation: Observation, focusedWindowID: UInt32?) async -> Bool { focusedWindowID == current }
}
private func observation() -> Observation { Observation(observationID: "obs", capturedAt: now, app: .init(bundleID: process.bundleID, name: "Editor"), window: .init(title: "Document"), ax: .init(nodes: [.init(id: "n0", parentID: nil, role: "AXTextField", subrole: nil, label: nil, enabled: true, focused: true, actions: [])], truncated: false, dropped: 0), screenshot: nil) }

@Test func localSuggestionNeverUsesTransport() async throws {
    let grants = GrantStore(), transport = FakeTransport(), coordinator = SuggestionCoordinator(grants: grants)
    await grants.start(try ObservationGrant(process: process, mode: .localOnly, issuedAt: now, expiresAt: now.addingTimeInterval(900)))
    let result = try await coordinator.suggest(observation: observation(), process: process, origin: nil, token: nil, now: { now }, transport: transport)
    #expect(result.version == 1); #expect(await transport.calls == 0); #expect(result.actions.isEmpty)
}

@Test func askModeRequiresExactDigestAndSendsOnce() async throws {
    let grants = GrantStore(), transport = FakeTransport(), coordinator = SuggestionCoordinator(grants: grants), origin = URL(string: "https://moa.example")!
    await grants.start(try ObservationGrant(process: process, mode: .askEachTime, issuedAt: now, expiresAt: now.addingTimeInterval(900), destinationOrigin: origin))
    await #expect(throws: MoaMacError.approvalMismatch) { try await coordinator.suggest(observation: observation(), process: process, origin: origin, token: "token", now: { now }, approver: BadApprover(), transport: transport) }
    #expect(await transport.calls == 0)
    let result = try await coordinator.suggest(observation: observation(), process: process, origin: origin, token: "token", now: { now }, approver: MatchingApprover(), transport: transport)
    #expect(result.suggestion == "Want help?"); #expect(await transport.calls == 1)
}

@Test func stoppedGrantPreventsRelease() async throws {
    let grants = GrantStore(), transport = FakeTransport(), coordinator = SuggestionCoordinator(grants: grants), origin = URL(string: "https://moa.example")!
    await grants.start(try ObservationGrant(process: process, mode: .trustedServer15m, issuedAt: now, expiresAt: now.addingTimeInterval(900), destinationOrigin: origin)); await grants.stop(); await coordinator.cancel()
    await #expect(throws: MoaMacError.invalidGrant) { try await coordinator.suggest(observation: observation(), process: process, origin: origin, token: "token", now: { now }, transport: transport) }
    #expect(await transport.calls == 0)
}

@Test func focusChangeBeforeApprovalOrAfterAwaitPreventsSendOrAcceptance() async throws {
    let origin = URL(string: "https://moa.example")!, grants = GrantStore(), transport = FakeTransport(), coordinator = SuggestionCoordinator(grants: grants)
    await grants.start(try ObservationGrant(process: process, mode: .askEachTime, issuedAt: now, expiresAt: now.addingTimeInterval(900), destinationOrigin: origin))
    await #expect(throws: MoaMacError.scopeChanged) { try await coordinator.suggest(observation: observation(), process: process, origin: origin, token: "t", now: { now }, approver: MatchingApprover(), transport: transport, scope: SequenceScope([false])) }
    #expect(await transport.calls == 0)
    await #expect(throws: MoaMacError.scopeChanged) { try await coordinator.suggest(observation: observation(), process: process, origin: origin, token: "t", now: { now }, approver: MatchingApprover(), transport: transport, scope: SequenceScope([true, false])) }
    #expect(await transport.calls == 0)
    await #expect(throws: MoaMacError.scopeChanged) { try await coordinator.suggest(observation: observation(), process: process, origin: origin, token: "t", now: { now }, approver: MatchingApprover(), transport: transport, scope: SequenceScope([true, true, false])) }
    #expect(await transport.calls == 0)
    await #expect(throws: MoaMacError.scopeChanged) { try await coordinator.suggest(observation: observation(), process: process, origin: origin, token: "t", now: { now }, approver: MatchingApprover(), transport: transport, scope: SequenceScope([true, true, true, false])) }
    #expect(await transport.calls == 1)
}

@Test func sameTitleWindowIDSwitchFailsBeforeSend() async throws {
    let origin = URL(string: "https://moa.example")!, grants = GrantStore(), transport = FakeTransport(), coordinator = SuggestionCoordinator(grants: grants)
    await grants.start(try ObservationGrant(process: process, mode: .trustedServer15m, issuedAt: now, expiresAt: now.addingTimeInterval(900), destinationOrigin: origin))
    await #expect(throws: MoaMacError.scopeChanged) { try await coordinator.suggest(observation: observation(), process: process, origin: origin, token: "t", now: { now }, transport: transport, scope: ExactWindowScope(current: 8), focusedWindowID: 7) }
    #expect(await transport.calls == 0)
}

@Test func immediatePauseRevokesGrantBeforeReturningAndRequiresNewStart() async throws {
    let grants = GrantStore(), grant = try ObservationGrant(process: process, mode: .localOnly, issuedAt: now, expiresAt: now.addingTimeInterval(900))
    await grants.start(grant); await grants.stop()
    await #expect(throws: MoaMacError.invalidGrant) { try await grants.current(now: now.addingTimeInterval(1), process: process) }
}

@Test func grantPeekAndExpiryAreObservableAndSelfRevoking() async throws {
    let grants = GrantStore()
    #expect(await grants.peek() == nil)
    let grant = try ObservationGrant(process: process, mode: .localOnly, issuedAt: now, expiresAt: now.addingTimeInterval(1))
    await grants.start(grant)
    #expect(await grants.peek() == grant)
    await #expect(throws: MoaMacError.expired) { try await grants.current(now: now.addingTimeInterval(2), process: process) }
    #expect(await grants.peek() == nil)
}

@Test(arguments: ["AXButton", "AXStaticText"])
func localSuggestionCoversButtonAndGenericWindows(role: String) async throws {
    let grants = GrantStore(), coordinator = SuggestionCoordinator(grants: grants)
    await grants.start(try ObservationGrant(process: process, mode: .localOnly, issuedAt: now, expiresAt: now.addingTimeInterval(900)))
    let value = Observation(observationID: "obs-\(role)", capturedAt: now,
        app: .init(bundleID: process.bundleID, name: "Editor"), window: .init(title: "Document"),
        ax: .init(nodes: [.init(id: "n", parentID: nil, role: role, subrole: nil, label: nil,
                               enabled: true, focused: false, actions: [])], truncated: false, dropped: 0),
        screenshot: nil)
    let result = try await coordinator.suggest(observation: value, process: process, origin: nil, token: nil, now: { now })
    #expect(!result.suggestion.isEmpty)
}

#if os(macOS)
private struct StaticConnectionStore: GatewayConnectionStore {
    let origin: String
    let token: String
    func loadOrigin() -> String { origin }
    func loadToken() -> String { token }
    func loadSessionID() -> String { "mac-test-session" }
    func save(origin: String, token: String) throws {}
}

private actor FakeChatSender: GatewayChatSending {
    private(set) var bodies: [Data] = []
    func send(_ request: GatewayChatRequest, bearerToken: String) async throws -> GatewayChatReply {
        bodies.append(request.body)
        return GatewayChatReply(text: "A bounded reply")
    }
}

@MainActor @Test func commandModelSendsOneInertTurnAndPreservesGatewayOnlyBoundary() async throws {
    let sender = FakeChatSender()
    let model = CommandModel(store: StaticConnectionStore(origin: "https://moa.example", token: "gateway-token"), sender: sender)
    #expect(model.isConfigured)
    model.prompt = "Help with this"
    await model.submit()
    #expect(model.reply == "A bounded reply")
    #expect(model.prompt.isEmpty)
    #expect(model.status == "Reply received")
    let bodies = await sender.bodies
    #expect(bodies.count == 1)
    let bodyText = String(decoding: try #require(bodies.first), as: UTF8.self)
    #expect(!bodyText.contains("screen"))
    #expect(!bodyText.contains("gateway-token"))
    _ = CommandPaletteView(model: model).body
}

@MainActor @Test func macShellSafeStoppedControlsRemainInert() async {
    let model = SurfaceModel()
    #expect(model.paused)
    model.resume()
    await model.pause()
    await model.stop()
    model.selectFrontmost()
    await model.start()
    _ = StatusView().body
}


@Test func nativeAdaptersFailClosedWithoutAValidTarget() async throws {
    #expect(ProcessInspector.signingIdentity(pid: ProcessInfo.processInfo.processIdentifier) != nil)
    _ = ProcessInspector.identity(.current)

    let session = AXSession(pid: -1, changed: {})
    #expect(throws: (any Error).self) { try session.start() }
    session.schedule()
    session.schedule()
    try await Task.sleep(for: .milliseconds(400))
    session.stop()
    let captured = AXCapture.snapshot(pid: -1)
    #expect(captured.0.nodes.isEmpty)

    let scope = WorkspaceScope()
    #expect(await scope.validate(process: process, observation: observation(), focusedWindowID: nil) == false)

    let preview = try RequestPreview(origin: URL(string: "http://127.0.0.1:1")!, mode: .trustedServer15m,
                                     observation: observation())
    await #expect(throws: (any Error).self) {
        try await EphemeralTransport().send(preview: preview, bearerToken: "test-token")
    }
    let redirect = NoRedirectDelegate()
    let redirectURL = URL(string: "https://example.test/redirect")!
    let redirectTask = URLSession.shared.dataTask(with: redirectURL)
    let redirectResponse = try #require(HTTPURLResponse(url: redirectURL, statusCode: 302,
                                                       httpVersion: "HTTP/1.1", headerFields: ["Location": "/next"]))
    var followed: URLRequest? = URLRequest(url: redirectURL)
    redirect.urlSession(.shared, task: redirectTask, willPerformHTTPRedirection: redirectResponse,
                        newRequest: URLRequest(url: redirectURL)) { followed = $0 }
    #expect(followed == nil)

    let element = AXUIElementCreateApplication(-1)
    var nodes: [AXNode] = [], dropped = 0
    AXCapture.walk(element, parent: nil, depth: 0, nodes: &nodes, dropped: &dropped)
    #expect(nodes.count == 1)
    AXCapture.walk(element, parent: nil, depth: ObservationBounds.maxDepth + 1, nodes: &nodes, dropped: &dropped)
    #expect(dropped == 1)
    #expect(AXCapture.string(element, kAXTitleAttribute) == nil)
}

@MainActor @Test func accessibilityCaptureTraversesAnOwnedTestWindowWhenAvailable() async throws {
    let app = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 180),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "Coverage Window"
    let field = NSTextField(string: "Draft")
    field.frame = NSRect(x: 20, y: 80, width: 200, height: 24)
    let button = NSButton(title: "Continue", target: nil, action: nil)
    button.frame = NSRect(x: 20, y: 40, width: 100, height: 28)
    window.contentView?.addSubview(field)
    window.contentView?.addSubview(button)
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    defer { window.orderOut(nil) }
    try await Task.sleep(for: .milliseconds(100))
    let captured = AXCapture.snapshot(pid: ProcessInfo.processInfo.processIdentifier)
    #expect(captured.1.isEmpty || captured.1 == "Coverage Window")

    let identity = ProcessIdentity(bundleID: "test.coverage", pid: ProcessInfo.processInfo.processIdentifier,
                                   processStart: NSRunningApplication.current.launchDate ?? now, signingIdentity: "test:coverage")
    let model = SurfaceModel(selectedIdentity: identity, appName: "Coverage App")
    model.saveToken()
    #expect(model.status == "Gateway connection save failed")
    model.mode = .askEachTime
    model.origin = "http://not-loopback.example"
    await model.start()
    #expect(!model.status.isEmpty)
    model.mode = .localOnly
    await model.start()
    try await Task.sleep(for: .milliseconds(450))
    await model.stop()
    #expect(model.paused)
}
#endif
