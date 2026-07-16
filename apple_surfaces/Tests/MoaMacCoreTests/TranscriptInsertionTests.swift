import Foundation
import MoaMacCore
import Testing

#if os(macOS)
import MoaMacShell
#endif

private let insertionNow = Date(timeIntervalSince1970: 1_800_000_000)
private let insertionProcess = ProcessIdentity(
    bundleID: "com.example.Editor",
    pid: 42,
    processStart: insertionNow.addingTimeInterval(-20),
    signingIdentity: "TEAM:com.example.Editor"
)

private func targetState(
    process: ProcessIdentity = insertionProcess,
    window: String = "window-digest",
    element: String = "element-digest",
    role: String = "AXTextArea",
    subrole: String? = nil,
    secure: Bool = false,
    settable: Bool = true,
    focused: Bool = true,
    value: String = "draft",
    selection: TranscriptSelection = .init(location: 5, length: 0)
) -> TranscriptTargetState {
    TranscriptTargetState(
        process: process,
        windowFingerprint: window,
        elementFingerprint: element,
        role: role,
        subrole: subrole,
        secure: secure,
        settable: settable,
        focused: focused,
        valueDigest: TranscriptDigest.sha256(value),
        valueUTF16Count: (value as NSString).length,
        selection: selection
    )
}

@Test func transcriptPolicyAcceptsOnlyBoundFocusedEditableNonSecureText() throws {
    let valid = targetState()
    try TranscriptInsertionPolicy.validateCapturable(valid)
    let binding = try TranscriptTargetBinding(id: UUID(), capturedAt: insertionNow, state: valid)
    try TranscriptInsertionPolicy.validate(binding: binding, current: valid)

    #expect(throws: TranscriptInsertionError.unsupportedRole) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(role: "AXButton"))
    }
    #expect(throws: TranscriptInsertionError.secureTarget) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(secure: true))
    }
    #expect(throws: TranscriptInsertionError.nonSettable) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(settable: false))
    }
    #expect(throws: TranscriptInsertionError.focusChanged) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(focused: false))
    }
    #expect(throws: TranscriptInsertionError.noTarget) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(window: ""))
    }
    #expect(throws: TranscriptInsertionError.noTarget) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(element: ""))
    }
    #expect(throws: TranscriptInsertionError.invalidSelection) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(selection: .init(location: -1, length: 0)))
    }
    #expect(throws: TranscriptInsertionError.invalidSelection) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(selection: .init(location: 4, length: 2)))
    }
    #expect(throws: TranscriptInsertionError.invalidSelection) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(selection: .init(location: Int.max, length: 1)))
    }
    #expect(throws: TranscriptInsertionError.invalidSelection) {
        try TranscriptInsertionPolicy.validateCapturable(targetState(selection: .init(location: 0, length: -1)))
    }
    let negativeCount = TranscriptTargetState(
        process: insertionProcess,
        windowFingerprint: "window",
        elementFingerprint: "element",
        role: "AXTextField",
        subrole: nil,
        secure: false,
        settable: true,
        focused: true,
        valueDigest: "digest",
        valueUTF16Count: -1,
        selection: .init(location: 0, length: 0)
    )
    #expect(throws: TranscriptInsertionError.invalidSelection) {
        try TranscriptInsertionPolicy.validateCapturable(negativeCount)
    }
    let alternateFingerprint = TranscriptInsertionPolicy.stateFingerprint(targetState(
        role: "AXTextField",
        subrole: "AXSearchField",
        secure: true,
        settable: false,
        focused: false
    ))
    #expect(alternateFingerprint != TranscriptInsertionPolicy.stateFingerprint(valid))
}

