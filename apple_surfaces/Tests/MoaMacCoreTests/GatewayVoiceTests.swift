import Foundation
import MoaMacCore
import Testing

#if os(macOS)
import MoaMacShell
#endif

@Test func voiceSessionStartTargetsConfiguredGatewayAndDeclaresLiteralPCM() throws {
    let secure = try GatewayVoiceSessionStart(
        origin: #require(URL(string: "https://moa.example")),
        sessionID: "mac-session",
        turnID: "turn-one"
    )
    #expect(secure.endpoint.absoluteString == "wss://moa.example/v1/voice/sessions")
    let body = try #require(JSONSerialization.jsonObject(with: secure.body) as? [String: Any])
    #expect(body["type"] as? String == "session_start")
    #expect(body["source"] as? String == "moa-macos")
    #expect(body["session_id"] as? String == "mac-session")
    #expect(body["conversation_id"] as? String == "mac-session")
    #expect(body["turn_id"] as? String == "turn-one")
    #expect(body["delivery_intent"] as? String == "literal_text")
    #expect(body["screen"] == nil)
    #expect(body["ax"] == nil)
    let format = try #require(body["format"] as? [String: Any])
    #expect(format["encoding"] as? String == "pcm16")
    #expect(format["sample_rate"] as? Int == 16_000)
    #expect(format["channels"] as? Int == 1)

    let loopback = try GatewayVoiceSessionStart(
        origin: #require(URL(string: "http://127.0.0.1:8787")),
        sessionID: "s",
        turnID: "t"
    )
    #expect(loopback.endpoint.absoluteString == "ws://127.0.0.1:8787/v1/voice/sessions")
    #expect(throws: MoaMacError.invalidDestination) {
        try GatewayVoiceSessionStart(origin: URL(string: "http://remote.example")!, sessionID: "s", turnID: "t")
    }
    #expect(throws: GatewayVoiceError.eventTooLarge) {
        try GatewayVoiceSessionStart(
            origin: URL(string: "https://moa.example")!,
            sessionID: String(repeating: "s", count: GatewayVoiceSessionStart.maximumEventBytes),
            turnID: "t"
        )
    }
}

@Test func voiceCommitAndCancelEventsBindTheTurn() throws {
    let commit = try #require(JSONSerialization.jsonObject(with: GatewayVoiceClientEvent.commit(turnID: "turn-1")) as? [String: String])
    #expect(commit == ["type": "commit_turn", "turn_id": "turn-1"])
    let cancel = try #require(JSONSerialization.jsonObject(with: GatewayVoiceClientEvent.cancel(turnID: "turn-1")) as? [String: String])
    #expect(cancel == ["type": "cancel_turn", "turn_id": "turn-1"])
    #expect(throws: GatewayVoiceError.eventTooLarge) {
        try GatewayVoiceClientEvent.commit(turnID: String(repeating: "t", count: GatewayVoiceSessionStart.maximumEventBytes))
    }
}

@Test func pcmFramesEnforceExactConservativeTransportBoundary() throws {
    let exact = Data(repeating: 0x7f, count: GatewayVoiceAudioFrame.maximumBytes)
    #expect(try GatewayVoiceAudioFrame(exact).data == exact)
    #expect(throws: GatewayVoiceError.audioFrameTooLarge) {
        try GatewayVoiceAudioFrame(Data(repeating: 0, count: GatewayVoiceAudioFrame.maximumBytes + 2))
    }
    #expect(throws: GatewayVoiceError.invalidAudioFrame) {
        try GatewayVoiceAudioFrame(Data(repeating: 0, count: 3))
    }
    #expect(throws: GatewayVoiceError.emptyAudioFrame) {
        try GatewayVoiceAudioFrame(Data())
    }
}

