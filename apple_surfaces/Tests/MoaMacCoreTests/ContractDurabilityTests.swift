#if os(macOS)
import Foundation
import Testing
@testable import MoaMacCore
@testable import MoaMacShell

private let contractNow = Date(timeIntervalSince1970: 1_768_492_800.123)

private func contractEnvelope(sessionID: String = "session-a",
                              approval: String = "preauthorized") -> MacLocalProgramEnvelope {
    let advertisement = MacLocalProgramAdvertisement(deviceID: "mac-contract", issuedAt: contractNow,
        expiresAt: contractNow.addingTimeInterval(300))
    let source = "return 1;"
    return MacLocalProgramEnvelope(executionID: "exec-contract", sessionID: sessionID,
        turnID: "turn-a", target: advertisement.target, runtime: advertisement.runtime,
        program: .init(source: source, sha256: MacLocalProgramEnvelope.sourceDigest(source)),
        catalog: .init(version: advertisement.catalog.version, sha256: advertisement.catalog.sha256,
            allowedCapabilityIDs: ["macos.app.current"]),
        bindings: .init(localGrantID: "grant-a", bundleID: "com.example.fixture", pid: 42,
            processGeneration: "generation-a", signingIdentity: "signing-a", windowID: "window-a",
            axSnapshotID: "snapshot-a", stateSHA256: String(repeating: "a", count: 64)),
        limits: .init(sourceBytes: 65_536, wallMS: 5_000, memoryBytes: nil, toolCalls: 10,
            parallelCalls: 1, resultBytes: 65_536, logBytes: 0),
        approvalPolicy: .init(program: approval, alwaysAsk: []), idempotencyKey: "idem-contract",
        issuedAt: contractNow, expiresAt: contractNow.addingTimeInterval(60))
}

private func durabilityJournal(_ name: String) throws -> AtomicFileMacProgramJournal {
    try AtomicFileMacProgramJournal(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("\(name)-\(UUID().uuidString).json"))
}

@Test func canonicalTimestampAndReceivedProposalDigestAreExact() throws {
    let envelope = contractEnvelope()
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = MacProtocolTimestamp.encodingStrategy
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(envelope)
    let text = String(decoding: data, as: UTF8.self)
    #expect(text.contains("2026-01-15T16:00:00.123Z"))
    let decoded = try MacLocalProgramEnvelope.decodeStrict(data)
    #expect(decoded.receivedCanonicalSHA256 == MacLocalProgramDigest.data(
        try MacCanonicalJSON.parse(data).canonicalData))

    let noncanonical = Data(text.replacingOccurrences(of: ".123Z", with: ".123+00:00").utf8)
    #expect(throws: LocalProgramError.invalidEnvelope) {
        try MacLocalProgramEnvelope.decodeStrict(noncanonical)
    }
}

@Test func replayRequiresTheCompleteCanonicalProposalIdentity() throws {
    let journal = try durabilityJournal("moa-replay-identity")
    let original = contractEnvelope()
    #expect(try journal.claim(original, claimantDeviceID: "mac-contract",
        clientInstanceID: "client-a", at: contractNow) == .accepted)
    let altered = contractEnvelope(sessionID: "session-b")
    #expect(throws: LocalProgramError.replayed) {
        try journal.claim(altered, claimantDeviceID: "mac-contract",
            clientInstanceID: "client-a", at: contractNow)
    }
    #expect(throws: LocalProgramError.replayed) {
        try journal.reject(altered, claimantDeviceID: "mac-contract",
            clientInstanceID: "client-a", at: contractNow)
    }
}

@Test func preacceptRejectionIsDurableAndTerminalAtSequenceOne() throws {
    let journal = try durabilityJournal("moa-durable-reject")
    let envelope = contractEnvelope(approval: "approval_required")
    let rejected = try journal.reject(envelope, claimantDeviceID: "mac-contract",
        clientInstanceID: "client-a", at: contractNow)
    #expect(rejected.status == "rejected")
    let events = try journal.events(executionID: envelope.executionID)
    #expect(events.map(\.sequence) == [1])
    #expect(events.map(\.kind) == ["terminal"])
    #expect(try journal.terminalReceipt(executionID: envelope.executionID)?.hasValidDigest == true)
}

@Test func boundedRunnerProgressIsPersistedAsLifecycleEvidence() throws {
    let journal = try durabilityJournal("moa-progress")
    let envelope = contractEnvelope()
    _ = try journal.claim(envelope, claimantDeviceID: "mac-contract",
        clientInstanceID: "client-a", at: contractNow)
    try journal.markStarted(executionID: envelope.executionID, at: contractNow)
    try journal.recordProgress(executionID: envelope.executionID,
        message: "Processed local items.", completed: 1, total: 2,
        at: contractNow.addingTimeInterval(0.001))
    let events = try journal.events(executionID: envelope.executionID)
    #expect(events.map(\.kind) == ["accepted", "started", "progress"])
    if case .progress(let message, let completed, let total) = events.last?.payload {
        #expect(message == "Processed local items.")
        #expect(completed == 1); #expect(total == 2)
    } else { Issue.record("expected progress payload") }
}

@Test func approvalResolutionIsBoundAndCannotBeLateOrReused() throws {
    let journal = try durabilityJournal("moa-approval-binding")
    let envelope = contractEnvelope()
    _ = try journal.claim(envelope, claimantDeviceID: "mac-contract",
        clientInstanceID: "client-a", at: contractNow)
    try journal.markStarted(executionID: envelope.executionID, at: contractNow)
    let pending = MacProgramPendingTool(toolCallID: "call-a", capabilityID: "macos.accessibility.press",
        inputSHA256: String(repeating: "b", count: 64), preStateSHA256: envelope.bindings.stateSHA256,
        effectClass: "external_side_effect", sequence: 1, startedAt: contractNow)
    try journal.beginTool(executionID: envelope.executionID, pending: pending)
    let expiry = contractNow.addingTimeInterval(10)
    try journal.requireApproval(executionID: envelope.executionID, approvalID: "approval-a",
        effectClass: pending.effectClass, capabilityID: pending.capabilityID,
        toolCallID: pending.toolCallID, expiresAt: expiry, at: contractNow)
    #expect(throws: LocalProgramError.replayed) {
        try journal.resolveApproval(executionID: envelope.executionID, approvalID: "approval-a",
            status: "approved", at: expiry)
    }
    try journal.resolveApproval(executionID: envelope.executionID, approvalID: "approval-a",
        status: "expired", at: expiry)
    #expect(throws: LocalProgramError.replayed) {
        try journal.resolveApproval(executionID: envelope.executionID, approvalID: "approval-a",
            status: "expired", at: expiry)
    }
}
#endif