@Test func transcriptPolicyRejectsWrongAppFocusAndAnyStateDrift() throws {
    let original = targetState()
    let binding = try TranscriptTargetBinding(capturedAt: insertionNow, state: original)
    let replacement = ProcessIdentity(
        bundleID: original.process.bundleID,
        pid: original.process.pid,
        processStart: insertionNow,
        signingIdentity: original.process.signingIdentity
    )
    #expect(throws: TranscriptInsertionError.wrongApplication) {
        try TranscriptInsertionPolicy.validate(binding: binding, current: targetState(process: replacement))
    }
    #expect(throws: TranscriptInsertionError.focusChanged) {
        try TranscriptInsertionPolicy.validate(binding: binding, current: targetState(window: "other-window"))
    }
    #expect(throws: TranscriptInsertionError.focusChanged) {
        try TranscriptInsertionPolicy.validate(binding: binding, current: targetState(element: "other-element"))
    }
    #expect(throws: TranscriptInsertionError.focusChanged) {
        try TranscriptInsertionPolicy.validate(binding: binding, current: targetState(focused: false))
    }
    #expect(throws: TranscriptInsertionError.secureTarget) {
        try TranscriptInsertionPolicy.validate(binding: binding, current: targetState(secure: true))
    }
    #expect(throws: TranscriptInsertionError.nonSettable) {
        try TranscriptInsertionPolicy.validate(binding: binding, current: targetState(settable: false))
    }
    #expect(throws: TranscriptInsertionError.staleState) {
        try TranscriptInsertionPolicy.validate(binding: binding, current: targetState(value: "changed"))
    }
    #expect(throws: TranscriptInsertionError.staleState) {
        try TranscriptInsertionPolicy.validate(binding: binding, current: targetState(selection: .init(location: 0, length: 0)))
    }
}

@Test func previewPreservesLiteralTranscriptExactlyAndOnlyPersistsItsDigest() throws {
    let binding = try TranscriptTargetBinding(capturedAt: insertionNow, state: targetState())
    let literal = "  Exact words.\nSecond line.  "
    let preview = try TranscriptInsertionPreview(attemptID: UUID(), binding: binding, literalTranscript: literal)
    #expect(preview.literalTranscript == literal)
    #expect(preview.transcriptBytes == literal.utf8.count)
    #expect(preview.transcriptDigest == TranscriptDigest.sha256(literal))
    #expect(throws: TranscriptInsertionError.emptyTranscript) {
        try TranscriptInsertionPreview(binding: binding, literalTranscript: "")
    }
    #expect(throws: TranscriptInsertionError.transcriptTooLarge) {
        try TranscriptInsertionPreview(
            binding: binding,
            literalTranscript: String(repeating: "a", count: TranscriptInsertionPreview.maximumTranscriptBytes + 1)
        )
    }
}

private func receiptDraft(
    attempt: UUID,
    target: UUID,
    stage: TranscriptReceiptStage,
    outcome: TranscriptReceiptOutcome,
    error: String? = nil
) -> TranscriptReceiptDraft {
    TranscriptReceiptDraft(
        attemptID: attempt,
        targetID: target,
        stage: stage,
        outcome: outcome,
        targetStateDigest: "state-digest",
        transcriptDigest: TranscriptDigest.sha256("private literal transcript"),
        transcriptBytes: 26,
        recordedAt: insertionNow,
        errorCode: error
    )
}

@Test func inMemoryReceiptJournalBuildsPendingTerminalHashChainWithoutRawText() throws {
    let journal = InMemoryTranscriptReceiptJournal()
    let attempt = UUID(), target = UUID()
    let pending = try journal.append(receiptDraft(attempt: attempt, target: target, stage: .pending, outcome: .pending))
    let terminal = try journal.append(receiptDraft(attempt: attempt, target: target, stage: .terminal, outcome: .inserted))
    #expect(pending.previousReceiptHash == nil)
    #expect(terminal.previousReceiptHash == pending.receiptHash)
    #expect(try journal.receipts() == [pending, terminal])
    let encoded = String(decoding: try JSONEncoder().encode(terminal), as: UTF8.self)
    #expect(!encoded.contains("private literal transcript"))
}

@Test func fsyncJournalPersistsValidChainAndRecoversPendingAsInterrupted() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("receipts.jsonl")
    let journal = FsyncTranscriptReceiptJournal(url: url)
    let attempt = UUID(), target = UUID()
    let pending = try journal.append(receiptDraft(attempt: attempt, target: target, stage: .pending, outcome: .pending))
    #expect(try journal.receipts() == [pending])
    let recovered = try journal.recoverInterrupted(at: insertionNow.addingTimeInterval(1))
    #expect(recovered.count == 1)
    #expect(recovered[0].outcome == .interrupted)
    #expect(recovered[0].previousReceiptHash == pending.receiptHash)
    #expect(try journal.recoverInterrupted(at: insertionNow.addingTimeInterval(2)).isEmpty)
    let stored = try String(contentsOf: url, encoding: .utf8)
    #expect(!stored.contains("private literal transcript"))
    let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
    #expect(permissions?.intValue == 0o600)
}

