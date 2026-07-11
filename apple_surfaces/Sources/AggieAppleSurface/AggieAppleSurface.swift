import CryptoKit
import CoreFoundation
import Darwin
import Foundation

public enum AggieLimits {
    public static let envelopeBytes = 64 * 1024
    public static let replayEvents = 256
    public static let replayBytes = 1024 * 1024
    public static let pendingProposals = 128
}

public enum AggieProtocolError: Error, Equatable, Sendable {
    case malformed(String), unsupportedVersion, unsupportedType, tooLarge
    case dangerousPayload, scopeMismatch, expired, staleState, denied
    case duplicateProposal, sequenceConflict, messageConflict, sequenceGap
}

public enum SurfaceKind: String, Codable, Hashable, Sendable { case macOS = "macos", iOS = "ios" }
public enum SurfaceMode: String, Codable, Hashable, Sendable { case text, voice }
public enum ActionKind: String, Codable, Hashable, Sendable {
    case openURL = "open_url", openApp = "open_app", dial
    case browserTask = "browser_task", pageTweak = "page_tweak", fileExport = "file_export"
}
public enum ApprovalClass: String, Codable, Hashable, Sendable { case confirm, none, sensitive }
public enum ReceiptOutcome: String, Codable, Hashable, Sendable {
    case executed, failed, unknownEffect = "unknown_effect"
}
public enum RecoveryStatus: String, Codable, Hashable, Sendable {
    case notStarted = "not_started", knownFailed = "known_failed"
    case knownSucceeded = "known_succeeded", unknownEffect = "unknown_effect"
}

public protocol EffectJournal: Sendable {
    func status(for messageID: String) throws -> RecoveryStatus
    func record(_ status: RecoveryStatus, for messageID: String) throws
}

public final class InMemoryEffectJournal: EffectJournal, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String: RecoveryStatus] = [:]
    public init() {}
    public func status(for messageID: String) throws -> RecoveryStatus {
        lock.withLock { records[messageID] ?? .notStarted }
    }
    public func record(_ status: RecoveryStatus, for messageID: String) throws {
        try lock.withLock {
            guard records[messageID] == nil || records[messageID] == .notStarted || status != .notStarted
            else { throw AggieProtocolError.duplicateProposal }
            guard records.count < AggieLimits.pendingProposals || records[messageID] != nil else {
                throw AggieProtocolError.tooLarge
            }
            records[messageID] = status
        }
    }
}

public final class AtomicFileEffectJournal: EffectJournal, @unchecked Sendable {
    private let url: URL
    private let lock = NSLock()
    public init(url: URL) { self.url = url }
    public func status(for messageID: String) throws -> RecoveryStatus {
        try lock.withLock {
            if let status = try read()[messageID] { return status }
            return FileManager.default.fileExists(atPath: claimURL(for: messageID).path) ? .unknownEffect : .notStarted
        }
    }
    public func record(_ status: RecoveryStatus, for messageID: String) throws {
        try lock.withLock {
            var records = try read()
            if status == .unknownEffect && records[messageID] != nil { throw AggieProtocolError.duplicateProposal }
            if status == .unknownEffect {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                let claim = claimURL(for: messageID)
                let descriptor = open(claim.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
                guard descriptor >= 0 else { throw AggieProtocolError.duplicateProposal }
                close(descriptor)
            }
            guard records.count < AggieLimits.pendingProposals || records[messageID] != nil else {
                throw AggieProtocolError.tooLarge
            }
            records[messageID] = status
            let data = try JSONEncoder().encode(records)
            guard data.count <= AggieLimits.replayBytes else { throw AggieProtocolError.tooLarge }
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        }
    }
    private func claimURL(for messageID: String) -> URL {
        url.deletingPathExtension().appendingPathExtension("\(messageID).effect-claim")
    }
    private func read() throws -> [String: RecoveryStatus] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard data.count <= AggieLimits.replayBytes else { throw AggieProtocolError.tooLarge }
        return try JSONDecoder().decode([String: RecoveryStatus].self, from: data)
    }
}

