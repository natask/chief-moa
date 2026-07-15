import Foundation
import Testing
@testable import AggieAppleSurface

private let surface = SurfaceIdentity(id: "moa-apple", kind: .macOS, mode: .text, deviceID: "dev-1")
private let timestamp = Date(timeIntervalSince1970: 1_700_000_000)

private func proposalData(overrides: [String: Any] = [:]) throws -> Data {
    var value: [String: Any] = [
        "version": 2, "type": "action.proposed", "message_id": "msg-1", "session_id": "sess-1",
        "surface": ["id": "moa-apple", "kind": "macos", "mode": "text", "device_id": "dev-1"],
        "timestamp": ISO8601DateFormatter().string(from: timestamp),
        "payload": ["proposal_id": "prop-1", "kind": "open_url", "approval_class": "confirm",
                    "expires_at": ISO8601DateFormatter().string(from: timestamp.addingTimeInterval(60)),
                    "preconditions": ["screen": "home"], "params": ["url": "https://example.com"]]
    ]
    for (key, item) in overrides { value[key] = item }
    return try JSONSerialization.data(withJSONObject: value)
}

private actor Counter { var value = 0; func increment() { value += 1 } }
private struct State: LocalStateProvider { let values: [[String: JSONValue]]; let counter: Counter
    func currentState() async throws -> [String: JSONValue] { let index = await counter.value; await counter.increment(); return values[min(index, values.count - 1)] }
}
private struct Executor: LocalActionExecutor { let counter: Counter; func execute(_ proposal: ProposalEnvelope) async throws { await counter.increment() } }
private struct FailingExecutor: LocalActionExecutor { let counter: Counter; func execute(_ proposal: ProposalEnvelope) async throws { await counter.increment(); throw AggieProtocolError.malformed("uncertain effect") } }
private struct Approver: LocalApprovalPrompt {
    let approved: Bool; let surface: SurfaceIdentity; let session: String; let time: Date
    func requestApproval(for proposal: ProposalEnvelope, digest: String) async throws -> LocalApproval {
        LocalApproval(approvalID: "approval-1", proposalID: proposal.payload.proposalID,
            proposalMessageID: proposal.messageID, proposalDigest: digest, sessionID: session,
            surface: surface, actorID: "local-user", decidedAt: time, approved: approved)
    }
}

@Test func negotiatesOnlyNAndNMinusOne() throws {
    #expect(try AggieEnvelopeDecoder.negotiate([99, 1]) == 1)
    #expect(try AggieEnvelopeDecoder.negotiate([1, 2]) == 2)
    #expect(throws: AggieProtocolError.unsupportedVersion) { try AggieEnvelopeDecoder.negotiate([99]) }
}

@Test func decoderRejectsSecretsExecutablesAndOversize() throws {
    let payload = ["proposal_id": "prop-1", "kind": "open_url", "approval_class": "confirm",
                   "expires_at": ISO8601DateFormatter().string(from: timestamp.addingTimeInterval(60)),
                   "preconditions": [:], "params": ["oauth_token": "secret"]] as [String: Any]
    #expect(throws: AggieProtocolError.dangerousPayload) { try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: ["payload": payload])) }
    #expect(throws: AggieProtocolError.dangerousPayload) { try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: ["future": ["shell": "echo bad"]])) }
    for key in ["token_value", "authorization_hint", "client_secret_material"] {
        #expect(throws: AggieProtocolError.dangerousPayload) { try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: ["future": [key: "innocuous"]])) }
    }
    #expect(throws: AggieProtocolError.dangerousPayload) { try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: ["future": "Bearer abcdefghijklmnopqrstuvwxyz"])) }
    #expect(throws: AggieProtocolError.dangerousPayload) { try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: ["future": "github_pat_abcdefghijklmnopqrstuvwxyz123456"])) }
    #expect(throws: AggieProtocolError.tooLarge) { try AggieEnvelopeDecoder.decodeProposal(Data(repeating: 0x20, count: AggieLimits.envelopeBytes + 1)) }
}

