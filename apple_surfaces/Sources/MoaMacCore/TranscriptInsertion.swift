import CryptoKit
import Darwin
import Foundation

public enum TranscriptInsertionError: String, Error, Equatable, Sendable {
    case noTarget = "no_target"
    case emptyTranscript = "empty_transcript"
    case transcriptTooLarge = "transcript_too_large"
    case unsupportedRole = "unsupported_role"
    case secureTarget = "secure_target"
    case nonSettable = "non_settable"
    case focusChanged = "focus_changed"
    case wrongApplication = "wrong_application"
    case staleState = "stale_state"
    case invalidSelection = "invalid_selection"
    case denied = "denied"
    case journalFailure = "journal_failure"
    case terminalJournalFailure = "terminal_journal_failure"
}

public struct TranscriptSelection: Codable, Equatable, Sendable {
    public let location: Int
    public let length: Int

    public init(location: Int, length: Int) {
        self.location = location
        self.length = length
    }
}

/// A value-free description of one focused editable AX target. Raw field text,
/// labels, titles, and AX references remain inside the injected platform adapter.
public struct TranscriptTargetState: Equatable, Sendable {
    public let process: ProcessIdentity
    public let windowFingerprint: String
    public let elementFingerprint: String
    public let role: String
    public let subrole: String?
    public let secure: Bool
    public let settable: Bool
    public let focused: Bool
    public let valueDigest: String
    public let valueUTF16Count: Int
    public let selection: TranscriptSelection

    public init(
        process: ProcessIdentity,
        windowFingerprint: String,
        elementFingerprint: String,
        role: String,
        subrole: String?,
        secure: Bool,
        settable: Bool,
        focused: Bool,
        valueDigest: String,
        valueUTF16Count: Int,
        selection: TranscriptSelection
    ) {
        self.process = process
        self.windowFingerprint = windowFingerprint
        self.elementFingerprint = elementFingerprint
        self.role = role
        self.subrole = subrole
        self.secure = secure
        self.settable = settable
        self.focused = focused
        self.valueDigest = valueDigest
        self.valueUTF16Count = valueUTF16Count
        self.selection = selection
    }
}

public struct TranscriptTargetBinding: Equatable, Sendable {
    public let id: UUID
    public let capturedAt: Date
    public let state: TranscriptTargetState
    public let stateFingerprint: String

    public init(id: UUID = UUID(), capturedAt: Date, state: TranscriptTargetState) throws {
        try TranscriptInsertionPolicy.validateCapturable(state)
        self.id = id
        self.capturedAt = capturedAt
        self.state = state
        self.stateFingerprint = TranscriptInsertionPolicy.stateFingerprint(state)
    }
}

public struct TranscriptInsertionPreview: Equatable, Sendable {
    public static let maximumTranscriptBytes = 32 * 1024

    public let attemptID: UUID
    public let targetID: UUID
    public let applicationBundleID: String
    public let role: String
    public let literalTranscript: String
    public let transcriptDigest: String
    public let transcriptBytes: Int

    public init(attemptID: UUID = UUID(), binding: TranscriptTargetBinding, literalTranscript: String) throws {
        guard !literalTranscript.isEmpty else { throw TranscriptInsertionError.emptyTranscript }
        guard literalTranscript.utf8.count <= Self.maximumTranscriptBytes else {
            throw TranscriptInsertionError.transcriptTooLarge
        }
        self.attemptID = attemptID
        targetID = binding.id
        applicationBundleID = binding.state.process.bundleID
        role = binding.state.role
        self.literalTranscript = literalTranscript
        transcriptDigest = TranscriptDigest.sha256(literalTranscript)
        transcriptBytes = literalTranscript.utf8.count
    }
}

public enum TranscriptInsertionPolicy {
    public static let supportedRoles: Set<String> = ["AXTextField", "AXTextArea"]

    public static func validateCapturable(_ state: TranscriptTargetState) throws {
        guard supportedRoles.contains(state.role) else { throw TranscriptInsertionError.unsupportedRole }
        guard !state.secure else { throw TranscriptInsertionError.secureTarget }
        guard state.settable else { throw TranscriptInsertionError.nonSettable }
        guard state.focused else { throw TranscriptInsertionError.focusChanged }
        guard !state.windowFingerprint.isEmpty, !state.elementFingerprint.isEmpty else {
            throw TranscriptInsertionError.noTarget
        }
        let selectionEnd = state.selection.location.addingReportingOverflow(state.selection.length)
        guard state.valueUTF16Count >= 0,
              state.selection.location >= 0,
              state.selection.length >= 0,
              !selectionEnd.overflow,
              selectionEnd.partialValue <= state.valueUTF16Count else {
            throw TranscriptInsertionError.invalidSelection
        }
    }