@Test func fsyncJournalRejectsTamperingOversizeAndUnwritablePath() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("receipts.jsonl")
    let journal = FsyncTranscriptReceiptJournal(url: url)
    _ = try journal.append(receiptDraft(attempt: UUID(), target: UUID(), stage: .pending, outcome: .pending))
    let line = try #require(try String(contentsOf: url, encoding: .utf8).split(separator: "\n").first)
    var object = try #require(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    object["receiptHash"] = "tampered"
    var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    data.append(0x0a)
    try data.write(to: url)
    #expect(throws: TranscriptInsertionError.journalFailure) { try journal.receipts() }

    let hugeURL = directory.appendingPathComponent("huge.jsonl")
    try Data(repeating: 0x20, count: FsyncTranscriptReceiptJournal.maximumJournalBytes + 1).write(to: hugeURL)
    #expect(throws: TranscriptInsertionError.journalFailure) {
        try FsyncTranscriptReceiptJournal(url: hugeURL).receipts()
    }
    #expect(throws: TranscriptInsertionError.journalFailure) {
        try FsyncTranscriptReceiptJournal(url: directory).append(
            receiptDraft(attempt: UUID(), target: UUID(), stage: .pending, outcome: .pending)
        )
    }
}

#if os(macOS)
@MainActor private final class FakeTranscriptAXAdapter: TranscriptInsertionAXAdapting {
    var state: TranscriptTargetState
    var captureError: TranscriptInsertionError?
    var mutationError: TranscriptInsertionError?
    private(set) var mutations: [String] = []

    init(state: TranscriptTargetState = targetState()) { self.state = state }

    func captureFocusedTarget() throws -> TranscriptTargetBinding {
        if let captureError { throw captureError }
        return try TranscriptTargetBinding(capturedAt: insertionNow, state: state)
    }

    func revalidateAndSet(_ preview: TranscriptInsertionPreview, binding: TranscriptTargetBinding) throws {
        if let mutationError { throw mutationError }
        try TranscriptInsertionPolicy.validate(binding: binding, current: state)
        mutations.append(preview.literalTranscript)
    }
}

@MainActor private final class FixedTranscriptApprover: TranscriptInsertionApproving {
    let approved: Bool
    private(set) var previews: [TranscriptInsertionPreview] = []
    init(_ approved: Bool) { self.approved = approved }
    func approve(_ preview: TranscriptInsertionPreview) async -> Bool {
        previews.append(preview)
        return approved
    }
}

private final class FailingReceiptJournal: TranscriptReceiptJournaling, @unchecked Sendable {
    func append(_ draft: TranscriptReceiptDraft) throws -> TranscriptInsertionReceipt {
        throw TranscriptInsertionError.journalFailure
    }
    func receipts() throws -> [TranscriptInsertionReceipt] { [] }
}

private final class FailOnSecondReceiptJournal: TranscriptReceiptJournaling, @unchecked Sendable {
    private let memory = InMemoryTranscriptReceiptJournal()
    private var count = 0
    func append(_ draft: TranscriptReceiptDraft) throws -> TranscriptInsertionReceipt {
        count += 1
        guard count == 1 else { throw TranscriptInsertionError.journalFailure }
        return try memory.append(draft)
    }
    func receipts() throws -> [TranscriptInsertionReceipt] { try memory.receipts() }
}