@Test func mirrorsGatewayEnumsPreconditionsAndDigest() throws {
    let proposal = try AggieEnvelopeDecoder.decodeProposal(proposalData())
    #expect(try AggieDigest.proposal(proposal) == "ef5cb445055779eaf372ae531c414cdab4aefbeb85aa6929f5068d63ca750632")
    var raw = try JSONSerialization.jsonObject(with: proposalData()) as! [String: Any]
    var payload = raw["payload"] as! [String: Any]; payload["preconditions"] = [:]; raw["payload"] = payload
    #expect(throws: AggieProtocolError.malformed("missing preconditions")) { try AggieEnvelopeDecoder.decodeProposal(JSONSerialization.data(withJSONObject: raw)) }
    var wrongSurface = raw; wrongSurface["payload"] = (try JSONSerialization.jsonObject(with: proposalData()) as! [String: Any])["payload"]
    wrongSurface["surface"] = ["id": "moa-apple", "kind": "apple", "mode": "text", "device_id": "dev-1"]
    #expect(throws: (any Error).self) { try AggieEnvelopeDecoder.decodeProposal(JSONSerialization.data(withJSONObject: wrongSurface)) }
    var unknownAction = try JSONSerialization.jsonObject(with: proposalData()) as! [String: Any]
    var unknownPayload = unknownAction["payload"] as! [String: Any]
    unknownPayload["kind"] = "future_effect"; unknownAction["payload"] = unknownPayload
    #expect(throws: (any Error).self) { try AggieEnvelopeDecoder.decodeProposal(JSONSerialization.data(withJSONObject: unknownAction)) }
}

@Test func rejectsUnsafeCanonicalNumbers() throws {
    for number in [9_007_199_254_740_992.0, -0.0] {
        var raw = try JSONSerialization.jsonObject(with: proposalData()) as! [String: Any]
        var payload = raw["payload"] as! [String: Any]
        payload["params"] = ["unsafe": number]; raw["payload"] = payload
        #expect(throws: (any Error).self) {
            try AggieEnvelopeDecoder.decodeProposal(JSONSerialization.data(withJSONObject: raw))
        }
    }
}

@Test func explicitApprovalExecutesOnceAndReceiptsBindings() async throws {
    let proposal = try AggieEnvelopeDecoder.decodeProposal(proposalData())
    let effects = Counter(); let stateCounter = Counter(); let coordinator = AppleActionCoordinator()
    let receipt = try await coordinator.handle(proposal, expectedSession: "sess-1", expectedSurface: surface,
        now: { timestamp.addingTimeInterval(30) }, approver: Approver(approved: true, surface: surface, session: "sess-1", time: timestamp.addingTimeInterval(10)),
        state: State(values: [["screen": .string("home")]], counter: stateCounter), executor: Executor(counter: effects))
    #expect(await effects.value == 1); #expect(receipt.proposalMessageID == proposal.messageID); #expect(receipt.surface == surface)
    await #expect(throws: AggieProtocolError.duplicateProposal) {
        try await coordinator.handle(proposal, expectedSession: "sess-1", expectedSurface: surface,
            now: { timestamp.addingTimeInterval(30) }, approver: Approver(approved: true, surface: surface, session: "sess-1", time: timestamp.addingTimeInterval(10)),
            state: State(values: [["screen": .string("home")]], counter: Counter()), executor: Executor(counter: effects))
    }
    #expect(await effects.value == 1)
}

@Test(arguments: ["denied", "scope", "stale", "expired"])
func denialPathsNeverInvokeExecutor(kind: String) async throws {
    let proposal = try AggieEnvelopeDecoder.decodeProposal(proposalData())
    let effects = Counter(); let stateCounter = Counter(); let coordinator = AppleActionCoordinator()
    let approvalSurface = kind == "scope" ? SurfaceIdentity(id: "moa-apple", kind: .macOS, mode: .voice, deviceID: "dev-1") : surface
    let states: [[String: JSONValue]] = kind == "stale" ? [["screen": .string("home")], ["screen": .string("changed")]] : [["screen": .string("home")]]
    await #expect(throws: (any Error).self) {
        try await coordinator.handle(proposal, expectedSession: "sess-1", expectedSurface: surface,
            now: { kind == "expired" ? timestamp.addingTimeInterval(120) : timestamp.addingTimeInterval(30) },
            approver: Approver(approved: kind != "denied", surface: approvalSurface, session: "sess-1", time: timestamp.addingTimeInterval(10)),
            state: State(values: states, counter: stateCounter), executor: Executor(counter: effects))
    }
    #expect(await effects.value == 0)
}