@Test(arguments: [
    (#"{"type":"session_ready"}"#, GatewayVoiceServerEvent.sessionReady),
    (#"{"type":"transcript_partial","text":"  hello  "}"#, .transcriptPartial("hello")),
    (#"{"type":"transcript_final","text":"finished"}"#, .transcriptFinal("finished")),
    (#"{"type":"turn_done","status":"completed"}"#, .turnDone(status: "completed", reason: nil)),
    (#"{"type":"turn_done","status":"no_speech","reason":"stt_empty"}"#, .turnDone(status: "no_speech", reason: "stt_empty")),
    (#"{"type":"error","message":"provider unavailable"}"#, .failure("provider unavailable")),
    (#"{"type":"assistant_text","text":"ignored"}"#, .ignored),
])
func voiceServerEventsAreBoundedAndTyped(fixture: (String, GatewayVoiceServerEvent)) throws {
    #expect(try GatewayVoiceServerEventDecoder.decode(Data(fixture.0.utf8)) == fixture.1)
}

@Test func voiceServerEventDecoderRejectsMalformedOrOversizedContent() {
    #expect(throws: GatewayVoiceError.invalidEvent) {
        try GatewayVoiceServerEventDecoder.decode(Data("[]".utf8))
    }
    #expect(throws: GatewayVoiceError.invalidEvent) {
        try GatewayVoiceServerEventDecoder.decode(Data(#"{"type":"transcript_final","text":" "}"#.utf8))
    }
    #expect(throws: GatewayVoiceError.invalidEvent) {
        try GatewayVoiceServerEventDecoder.decode(Data(#"{"type":"turn_done"}"#.utf8))
    }
    #expect(throws: GatewayVoiceError.invalidEvent) {
        try GatewayVoiceServerEventDecoder.decode(Data(#"{"type":"error","message":""}"#.utf8))
    }
    let transcript = String(repeating: "a", count: GatewayVoiceServerEventDecoder.maximumTranscriptBytes + 1)
    let transcriptData = try! JSONSerialization.data(withJSONObject: ["type": "transcript_partial", "text": transcript])
    #expect(throws: GatewayVoiceError.transcriptTooLarge) {
        try GatewayVoiceServerEventDecoder.decode(transcriptData)
    }
    #expect(throws: GatewayVoiceError.eventTooLarge) {
        try GatewayVoiceServerEventDecoder.decode(Data(repeating: 0x20, count: GatewayVoiceServerEventDecoder.maximumEventBytes + 1))
    }
    let messageData = try! JSONSerialization.data(withJSONObject: ["type": "error", "message": transcript])
    #expect(throws: GatewayVoiceError.invalidEvent) {
        try GatewayVoiceServerEventDecoder.decode(messageData)
    }
}

@Test func transcriptStateShowsPartialFinalDenialInterruptionAndReset() {
    var state = VoiceTranscriptState()
    #expect(state.phase == .idle)
    #expect(!state.isActive)
    state.apply(.begin)
    #expect(state.phase == .requestingPermission)
    #expect(state.isActive)
    state.apply(.permissionGranted)
    #expect(state.phase == .connecting)
    state.apply(.server(.sessionReady))
    #expect(state.phase == .listening)
    state.apply(.server(.transcriptPartial("draft")))
    #expect(state.partial == "draft")
    state.apply(.release)
    #expect(state.phase == .finalizing)
    state.apply(.server(.transcriptFinal("exact final")))
    #expect(state.phase == .completed)
    #expect(state.final == "exact final")
    #expect(state.partial.isEmpty)
    state.apply(.server(.transcriptPartial("late")))
    #expect(state.partial.isEmpty)
    state.apply(.server(.turnDone(status: "completed", reason: nil)))
    #expect(state.message == "Transcript ready")
    state.apply(.reset)
    #expect(state == VoiceTranscriptState())

    state.apply(.begin)
    state.apply(.permissionDenied)
    #expect(state.phase == .denied)
    state.apply(.begin)
    state.apply(.captureStarted)
    state.apply(.server(.turnDone(status: "no_speech", reason: "stt_empty")))
    #expect(state.phase == .interrupted)
    #expect(state.message == "No speech detected")
    state.apply(.begin)
    state.apply(.server(.failure("network fault")))
    #expect(state.phase == .failed)
    state.apply(.begin)
    state.apply(.server(.turnDone(status: "error", reason: "stt failed")))
    #expect(state.message == "stt failed")
    state.apply(.interrupted("capture stopped"))
    #expect(state.message == "capture stopped")
    state.apply(.failed("bad gateway"))
    #expect(state.phase == .failed)
    state.apply(.server(.ignored))
    #expect(state.message == "bad gateway")

    state.apply(.reset)
    state.apply(.permissionGranted)
    #expect(state.phase == .idle)
    state.apply(.captureStarted)
    #expect(state.phase == .idle)
    state.apply(.release)
    #expect(state.phase == .idle)
    state.apply(.server(.sessionReady))
    #expect(state.phase == .idle)
    state.apply(.begin)
    state.apply(.server(.turnDone(status: "completed", reason: nil)))
    #expect(state.phase == .requestingPermission)
    state.apply(.server(.turnDone(status: "error", reason: nil)))
    #expect(state.message == "Transcription interrupted")
}

#if os(macOS)
private struct StubPermission: MicrophonePermissionRequesting {
    let allowed: Bool
    func requestPermission() async -> Bool { allowed }
}

private final class StubMicrophone: PCM16MicrophoneCapturing, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var starts = 0
    private(set) var stops = 0
    private var handler: (@Sendable (Data) -> Void)?

    func start(handler: @escaping @Sendable (Data) -> Void) throws {
        lock.withLock { starts += 1; self.handler = handler }
    }

    func stop() {
        lock.withLock { stops += 1; handler = nil }
    }

    func emit(_ data: Data) { lock.withLock { handler?(data) } }
}

private actor StubVoiceTransport: GatewayVoiceTransporting {
    private(set) var starts: [GatewayVoiceSessionStart] = []
    private(set) var tokens: [String] = []
    private(set) var audio: [Data] = []
    private(set) var commits = 0
    private(set) var cancels = 0
    private var handler: (@MainActor @Sendable (GatewayVoiceServerEvent) -> Void)?

    func connect(start: GatewayVoiceSessionStart, bearerToken: String, turnID: String,
                 eventHandler: @escaping @MainActor @Sendable (GatewayVoiceServerEvent) -> Void) async throws {
        starts.append(start)
        tokens.append(bearerToken)
        handler = eventHandler
    }

    func sendAudio(_ data: Data) async throws { audio.append(data) }
    func commit() async throws { commits += 1 }
    func cancel() async { cancels += 1 }
    func emit(_ event: GatewayVoiceServerEvent) async { if let handler { await handler(event) } }
}

private struct VoiceTestConnectionStore: GatewayConnectionStore {
    func loadOrigin() -> String { "https://moa.example" }
    func loadSessionID() -> String { "mac-test-session" }
    func saveOrigin(_ origin: String) throws {}
}

private struct UnusedChatSender: GatewayChatSending {
    func send(_ request: GatewayChatRequest, bearerToken: String) async throws -> GatewayChatReply {
        GatewayChatReply(text: "unused")
    }
}

private struct StubHistoryLoader: GatewayHistoryLoading {
    func load(origin: URL, bearerToken: String, sessionID: String) async throws -> [GatewayHistoryEntry] {
        [
            GatewayHistoryEntry(
                id: "voice:session:turn",
                type: "voice_turn",
                source: "moa-macos",
                text: "durable fixture",
                assistantText: "",
                createdAt: "2026-07-25T00:00:00Z"
            ),
        ]
    }
}

@MainActor private final class StubCaptureController: VoiceCaptureControlling {
    var handler: (@MainActor @Sendable (GatewayVoiceServerEvent) -> Void)?
    var starts = 0
    var commits = 0
    var cancels = 0

    func start(origin: URL, bearerToken: String, sessionID: String, turnID: String,
               levelHandler: @escaping @MainActor @Sendable (Double) -> Void,
               eventHandler: @escaping @MainActor @Sendable (GatewayVoiceServerEvent) -> Void) async throws {
        starts += 1
        handler = eventHandler
        eventHandler(.sessionReady)
        eventHandler(.transcriptPartial("protected fixture phrase"))
    }

    func stopAndCommit() async throws {
        commits += 1
        handler?(.transcriptFinal("protected fixture phrase"))
        handler?(.turnDone(status: "completed", reason: nil))
    }

    func cancel() async { cancels += 1 }
}

@MainActor @Test func voiceControllerRequestsPermissionStreamsPCMAndCommits() async throws {
    let microphone = StubMicrophone()
    let transport = StubVoiceTransport()
    let controller = VoiceCaptureController(
        permission: StubPermission(allowed: true),
        microphone: microphone,
        transport: transport
    )
    var events: [GatewayVoiceServerEvent] = []
    try await controller.start(
        origin: URL(string: "https://moa.example")!,
        bearerToken: "gateway-token",
        sessionID: "session",
        turnID: "turn",
        levelHandler: { _ in }
    ) { events.append($0) }
    #expect(microphone.starts == 1)
    #expect(await transport.tokens == ["gateway-token"])
    microphone.emit(Data([0, 0, 1, 0]))
    try await Task.sleep(for: .milliseconds(20))
    #expect(await transport.audio == [Data([0, 0, 1, 0])])
    await transport.emit(.transcriptPartial("fixture phrase"))
    #expect(events == [.transcriptPartial("fixture phrase")])
    try await controller.stopAndCommit()
    #expect(microphone.stops == 1)
    #expect(await transport.commits == 1)
    await controller.cancel()
    #expect(await transport.cancels == 1)
}

@MainActor @Test func voiceControllerDenialStartsNoTransportOrMicrophone() async {
    let microphone = StubMicrophone()
    let transport = StubVoiceTransport()
    let controller = VoiceCaptureController(
        permission: StubPermission(allowed: false),
        microphone: microphone,
        transport: transport
    )
    await #expect(throws: VoiceCaptureError.microphoneDenied) {
        try await controller.start(
            origin: URL(string: "https://moa.example")!,
            bearerToken: "gateway-token",
            sessionID: "session",
            turnID: "turn",
            levelHandler: { _ in }
        ) { _ in }
    }
    #expect(microphone.starts == 0)
    #expect(await transport.starts.isEmpty)
    await #expect(throws: VoiceCaptureError.notActive) { try await controller.stopAndCommit() }
}

@Test func pcmLevelMeterIsBoundedAndTracksSilenceAndSignal() {
    #expect(VoiceLevelMeter.normalizedLevel(forPCM16: Data()) == 0)
    #expect(VoiceLevelMeter.normalizedLevel(forPCM16: Data([0, 0, 0, 0])) == 0)
    var samples = [Int16.max, Int16.min + 1]
    let loud = samples.withUnsafeBytes { Data($0) }
    #expect(VoiceLevelMeter.normalizedLevel(forPCM16: loud) == 1)
    samples = [1_000, -1_000]
    let quiet = samples.withUnsafeBytes { Data($0) }
    let value = VoiceLevelMeter.normalizedLevel(forPCM16: quiet)
    #expect(value > 0)
    #expect(value < 1)
}

@Test func urlSessionTransportRejectsBadPCMBeforeSocketLookup() async {
    let transport = URLSessionGatewayVoiceTransport()
    await #expect(throws: GatewayVoiceError.emptyAudioFrame) {
        try await transport.sendAudio(Data())
    }
    await #expect(throws: GatewayVoiceError.invalidAudioFrame) {
        try await transport.sendAudio(Data(repeating: 0, count: 3))
    }
    await #expect(throws: GatewayVoiceError.audioFrameTooLarge) {
        try await transport.sendAudio(Data(repeating: 0, count: GatewayVoiceAudioFrame.maximumBytes + 2))
    }
    await #expect(throws: VoiceCaptureError.notActive) {
        try await transport.sendAudio(Data(repeating: 0, count: GatewayVoiceAudioFrame.maximumBytes))
    }
}