public enum JSONValue: Codable, Hashable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(Double.self) {
            guard item.isFinite, !(item == 0 && item.sign == .minus),
                  item.rounded() != item || abs(item) <= 9_007_199_254_740_991
            else { throw AggieProtocolError.malformed("unsafe number") }
            self = .number(item)
        }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode([String: JSONValue].self) { self = .object(item) }
        else if let item = try? value.decode([JSONValue].self) { self = .array(item) }
        else { throw AggieProtocolError.malformed("unsupported JSON value") }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .bool(let item): try value.encode(item)
        case .object(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .null: try value.encodeNil()
        }
    }
}

public struct SurfaceIdentity: Codable, Hashable, Sendable {
    public let id: String
    public let kind: SurfaceKind
    public let mode: SurfaceMode
    public let deviceID: String?
    enum CodingKeys: String, CodingKey { case id, kind, mode; case deviceID = "device_id" }
    public init(id: String, kind: SurfaceKind, mode: SurfaceMode, deviceID: String? = nil) {
        self.id = id; self.kind = kind; self.mode = mode; self.deviceID = deviceID
    }
}

public struct ActionProposal: Codable, Hashable, Sendable {
    public let proposalID: String
    public let kind: ActionKind
    public let approvalClass: ApprovalClass
    public let expiresAt: Date
    public let preconditions: [String: JSONValue]
    public let params: [String: JSONValue]
    enum CodingKeys: String, CodingKey {
        case proposalID = "proposal_id", kind, approvalClass = "approval_class"
        case expiresAt = "expires_at", preconditions, params
    }
}

public struct ProposalEnvelope: Codable, Hashable, Sendable {
    public let version: Int
    public let type: String
    public let messageID: String
    public let sessionID: String
    public let surface: SurfaceIdentity
    public let timestamp: Date
    public let sequence: Int?
    public let payload: ActionProposal
    enum CodingKeys: String, CodingKey {
        case version, type, surface, timestamp, sequence, payload
        case messageID = "message_id", sessionID = "session_id"
    }
}

public struct LocalApproval: Hashable, Sendable {
    public let approvalID: String
    public let proposalID: String
    public let proposalMessageID: String
    public let proposalDigest: String
    public let sessionID: String
    public let surface: SurfaceIdentity
    public let actorID: String
    public let decidedAt: Date
    public let approved: Bool
    public init(approvalID: String, proposalID: String, proposalMessageID: String,
                proposalDigest: String, sessionID: String, surface: SurfaceIdentity,
                actorID: String, decidedAt: Date, approved: Bool) {
        self.approvalID = approvalID; self.proposalID = proposalID
        self.proposalMessageID = proposalMessageID; self.proposalDigest = proposalDigest
        self.sessionID = sessionID; self.surface = surface; self.actorID = actorID
        self.decidedAt = decidedAt; self.approved = approved
    }
}

public struct LocalActionReceipt: Codable, Hashable, Sendable {
    public let receiptID: String
    public let proposalID: String
    public let proposalMessageID: String
    public let approvalID: String
    public let sessionID: String
    public let surface: SurfaceIdentity
    public let outcome: ReceiptOutcome
    public let observedAt: Date
    public let stateDigest: String
}

public enum AggieEnvelopeDecoder {
    private static let supportedTypes: Set<String> = [
        "hello", "resume", "turn.text", "action.proposed", "action.approved", "action.receipted",
        "hello.accepted", "turn.voice.started", "turn.voice.completed", "route.selected",
        "run.queued", "run.running", "run.needs_approval", "run.completed", "run.failed",
        "message.created", "session.snapshot_required"
    ]
    private static let forbiddenKeys: Set<String> = ["eval", "script", "javascript", "shell", "command", "code", "authorization", "password"]
    private static let credentialSuffixes = ["token", "apikey", "privatekey", "clientsecret", "providerkey", "dbpassword", "password", "authorization"]