@MainActor @Test func coordinatorCapturesBeforeFocusPreviewsThenJournalsAndMutatesOnce() async throws {
    let adapter = FakeTranscriptAXAdapter()
    let journal = InMemoryTranscriptReceiptJournal()
    let approver = FixedTranscriptApprover(true)
    let coordinator = TranscriptInsertionCoordinator(adapter: adapter, journal: journal, now: { insertionNow })
    #expect(coordinator.captureBeforeMoaTakesFocus())
    let terminal = try await coordinator.insertLiteralTranscript("literal fixture", approver: approver)
    #expect(approver.previews.map(\.literalTranscript) == ["literal fixture"])
    #expect(adapter.mutations == ["literal fixture"])
    #expect(terminal.outcome == .inserted)
    #expect(coordinator.binding == nil)
    let receipts = try journal.receipts()
    #expect(receipts.map(\.stage) == [.pending, .terminal])
    #expect(receipts.map(\.outcome) == [.pending, .inserted])
    await #expect(throws: TranscriptInsertionError.noTarget) {
        try await coordinator.insertLiteralTranscript("again", approver: approver)
    }
}

@MainActor @Test func coordinatorDenialAndJournalFailureCauseZeroMutation() async throws {
    let adapter = FakeTranscriptAXAdapter()
    let journal = InMemoryTranscriptReceiptJournal()
    let coordinator = TranscriptInsertionCoordinator(adapter: adapter, journal: journal)
    #expect(coordinator.captureBeforeMoaTakesFocus())
    await #expect(throws: TranscriptInsertionError.denied) {
        try await coordinator.insertLiteralTranscript("literal", approver: FixedTranscriptApprover(false))
    }
    #expect(adapter.mutations.isEmpty)
    #expect(try journal.receipts().isEmpty)

    let failing = TranscriptInsertionCoordinator(adapter: adapter, journal: FailingReceiptJournal())
    #expect(failing.captureBeforeMoaTakesFocus())
    await #expect(throws: TranscriptInsertionError.journalFailure) {
        try await failing.insertLiteralTranscript("literal", approver: FixedTranscriptApprover(true))
    }
    #expect(adapter.mutations.isEmpty)
}

@MainActor @Test func coordinatorReportsTerminalJournalFailureWithoutMislabelingAppliedMutation() async throws {
    let adapter = FakeTranscriptAXAdapter()
    let journal = FailOnSecondReceiptJournal()
    let coordinator = TranscriptInsertionCoordinator(adapter: adapter, journal: journal)
    #expect(coordinator.captureBeforeMoaTakesFocus())
    await #expect(throws: TranscriptInsertionError.terminalJournalFailure) {
        try await coordinator.insertLiteralTranscript("literal", approver: FixedTranscriptApprover(true))
    }
    #expect(adapter.mutations == ["literal"])
    let receipts = try journal.receipts()
    #expect(receipts.count == 1)
    #expect(receipts[0].outcome == .pending)
}

@MainActor @Test(arguments: [
    TranscriptInsertionError.secureTarget,
    .staleState,
    .wrongApplication,
    .nonSettable,
    .focusChanged,
])
func coordinatorAdapterRejectionsWriteTerminalAndCauseZeroMutation(error: TranscriptInsertionError) async throws {
    let adapter = FakeTranscriptAXAdapter()
    adapter.mutationError = error
    let journal = InMemoryTranscriptReceiptJournal()
    let coordinator = TranscriptInsertionCoordinator(adapter: adapter, journal: journal, now: { insertionNow })
    #expect(coordinator.captureBeforeMoaTakesFocus())
    await #expect(throws: error) {
        try await coordinator.insertLiteralTranscript("literal", approver: FixedTranscriptApprover(true))
    }
    #expect(adapter.mutations.isEmpty)
    let receipts = try journal.receipts()
    #expect(receipts.map(\.outcome) == [.pending, .rejected])
    #expect(receipts.last?.errorCode == error.rawValue)
}

@MainActor @Test func coordinatorClearsOrRejectsMissingCapture() async {
    let adapter = FakeTranscriptAXAdapter()
    adapter.captureError = .secureTarget
    let coordinator = TranscriptInsertionCoordinator(adapter: adapter, journal: InMemoryTranscriptReceiptJournal())
    #expect(!coordinator.captureBeforeMoaTakesFocus())
    coordinator.clear()
    await #expect(throws: TranscriptInsertionError.noTarget) {
        try await coordinator.insertLiteralTranscript("literal", approver: FixedTranscriptApprover(true))
    }
}
#endif