@Test func replayAndBackoffAreBounded() throws {
    var replay = SessionReplay(sessionID: "sess-1")
    for index in 1...300 { _ = try replay.accept(ReplayEvent(sequence: index, messageID: "msg-\(index)", sessionID: "sess-1", canonicalEnvelope: Data(repeating: UInt8(index % 255), count: 16))) }
    #expect(replay.count == AggieLimits.replayEvents)
    #expect(try reconnectDelay(attempt: 99, entropy: 1) == 30_000)
}

@Test func uncertainEffectCannotBeRetried() async throws {
    let proposal = try AggieEnvelopeDecoder.decodeProposal(proposalData())
    let effects = Counter(); let coordinator = AppleActionCoordinator()
    let call: () async throws -> LocalActionReceipt = {
        try await coordinator.handle(proposal, expectedSession: "sess-1", expectedSurface: surface,
            now: { timestamp.addingTimeInterval(30) }, approver: Approver(approved: true, surface: surface, session: "sess-1", time: timestamp.addingTimeInterval(10)),
            state: State(values: [["screen": .string("home")]], counter: Counter()), executor: FailingExecutor(counter: effects))
    }
    await #expect(throws: (any Error).self) { try await call() }
    await #expect(throws: AggieProtocolError.duplicateProposal) { try await call() }
    #expect(await effects.value == 1)
}

@Test func uncertainEffectCannotBeRetriedAfterRestart() async throws {
    let proposal = try AggieEnvelopeDecoder.decodeProposal(proposalData())
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let url = directory.appendingPathComponent("effect-journal.json")
    defer { try? FileManager.default.removeItem(at: directory) }
    let effects = Counter()
    let first = AppleActionCoordinator(journal: AtomicFileEffectJournal(url: url))
    await #expect(throws: (any Error).self) {
        try await first.handle(proposal, expectedSession: "sess-1", expectedSurface: surface,
            now: { timestamp.addingTimeInterval(30) },
            approver: Approver(approved: true, surface: surface, session: "sess-1", time: timestamp.addingTimeInterval(10)),
            state: State(values: [["screen": .string("home")]], counter: Counter()),
            executor: FailingExecutor(counter: effects))
    }
    let restarted = AppleActionCoordinator(journal: AtomicFileEffectJournal(url: url))
    #expect(try await restarted.recoveryStatus(for: proposal.messageID) == .unknownEffect)
    await #expect(throws: AggieProtocolError.duplicateProposal) {
        try await restarted.handle(proposal, expectedSession: "sess-1", expectedSurface: surface,
            now: { timestamp.addingTimeInterval(30) },
            approver: Approver(approved: true, surface: surface, session: "sess-1", time: timestamp.addingTimeInterval(10)),
            state: State(values: [["screen": .string("home")]], counter: Counter()),
            executor: Executor(counter: effects))
    }
    #expect(await effects.value == 1)
}

@Test func effectClaimIsExclusiveAcrossJournalInstances() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let url = directory.appendingPathComponent("effect-journal.json")
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = AtomicFileEffectJournal(url: url), second = AtomicFileEffectJournal(url: url)
    try first.record(.unknownEffect, for: "msg-claim")
    #expect(throws: AggieProtocolError.duplicateProposal) { try second.record(.unknownEffect, for: "msg-claim") }
    #expect(try second.status(for: "msg-claim") == .unknownEffect)
}

@Test func jsonValueRoundTripsEveryCanonicalShape() throws {
    let values: [JSONValue] = [
        .null, .bool(true), .number(1.5), .string("value"),
        .array([.number(2), .null]), .object(["nested": .bool(false)]),
    ]
    for value in values {
        let encoded = try JSONEncoder().encode(value)
        #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == value)
    }
    #expect(throws: (any Error).self) { try JSONDecoder().decode(JSONValue.self, from: Data("1e999".utf8)) }
}