    public static func validate(binding: TranscriptTargetBinding, current: TranscriptTargetState) throws {
        guard current.process == binding.state.process else { throw TranscriptInsertionError.wrongApplication }
        guard current.windowFingerprint == binding.state.windowFingerprint,
              current.elementFingerprint == binding.state.elementFingerprint,
              current.focused else { throw TranscriptInsertionError.focusChanged }
        try validateCapturable(current)
        guard stateFingerprint(current) == binding.stateFingerprint else {
            throw TranscriptInsertionError.staleState
        }
    }

    public static func stateFingerprint(_ state: TranscriptTargetState) -> String {
        TranscriptDigest.sha256([
            state.process.bundleID,
            String(state.process.pid),
            String(state.process.processStart.timeIntervalSince1970),
            state.process.signingIdentity,
            state.windowFingerprint,
            state.elementFingerprint,
            state.role,
            state.subrole ?? "",
            state.secure ? "secure" : "not-secure",
            state.settable ? "settable" : "not-settable",
            state.focused ? "focused" : "not-focused",
            state.valueDigest,
            String(state.valueUTF16Count),
            String(state.selection.location),
            String(state.selection.length),
        ].joined(separator: "\u{1f}"))
    }
}

public enum TranscriptReceiptStage: String, Codable, Sendable { case pending, terminal }
public enum TranscriptReceiptOutcome: String, Codable, Sendable {
    case pending, inserted, rejected, interrupted
}

public struct TranscriptReceiptDraft: Equatable, Sendable {
    public let attemptID: UUID
    public let targetID: UUID
    public let stage: TranscriptReceiptStage
    public let outcome: TranscriptReceiptOutcome
    public let targetStateDigest: String
    public let transcriptDigest: String
    public let transcriptBytes: Int
    public let recordedAt: Date
    public let errorCode: String?

    public init(
        attemptID: UUID,
        targetID: UUID,
        stage: TranscriptReceiptStage,
        outcome: TranscriptReceiptOutcome,
        targetStateDigest: String,
        transcriptDigest: String,
        transcriptBytes: Int,
        recordedAt: Date,
        errorCode: String? = nil
    ) {
        self.attemptID = attemptID
        self.targetID = targetID
        self.stage = stage
        self.outcome = outcome
        self.targetStateDigest = targetStateDigest
        self.transcriptDigest = transcriptDigest
        self.transcriptBytes = transcriptBytes
        self.recordedAt = recordedAt
        self.errorCode = errorCode
    }
}

public struct TranscriptInsertionReceipt: Codable, Equatable, Sendable {
    public let version: Int
    public let receiptID: UUID
    public let attemptID: UUID
    public let targetID: UUID
    public let stage: TranscriptReceiptStage
    public let outcome: TranscriptReceiptOutcome
    public let targetStateDigest: String
    public let transcriptDigest: String
    public let transcriptBytes: Int
    public let recordedAt: Date
    public let errorCode: String?
    public let previousReceiptHash: String?
    public let receiptHash: String
}

public protocol TranscriptReceiptJournaling: Sendable {
    func append(_ draft: TranscriptReceiptDraft) throws -> TranscriptInsertionReceipt
    func receipts() throws -> [TranscriptInsertionReceipt]
}

public final class InMemoryTranscriptReceiptJournal: TranscriptReceiptJournaling, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [TranscriptInsertionReceipt] = []

    public init() {}

    public func append(_ draft: TranscriptReceiptDraft) throws -> TranscriptInsertionReceipt {
        lock.withLock {
            let receipt = TranscriptReceiptFactory.make(draft, previous: values.last?.receiptHash)
            values.append(receipt)
            return receipt
        }
    }

    public func receipts() throws -> [TranscriptInsertionReceipt] { lock.withLock { values } }
}

public final class FsyncTranscriptReceiptJournal: TranscriptReceiptJournaling, @unchecked Sendable {
    public static let maximumJournalBytes = 4 * 1024 * 1024
    private let url: URL
    private let lock = NSLock()

    public init(url: URL) { self.url = url }