@MainActor @Test func commandModelSummonStartsLatchedCaptureAndSecondSummonCommits() async {
    let capture = StubCaptureController()
    let model = CommandModel(
        store: VoiceTestConnectionStore(),
        sender: UnusedChatSender(),
        voiceController: capture
    )
    model.token = "gateway-token"
    await model.handleSummon()
    #expect(capture.starts == 1)
    #expect(model.voiceState.phase == .listening)
    #expect(model.voiceState.partial == "protected fixture phrase")
    #expect(model.prompt.isEmpty)
    await model.handleSummon()
    #expect(capture.commits == 1)
    #expect(model.voiceState.phase == .completed)
    #expect(model.voiceState.final == "protected fixture phrase")
    #expect(model.prompt.isEmpty)
    await model.cancelVoice()
    #expect(capture.cancels == 1)
}

@MainActor @Test func commandModelLoadsAuthenticatedSessionHistoryInPlace() async {
    let model = CommandModel(
        store: VoiceTestConnectionStore(),
        sender: UnusedChatSender(),
        historyLoader: StubHistoryLoader()
    )
    model.token = "gateway-token"
    await model.toggleHistory()
    #expect(model.isShowingHistory)
    #expect(model.historyEntries.map(\.text) == ["durable fixture"])
    #expect(model.historyStatus.isEmpty)
    await model.toggleHistory()
    #expect(!model.isShowingHistory)
}
#endif