    public static func negotiate(_ offered: [Int]) throws -> Int {
        if offered.contains(2) { return 2 }
        if offered.contains(1) { return 1 }
        throw AggieProtocolError.unsupportedVersion
    }

    public static func decodeProposal(_ data: Data) throws -> ProposalEnvelope {
        guard data.count <= AggieLimits.envelopeBytes else { throw AggieProtocolError.tooLarge }
        let raw = try JSONSerialization.jsonObject(with: data)
        try scan(raw, depth: 0)
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let result: ProposalEnvelope
        do { result = try decoder.decode(ProposalEnvelope.self, from: data) }
        catch { throw AggieProtocolError.malformed("proposal envelope") }
        guard [1, 2].contains(result.version) else { throw AggieProtocolError.unsupportedVersion }
        guard supportedTypes.contains(result.type), result.type == "action.proposed" else { throw AggieProtocolError.unsupportedType }
        try validateID(result.messageID); try validateID(result.sessionID)
        try validateID(result.surface.id)
        if let device = result.surface.deviceID { try validateID(device) }
        try validateID(result.payload.proposalID)
        guard !result.payload.preconditions.isEmpty else { throw AggieProtocolError.malformed("missing preconditions") }
        return result
    }

    private static func validateID(_ value: String) throws {
        guard !value.isEmpty, value.utf8.count <= 160,
              value.allSatisfy({ $0.isLetter || $0.isNumber || "._:-".contains($0) })
        else { throw AggieProtocolError.malformed("invalid id") }
    }

    private static func scan(_ value: Any, depth: Int) throws {
        guard depth <= 12 else { throw AggieProtocolError.dangerousPayload }
        if let object = value as? [String: Any] {
            guard object.count <= 64 else { throw AggieProtocolError.tooLarge }
            for (key, child) in object {
                let lower = key.lowercased()
                let compact = lower.filter(\.isLetter)
                if forbiddenKeys.contains(lower) || credentialSuffixes.contains(where: { compact == $0 || compact.hasSuffix($0) }) {
                    throw AggieProtocolError.dangerousPayload
                }
                try scan(child, depth: depth + 1)
            }
        } else if let array = value as? [Any] {
            guard array.count <= 64 else { throw AggieProtocolError.tooLarge }
            for child in array { try scan(child, depth: depth + 1) }
        } else if let text = value as? String {
            guard text.utf8.count <= 16 * 1024 else { throw AggieProtocolError.tooLarge }
            guard !text.unicodeScalars.contains(where: { $0.value < 0x20 && $0 != "\n" && $0 != "\r" && $0 != "\t" }) else {
                throw AggieProtocolError.dangerousPayload
            }
            let lower = text.lowercased()
            if lower.contains("bearer ") || lower.contains("?code=") || lower.contains("&code=") || lower.contains("sk-") ||
                lower.contains("github_pat_") || lower.contains("ghp_") || lower.contains("aiza") || lower.contains("ya29.") {
                throw AggieProtocolError.dangerousPayload
            }
        } else if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let item = number.doubleValue
            guard item.isFinite, !(item == 0 && item.sign == .minus),
                  item.rounded() != item || abs(item) <= 9_007_199_254_740_991
            else { throw AggieProtocolError.malformed("unsafe number") }
        }
    }
}

