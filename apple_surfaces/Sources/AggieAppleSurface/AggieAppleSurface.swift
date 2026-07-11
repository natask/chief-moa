import CryptoKit
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

public enum JSONValue: Codable, Hashable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(Double.self) { self = .number(item) }
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
    public let kind: String
    public let mode: String
    public let deviceID: String?
    enum CodingKeys: String, CodingKey { case id, kind, mode; case deviceID = "device_id" }
    public init(id: String, kind: String, mode: String, deviceID: String? = nil) {
        self.id = id; self.kind = kind; self.mode = mode; self.deviceID = deviceID
    }
}

public struct ActionProposal: Codable, Hashable, Sendable {
    public let proposalID: String
    public let kind: String
    public let approvalClass: String
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
    public let outcome: String
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
    private static let surfaceKinds: Set<String> = ["macos", "ios"]
    private static let actionKinds: Set<String> = ["open_url", "open_app", "dial", "browser_task", "page_tweak", "file_export"]

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
        try validateID(result.surface.id); try validateID(result.surface.kind); try validateID(result.surface.mode)
        guard surfaceKinds.contains(result.surface.kind) else { throw AggieProtocolError.malformed("surface kind") }
        if let device = result.surface.deviceID { try validateID(device) }
        try validateID(result.payload.proposalID)
        guard actionKinds.contains(result.payload.kind) else { throw AggieProtocolError.malformed("action kind") }
        guard ["confirm", "none", "sensitive"].contains(result.payload.approvalClass) else { throw AggieProtocolError.malformed("approval class") }
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
        }
    }
}

public enum AggieDigest {
    public static func proposal(_ proposal: ProposalEnvelope) throws -> String {
        let payload: JSONValue = .object([
            "approval_class": .string(proposal.payload.approvalClass),
            "expires_at": .string(timestamp(proposal.payload.expiresAt)),
            "kind": .string(proposal.payload.kind),
            "params": .object(proposal.payload.params),
            "preconditions": .object(proposal.payload.preconditions),
            "proposal_id": .string(proposal.payload.proposalID),
            "proposed_by": .string("gateway"),
            "session_id": .string(proposal.sessionID),
        ])
        var surface: [String: JSONValue] = ["id": .string(proposal.surface.id), "kind": .string(proposal.surface.kind), "mode": .string(proposal.surface.mode)]
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
        case .number(let item): return item.rounded() == item ? String(Int(item)) : String(item)
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
    public init() {}

    public func handle(_ proposal: ProposalEnvelope, expectedSession: String, expectedSurface: SurfaceIdentity,
                       now: @Sendable () -> Date, approver: LocalApprovalPrompt,
                       state: LocalStateProvider, executor: LocalActionExecutor) async throws -> LocalActionReceipt {
        guard proposal.sessionID == expectedSession, proposal.surface == expectedSurface else { throw AggieProtocolError.scopeMismatch }
        guard pending.count < AggieLimits.pendingProposals else { throw AggieProtocolError.tooLarge }
        guard !consumed.contains(proposal.messageID), !pending.contains(proposal.messageID) else { throw AggieProtocolError.duplicateProposal }
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
        consumed.insert(proposal.messageID)
        try await executor.execute(proposal)
        return LocalActionReceipt(receiptID: "receipt_\(UUID().uuidString.lowercased())", proposalID: proposal.payload.proposalID,
            proposalMessageID: proposal.messageID, approvalID: approval.approvalID, sessionID: proposal.sessionID,
            surface: proposal.surface, outcome: "executed", observedAt: now(), stateDigest: try AggieDigest.state(finalState))
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