@Test func decoderRejectsMalformedTypesIdentifiersAndDeepOrWidePayloads() throws {
    for overrides: [String: Any] in [
        ["version": 3], ["type": "turn.text"], ["message_id": "bad id"],
        ["session_id": ""], ["surface": ["id": "bad/id", "kind": "macos", "mode": "text"]],
    ] {
        #expect(throws: (any Error).self) { try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: overrides)) }
    }
    var deep: Any = "safe"
    for _ in 0..<14 { deep = ["nested": deep] }
    #expect(throws: AggieProtocolError.dangerousPayload) {
        try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: ["future": deep]))
    }
    #expect(throws: AggieProtocolError.tooLarge) {
        try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: ["future": Array(repeating: "x", count: 65)]))
    }
    #expect(throws: AggieProtocolError.tooLarge) {
        try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: ["future": String(repeating: "x", count: 16_385)]))
    }
    #expect(throws: AggieProtocolError.dangerousPayload) {
        try AggieEnvelopeDecoder.decodeProposal(proposalData(overrides: ["future": "unsafe\u{1}text"]))
    }
}

@Test func journalsEnforceTerminalAndCapacityBounds() throws {
    let memory = InMemoryEffectJournal()
    try memory.record(.knownSucceeded, for: "terminal")
    #expect(try memory.status(for: "missing") == .notStarted)
    #expect(throws: AggieProtocolError.duplicateProposal) { try memory.record(.notStarted, for: "terminal") }
    for index in 0..<(AggieLimits.pendingProposals - 1) { try memory.record(.knownFailed, for: "msg-\(index)") }
    #expect(throws: AggieProtocolError.tooLarge) { try memory.record(.knownFailed, for: "overflow") }

    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let url = directory.appendingPathComponent("journal.json")
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data(repeating: 0x20, count: AggieLimits.replayBytes + 1).write(to: url)
    #expect(throws: AggieProtocolError.tooLarge) { try AtomicFileEffectJournal(url: url).status(for: "msg") }
}

@Test func replayDetectsDuplicatesConflictsGapsAndBadScope() throws {
    var replay = SessionReplay(sessionID: "sess-1")
    let first = ReplayEvent(sequence: 1, messageID: "msg-1", sessionID: "sess-1", canonicalEnvelope: Data("one".utf8))
    #expect(try replay.accept(first).accepted)
    #expect(try replay.accept(first).duplicate)
    #expect(throws: AggieProtocolError.sequenceConflict) {
        try replay.accept(ReplayEvent(sequence: 1, messageID: "msg-other", sessionID: "sess-1", canonicalEnvelope: Data("two".utf8)))
    }
    #expect(throws: AggieProtocolError.messageConflict) {
        try replay.accept(ReplayEvent(sequence: 2, messageID: "msg-1", sessionID: "sess-1", canonicalEnvelope: Data("two".utf8)))
    }
    #expect(throws: AggieProtocolError.sequenceGap) {
        try replay.accept(ReplayEvent(sequence: 3, messageID: "msg-3", sessionID: "sess-1", canonicalEnvelope: Data("three".utf8)))
    }
    #expect(throws: AggieProtocolError.scopeMismatch) {
        try replay.accept(ReplayEvent(sequence: 2, messageID: "msg-2", sessionID: "other", canonicalEnvelope: Data("two".utf8)))
    }
    for event in [
        ReplayEvent(sequence: 0, messageID: "msg", sessionID: "sess-1", canonicalEnvelope: Data("x".utf8)),
        ReplayEvent(sequence: 2, messageID: "bad id", sessionID: "sess-1", canonicalEnvelope: Data("x".utf8)),
    ] { #expect(throws: (any Error).self) { try replay.accept(event) } }
    #expect(throws: AggieProtocolError.malformed("backoff")) { try reconnectDelay(attempt: -1, entropy: 0) }
    #expect(throws: AggieProtocolError.malformed("backoff")) { try reconnectDelay(attempt: 1, entropy: 2) }
}

@Test func canonicalDigestHandlesArraysBooleansNullAndFractionalNumbers() throws {
    var raw = try JSONSerialization.jsonObject(with: proposalData()) as! [String: Any]
    var payload = raw["payload"] as! [String: Any]
    payload["params"] = ["values": [true, NSNull(), 1.5, "slash\\quote\""]]
    raw["payload"] = payload
    let proposal = try AggieEnvelopeDecoder.decodeProposal(JSONSerialization.data(withJSONObject: raw))
    #expect(try AggieDigest.proposal(proposal).count == 64)
}