public enum AggieDigest {
    public static func proposal(_ proposal: ProposalEnvelope) throws -> String {
        let payload: JSONValue = .object([
            "approval_class": .string(proposal.payload.approvalClass.rawValue),
            "expires_at": .string(timestamp(proposal.payload.expiresAt)),
            "kind": .string(proposal.payload.kind.rawValue),
            "params": .object(proposal.payload.params),
            "preconditions": .object(proposal.payload.preconditions),
            "proposal_id": .string(proposal.payload.proposalID),
            "proposed_by": .string("gateway"),
            "session_id": .string(proposal.sessionID),
        ])
        var surface: [String: JSONValue] = ["id": .string(proposal.surface.id), "kind": .string(proposal.surface.kind.rawValue), "mode": .string(proposal.surface.mode.rawValue)]
        if let deviceID = proposal.surface.deviceID { surface["device_id"] = .string(deviceID) }
        let canonical: JSONValue = .object([
            "message_id": .string(proposal.messageID), "payload": payload,
            "session_id": .string(proposal.sessionID),
            "surface": .object(surface),
            "timestamp": .string(timestamp(proposal.timestamp)), "version": .number(Double(proposal.version)),
        ])
        let data = Data(stableJSON(canonical).utf8)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    public static func state(_ state: [String: JSONValue]) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return SHA256.hash(data: try encoder.encode(state)).map { String(format: "%02x", $0) }.joined()
    }
    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
    private static func stableJSON(_ value: JSONValue) -> String {
        switch value {
        case .null: return "null"
        case .bool(let item): return item ? "true" : "false"
        case .number(let item):
            precondition(item.isFinite && !(item == 0 && item.sign == .minus))
            if item.rounded() == item && abs(item) <= Double(Int.max) { return String(Int(item)) }
            return String(item)
        case .string(let item):
            let escaped = item.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
                .replacingOccurrences(of: "\t", with: "\\t")
            return "\"\(escaped)\""
        case .array(let items): return "[\(items.map(stableJSON).joined(separator: ","))]"
        case .object(let items): return "{\(items.keys.sorted().map { key in stableJSON(.string(key)) + ":" + stableJSON(items[key] ?? .null) }.joined(separator: ","))}"
        }
    }
}

public protocol LocalApprovalPrompt: Sendable { func requestApproval(for proposal: ProposalEnvelope, digest: String) async throws -> LocalApproval }
public protocol LocalStateProvider: Sendable { func currentState() async throws -> [String: JSONValue] }
public protocol LocalActionExecutor: Sendable { func execute(_ proposal: ProposalEnvelope) async throws }

public actor AppleActionCoordinator {
    private var consumed = Set<String>()
    private var pending = Set<String>()
    private let journal: EffectJournal
    public init(journal: EffectJournal = InMemoryEffectJournal()) { self.journal = journal }

    public func recoveryStatus(for messageID: String) throws -> RecoveryStatus {
        try journal.status(for: messageID)
    }

    public func handle(_ proposal: ProposalEnvelope, expectedSession: String, expectedSurface: SurfaceIdentity,
                       now: @Sendable () -> Date, approver: LocalApprovalPrompt,
                       state: LocalStateProvider, executor: LocalActionExecutor) async throws -> LocalActionReceipt {
        guard proposal.sessionID == expectedSession, proposal.surface == expectedSurface else { throw AggieProtocolError.scopeMismatch }
        guard pending.count < AggieLimits.pendingProposals else { throw AggieProtocolError.tooLarge }
        guard !consumed.contains(proposal.messageID), !pending.contains(proposal.messageID),
              try journal.status(for: proposal.messageID) == .notStarted
        else { throw AggieProtocolError.duplicateProposal }
        guard now() <= proposal.payload.expiresAt else { throw AggieProtocolError.expired }
        let before = try await state.currentState()
        guard matches(proposal.payload.preconditions, before) else { throw AggieProtocolError.staleState }
        let digest = try AggieDigest.proposal(proposal)
        pending.insert(proposal.messageID)
        defer { pending.remove(proposal.messageID) }
        let approval = try await approver.requestApproval(for: proposal, digest: digest)
        guard approval.approved else { throw AggieProtocolError.denied }
        guard approval.proposalID == proposal.payload.proposalID,
              approval.proposalMessageID == proposal.messageID, approval.proposalDigest == digest,
              approval.sessionID == proposal.sessionID, approval.surface == proposal.surface,
              approval.decidedAt >= proposal.timestamp, approval.decidedAt <= now()
        else { throw AggieProtocolError.scopeMismatch }
        guard now() <= proposal.payload.expiresAt else { throw AggieProtocolError.expired }
        let finalState = try await state.currentState()
        guard matches(proposal.payload.preconditions, finalState) else { throw AggieProtocolError.staleState }
        // Persist the uncertainty boundary before invoking an effect. A crash
        // between this write and a typed terminal result must never enable retry.
        try journal.record(.unknownEffect, for: proposal.messageID)
        consumed.insert(proposal.messageID)
        do { try await executor.execute(proposal) }
        catch {
            try? journal.record(.unknownEffect, for: proposal.messageID)
            throw error
        }
        try journal.record(.knownSucceeded, for: proposal.messageID)
        return LocalActionReceipt(receiptID: "receipt_\(UUID().uuidString.lowercased())", proposalID: proposal.payload.proposalID,
            proposalMessageID: proposal.messageID, approvalID: approval.approvalID, sessionID: proposal.sessionID,
            surface: proposal.surface, outcome: .executed, observedAt: now(), stateDigest: try AggieDigest.state(finalState))
    }

    private func matches(_ expected: [String: JSONValue], _ actual: [String: JSONValue]) -> Bool {
        expected.allSatisfy { actual[$0.key] == $0.value }
    }
}