    public func append(_ draft: TranscriptReceiptDraft) throws -> TranscriptInsertionReceipt {
        try lock.withLock {
            let current = try readUnlocked()
            let receipt = TranscriptReceiptFactory.make(draft, previous: current.last?.receiptHash)
            var bytes = try Self.encoder.encode(receipt)
            bytes.append(0x0a)
            let existingSize = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard existingSize + bytes.count <= Self.maximumJournalBytes else {
                throw TranscriptInsertionError.journalFailure
            }
            let directory = url.deletingLastPathComponent()
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let descriptor = open(url.path, O_WRONLY | O_CREAT | O_APPEND, S_IRUSR | S_IWUSR)
                guard descriptor >= 0 else { throw TranscriptInsertionError.journalFailure }
                defer { close(descriptor) }
                try bytes.withUnsafeBytes { buffer in
                    guard let base = buffer.baseAddress else { return }
                    var written = 0
                    while written < buffer.count {
                        let count = Darwin.write(descriptor, base.advanced(by: written), buffer.count - written)
                        guard count > 0 else { throw TranscriptInsertionError.journalFailure }
                        written += count
                    }
                }
                guard fsync(descriptor) == 0, chmod(url.path, S_IRUSR | S_IWUSR) == 0 else {
                    throw TranscriptInsertionError.journalFailure
                }
                let parent = open(directory.path, O_RDONLY)
                guard parent >= 0 else { throw TranscriptInsertionError.journalFailure }
                defer { close(parent) }
                guard fsync(parent) == 0 else { throw TranscriptInsertionError.journalFailure }
            } catch let error as TranscriptInsertionError {
                throw error
            } catch {
                throw TranscriptInsertionError.journalFailure
            }
            return receipt
        }
    }

    public func receipts() throws -> [TranscriptInsertionReceipt] { try lock.withLock { try readUnlocked() } }

    public func recoverInterrupted(at date: Date) throws -> [TranscriptInsertionReceipt] {
        let pending = try receipts().reduce(into: [UUID: TranscriptInsertionReceipt]()) { latest, receipt in
            latest[receipt.attemptID] = receipt
        }.values.filter { $0.stage == .pending }
        return try pending.map { receipt in
            try append(.init(
                attemptID: receipt.attemptID,
                targetID: receipt.targetID,
                stage: .terminal,
                outcome: .interrupted,
                targetStateDigest: receipt.targetStateDigest,
                transcriptDigest: receipt.transcriptDigest,
                transcriptBytes: receipt.transcriptBytes,
                recordedAt: date,
                errorCode: TranscriptReceiptOutcome.interrupted.rawValue
            ))
        }
    }

    private func readUnlocked() throws -> [TranscriptInsertionReceipt] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= Self.maximumJournalBytes,
              let data = try? Data(contentsOf: url) else { throw TranscriptInsertionError.journalFailure }
        do {
            var previous: String?
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try data.split(separator: 0x0a).map { line in
                let receipt = try decoder.decode(TranscriptInsertionReceipt.self, from: Data(line))
                guard receipt.previousReceiptHash == previous,
                      TranscriptReceiptFactory.verify(receipt) else {
                    throw TranscriptInsertionError.journalFailure
                }
                previous = receipt.receiptHash
                return receipt
            }
        } catch let error as TranscriptInsertionError {
            throw error
        } catch {
            throw TranscriptInsertionError.journalFailure
        }
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

private enum TranscriptReceiptFactory {
    private struct Unsigned: Codable {
        let version: Int
        let receiptID: UUID
        let attemptID: UUID
        let targetID: UUID
        let stage: TranscriptReceiptStage
        let outcome: TranscriptReceiptOutcome
        let targetStateDigest: String
        let transcriptDigest: String
        let transcriptBytes: Int
        let recordedAt: Date
        let errorCode: String?
        let previousReceiptHash: String?
    }

    static func make(_ draft: TranscriptReceiptDraft, previous: String?) -> TranscriptInsertionReceipt {
        let unsigned = Unsigned(
            version: 1,
            receiptID: UUID(),
            attemptID: draft.attemptID,
            targetID: draft.targetID,
            stage: draft.stage,
            outcome: draft.outcome,
            targetStateDigest: draft.targetStateDigest,
            transcriptDigest: draft.transcriptDigest,
            transcriptBytes: draft.transcriptBytes,
            recordedAt: draft.recordedAt,
            errorCode: draft.errorCode,
            previousReceiptHash: previous
        )
        return receipt(unsigned, hash: digest(unsigned))
    }

    static func verify(_ receipt: TranscriptInsertionReceipt) -> Bool {
        let unsigned = Unsigned(
            version: receipt.version,
            receiptID: receipt.receiptID,
            attemptID: receipt.attemptID,
            targetID: receipt.targetID,
            stage: receipt.stage,
            outcome: receipt.outcome,
            targetStateDigest: receipt.targetStateDigest,
            transcriptDigest: receipt.transcriptDigest,
            transcriptBytes: receipt.transcriptBytes,
            recordedAt: receipt.recordedAt,
            errorCode: receipt.errorCode,
            previousReceiptHash: receipt.previousReceiptHash
        )
        return digest(unsigned) == receipt.receiptHash
    }

    private static func receipt(_ value: Unsigned, hash: String) -> TranscriptInsertionReceipt {
        TranscriptInsertionReceipt(
            version: value.version,
            receiptID: value.receiptID,
            attemptID: value.attemptID,
            targetID: value.targetID,
            stage: value.stage,
            outcome: value.outcome,
            targetStateDigest: value.targetStateDigest,
            transcriptDigest: value.transcriptDigest,
            transcriptBytes: value.transcriptBytes,
            recordedAt: value.recordedAt,
            errorCode: value.errorCode,
            previousReceiptHash: value.previousReceiptHash,
            receiptHash: hash
        )
    }

    private static func digest(_ value: Unsigned) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return TranscriptDigest.sha256((try? encoder.encode(value)) ?? Data())
    }
}

public enum TranscriptDigest {
    public static func sha256(_ text: String) -> String { sha256(Data(text.utf8)) }
    public static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