public struct ReplayEvent: Hashable, Sendable {
    public let sequence: Int
    public let messageID: String
    public let sessionID: String
    public let canonicalEnvelope: Data
    public init(sequence: Int, messageID: String, sessionID: String, canonicalEnvelope: Data) {
        self.sequence = sequence; self.messageID = messageID; self.sessionID = sessionID; self.canonicalEnvelope = canonicalEnvelope
    }
    fileprivate var bytes: Int { canonicalEnvelope.count }
}
public struct ReplayResult: Sendable { public let accepted: Bool; public let duplicate: Bool }

public struct SessionReplay: Sendable {
    private let sessionID: String
    private var events: [ReplayEvent] = []
    public init(sessionID: String) { self.sessionID = sessionID }
    public mutating func accept(_ event: ReplayEvent) throws -> ReplayResult {
        guard event.sessionID == sessionID else { throw AggieProtocolError.scopeMismatch }
        guard event.sequence > 0, event.bytes > 0, event.bytes <= AggieLimits.envelopeBytes else { throw AggieProtocolError.malformed("replay event") }
        guard !event.messageID.isEmpty, event.messageID.utf8.count <= 160,
              event.messageID.allSatisfy({ $0.isLetter || $0.isNumber || "._:-".contains($0) })
        else { throw AggieProtocolError.malformed("replay message id") }
        if let existing = events.first(where: { $0.sequence == event.sequence }) {
            guard existing == event else { throw AggieProtocolError.sequenceConflict }
            return ReplayResult(accepted: false, duplicate: true)
        }
        if let existing = events.first(where: { $0.messageID == event.messageID }) {
            guard existing == event else { throw AggieProtocolError.messageConflict }
            return ReplayResult(accepted: false, duplicate: true)
        }
        if let last = events.last, event.sequence != last.sequence + 1 { throw AggieProtocolError.sequenceGap }
        events.append(event)
        while events.count > AggieLimits.replayEvents || events.reduce(0, { $0 + $1.bytes }) > AggieLimits.replayBytes { events.removeFirst() }
        return ReplayResult(accepted: true, duplicate: false)
    }
    public var count: Int { events.count }
}

public func reconnectDelay(attempt: Int, entropy: Double) throws -> Int {
    guard attempt >= 0, entropy >= 0, entropy <= 1 else { throw AggieProtocolError.malformed("backoff") }
    let cap = min(30_000, 250 * (1 << min(attempt, 16)))
    return Int(Double(cap) * entropy)
}
