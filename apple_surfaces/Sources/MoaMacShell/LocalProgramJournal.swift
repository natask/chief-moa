#if os(macOS)
import Darwin
import Foundation
import MoaMacCore

public struct MacProgramTerminalReceipt: Codable, Equatable, Sendable {
    public struct ToolAttempts: Codable, Equatable, Sendable {
        public let count: Int, firstReceiptSHA256: String?, lastReceiptSHA256: String?
        enum CodingKeys: String, CodingKey {
            case count; case firstReceiptSHA256 = "first_receipt_sha256", lastReceiptSHA256 = "last_receipt_sha256"
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(count, forKey: .count)
            if let firstReceiptSHA256 { try c.encode(firstReceiptSHA256, forKey: .firstReceiptSHA256) } else { try c.encodeNil(forKey: .firstReceiptSHA256) }
            if let lastReceiptSHA256 { try c.encode(lastReceiptSHA256, forKey: .lastReceiptSHA256) } else { try c.encodeNil(forKey: .lastReceiptSHA256) }
        }
    }
    public struct Result: Codable, Equatable, Sendable {
        public let summary: String, dataSHA256: String?, artifactRefs: [String]
        enum CodingKeys: String, CodingKey { case summary; case dataSHA256 = "data_sha256", artifactRefs = "artifact_refs" }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(summary, forKey: .summary)
            if let dataSHA256 { try c.encode(dataSHA256, forKey: .dataSHA256) } else { try c.encodeNil(forKey: .dataSHA256) }
            try c.encode(artifactRefs, forKey: .artifactRefs)
        }
    }
    public struct Failure: Codable, Equatable, Sendable {
        public let code: String?, message: String?
        enum CodingKeys: CodingKey { case code, message }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            if let code { try c.encode(code, forKey: .code) } else { try c.encodeNil(forKey: .code) }
            if let message { try c.encode(message, forKey: .message) } else { try c.encodeNil(forKey: .message) }
        }
    }

    public let version: Int, type: String, receiptID: String, executionID: String, sessionID: String, turnID: String
    public let claimant: MacReceiptClaimant
    public let runtimeID: String, programSHA256: String, catalogSHA256: String, bindingsSHA256: String
    public let startedAt: Date?, finishedAt: Date, status: String
    public let toolAttempts: ToolAttempts, result: Result
    public let finalStateSHA256: String?, error: Failure, previousReceiptSHA256: String?, receiptSHA256: String

    enum CodingKeys: String, CodingKey {
        case version, type, claimant, status, result, error
        case receiptID = "receipt_id", executionID = "execution_id", sessionID = "session_id", turnID = "turn_id"
        case runtimeID = "runtime_id", programSHA256 = "program_sha256", catalogSHA256 = "catalog_sha256"
        case bindingsSHA256 = "bindings_sha256", startedAt = "started_at", finishedAt = "finished_at"
        case toolAttempts = "tool_attempts", finalStateSHA256 = "final_state_sha256"
        case previousReceiptSHA256 = "previous_receipt_sha256", receiptSHA256 = "receipt_sha256"
    }

    public static func make(receiptID: String, result local: MacLocalProgramResult,
                            claimant: MacReceiptClaimant, receipts: [MacLocalActionReceipt],
                            status: String, finishedAt: Date) -> Self {
        let attempts = ToolAttempts(count: receipts.count,
            firstReceiptSHA256: receipts.first?.receiptSHA256,
            lastReceiptSHA256: receipts.last?.receiptSHA256)
        let boundedResult = Result(summary: status == "completed" ? "program_completed" : "program_not_completed",
            dataSHA256: local.resultJSON.map { MacLocalProgramDigest.data(Data($0.utf8)) }, artifactRefs: [])
        let failure: Failure
        switch status {
        case "completed": failure = Failure(code: nil, message: nil)
        case "rejected": failure = Failure(code: "proposal_rejected", message: "The local proposal was rejected.")
        case "timed_out": failure = Failure(code: "timeout", message: "The local program exceeded its wall-time limit.")
        case "stopped": failure = Failure(code: "user_stop", message: "The local program was stopped by the user.")
        case "interrupted": failure = Failure(code: "runtime_interrupted", message: "The local runtime was interrupted.")
        case "indeterminate": failure = Failure(code: "indeterminate", message: "A local effect outcome could not be proven.")
        default:
            let receiptFailure = local.error == "receipt_failed"
            let limit = local.error.map { $0.contains("TooLarge") || $0.contains("Budget") || $0.contains("expired") } ?? false
            failure = Failure(code: receiptFailure ? "receipt_failed" : limit ? "limit_exceeded" : "runtime_failed",
                message: receiptFailure ? "The local receipt could not be committed." : limit ? "A local execution limit was exceeded." : "The local runtime failed safely.")
        }
        let material = HashMaterial(version: 1, type: "surface.execution.receipt", receiptID: receiptID,
            executionID: local.executionID, sessionID: local.sessionID, turnID: local.turnID,
            claimant: claimant, runtimeID: local.runtimeID, programSHA256: local.programSHA256,
            catalogSHA256: local.catalogSHA256, bindingsSHA256: local.bindingsSHA256,
            startedAt: local.startedAt, finishedAt: finishedAt, status: status,
            toolAttempts: attempts, result: boundedResult, finalStateSHA256: nil,
            error: failure, previousReceiptSHA256: receipts.last?.receiptSHA256)
        return Self(material: material, receiptSHA256: MacLocalProgramDigest.canonical(material))
    }

    public var hasValidDigest: Bool { receiptSHA256 == MacLocalProgramDigest.canonical(HashMaterial(self)) }

    private init(material: HashMaterial, receiptSHA256: String) {
        version = material.version; type = material.type; receiptID = material.receiptID
        executionID = material.executionID; sessionID = material.sessionID; turnID = material.turnID
        claimant = material.claimant; runtimeID = material.runtimeID; programSHA256 = material.programSHA256
        catalogSHA256 = material.catalogSHA256; bindingsSHA256 = material.bindingsSHA256
        startedAt = material.startedAt; finishedAt = material.finishedAt; status = material.status
        toolAttempts = material.toolAttempts; result = material.result
        finalStateSHA256 = material.finalStateSHA256; error = material.error
        previousReceiptSHA256 = material.previousReceiptSHA256; self.receiptSHA256 = receiptSHA256
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version); try c.encode(type, forKey: .type)
        try c.encode(receiptID, forKey: .receiptID); try c.encode(executionID, forKey: .executionID)
        try c.encode(sessionID, forKey: .sessionID); try c.encode(turnID, forKey: .turnID)
        try c.encode(claimant, forKey: .claimant); try c.encode(runtimeID, forKey: .runtimeID)
        try c.encode(programSHA256, forKey: .programSHA256); try c.encode(catalogSHA256, forKey: .catalogSHA256)
        try c.encode(bindingsSHA256, forKey: .bindingsSHA256)
        if let startedAt { try c.encode(startedAt, forKey: .startedAt) } else { try c.encodeNil(forKey: .startedAt) }
        try c.encode(finishedAt, forKey: .finishedAt); try c.encode(status, forKey: .status)
        try c.encode(toolAttempts, forKey: .toolAttempts); try c.encode(result, forKey: .result)
        if let finalStateSHA256 { try c.encode(finalStateSHA256, forKey: .finalStateSHA256) } else { try c.encodeNil(forKey: .finalStateSHA256) }
        try c.encode(error, forKey: .error)
        if let previousReceiptSHA256 { try c.encode(previousReceiptSHA256, forKey: .previousReceiptSHA256) } else { try c.encodeNil(forKey: .previousReceiptSHA256) }
        try c.encode(receiptSHA256, forKey: .receiptSHA256)
    }

    private struct HashMaterial: Encodable {
        let version: Int, type: String, receiptID: String, executionID: String, sessionID: String, turnID: String
        let claimant: MacReceiptClaimant
        let runtimeID: String, programSHA256: String, catalogSHA256: String, bindingsSHA256: String
        let startedAt: Date?, finishedAt: Date, status: String
        let toolAttempts: ToolAttempts, result: Result
        let finalStateSHA256: String?, error: Failure, previousReceiptSHA256: String?
        init(version: Int, type: String, receiptID: String, executionID: String, sessionID: String,
             turnID: String, claimant: MacReceiptClaimant, runtimeID: String, programSHA256: String,
             catalogSHA256: String, bindingsSHA256: String, startedAt: Date?, finishedAt: Date,
             status: String, toolAttempts: ToolAttempts, result: Result, finalStateSHA256: String?,
             error: Failure, previousReceiptSHA256: String?) {
            self.version = version; self.type = type; self.receiptID = receiptID
            self.executionID = executionID; self.sessionID = sessionID; self.turnID = turnID
            self.claimant = claimant; self.runtimeID = runtimeID; self.programSHA256 = programSHA256
            self.catalogSHA256 = catalogSHA256; self.bindingsSHA256 = bindingsSHA256
            self.startedAt = startedAt; self.finishedAt = finishedAt; self.status = status
            self.toolAttempts = toolAttempts; self.result = result; self.finalStateSHA256 = finalStateSHA256
            self.error = error; self.previousReceiptSHA256 = previousReceiptSHA256
        }
        init(_ receipt: MacProgramTerminalReceipt) {
            self.init(version: receipt.version, type: receipt.type, receiptID: receipt.receiptID,
                executionID: receipt.executionID, sessionID: receipt.sessionID, turnID: receipt.turnID,
                claimant: receipt.claimant, runtimeID: receipt.runtimeID,
                programSHA256: receipt.programSHA256, catalogSHA256: receipt.catalogSHA256,
                bindingsSHA256: receipt.bindingsSHA256, startedAt: receipt.startedAt,
                finishedAt: receipt.finishedAt, status: receipt.status,
                toolAttempts: receipt.toolAttempts, result: receipt.result,
                finalStateSHA256: receipt.finalStateSHA256, error: receipt.error,
                previousReceiptSHA256: receipt.previousReceiptSHA256)
        }
        enum CodingKeys: String, CodingKey {
            case version, type, claimant, status, result, error
            case receiptID = "receipt_id", executionID = "execution_id", sessionID = "session_id", turnID = "turn_id"
            case runtimeID = "runtime_id", programSHA256 = "program_sha256", catalogSHA256 = "catalog_sha256"
            case bindingsSHA256 = "bindings_sha256", startedAt = "started_at", finishedAt = "finished_at"
            case toolAttempts = "tool_attempts", finalStateSHA256 = "final_state_sha256"
            case previousReceiptSHA256 = "previous_receipt_sha256"
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(version, forKey: .version); try c.encode(type, forKey: .type)
            try c.encode(receiptID, forKey: .receiptID); try c.encode(executionID, forKey: .executionID)
            try c.encode(sessionID, forKey: .sessionID); try c.encode(turnID, forKey: .turnID)
            try c.encode(claimant, forKey: .claimant); try c.encode(runtimeID, forKey: .runtimeID)
            try c.encode(programSHA256, forKey: .programSHA256); try c.encode(catalogSHA256, forKey: .catalogSHA256)
            try c.encode(bindingsSHA256, forKey: .bindingsSHA256)
            if let startedAt { try c.encode(startedAt, forKey: .startedAt) } else { try c.encodeNil(forKey: .startedAt) }
            try c.encode(finishedAt, forKey: .finishedAt); try c.encode(status, forKey: .status)
            try c.encode(toolAttempts, forKey: .toolAttempts); try c.encode(result, forKey: .result)
            if let finalStateSHA256 { try c.encode(finalStateSHA256, forKey: .finalStateSHA256) } else { try c.encodeNil(forKey: .finalStateSHA256) }
            try c.encode(error, forKey: .error)
            if let previousReceiptSHA256 { try c.encode(previousReceiptSHA256, forKey: .previousReceiptSHA256) } else { try c.encodeNil(forKey: .previousReceiptSHA256) }
        }
    }
}

public struct MacProgramLifecycleEvent: Codable, Equatable, Sendable {
    public enum Payload: Equatable, Sendable {
        case accepted(proposalSHA256: String)
        case started
        case toolStarted(capabilityID: String, toolCallID: String, attempt: Int)
        case toolFinished(capabilityID: String, toolCallID: String, attempt: Int,
                          status: String, receiptID: String, receiptSHA256: String)
        case approvalRequired(approvalID: String, effectClass: String, capabilityID: String,
                              toolCallID: String, attempt: Int, expiresAt: Date)
        case approvalResolved(approvalID: String, status: String)
        case progress(message: String, completed: Int, total: Int)
        case stopping(reason: String)
        case terminal(status: String, receiptID: String, receiptSHA256: String)
    }
    public let version: Int, type: String, eventID: String, executionID: String
    public let sequence: Int, kind: String
    public let occurredAt: Date
    public let claimant: MacReceiptClaimant
    public let payload: Payload

    public init(eventID: String = "event_\(UUID().uuidString.lowercased())",
                executionID: String, sequence: Int, kind: String, occurredAt: Date,
                claimant: MacReceiptClaimant, payload: Payload) throws {
        guard sequence > 0, !eventID.isEmpty, !executionID.isEmpty,
              Self.kind(of: payload) == kind, Self.valid(payload) else { throw LocalProgramError.invalidInput }
        version = 1; type = "surface.execution.event"; self.eventID = eventID
        self.executionID = executionID; self.sequence = sequence; self.kind = kind
        self.occurredAt = occurredAt; self.claimant = claimant; self.payload = payload
    }

    public static func decodeStrict(_ data: Data) throws -> Self {
        guard case .object(let root) = try MacCanonicalJSON.parse(data),
              Set(root.keys) == ["version", "type", "event_id", "execution_id", "sequence",
                  "kind", "occurred_at", "claimant", "payload"],
              let kind = root["kind"]?.stringValue,
              case .object(let payload) = root["payload"] else { throw LocalProgramError.invalidInput }
        let keys: Set<String>
        switch kind {
        case "accepted": keys = ["proposal_sha256"]
        case "started": keys = []
        case "tool_started": keys = ["capability_id", "tool_call_id", "attempt"]
        case "tool_finished": keys = ["capability_id", "tool_call_id", "attempt", "status", "receipt_id", "receipt_sha256"]
        case "approval_required": keys = ["approval_id", "effect_class", "capability_id", "tool_call_id", "attempt", "expires_at"]
        case "approval_resolved": keys = ["approval_id", "status"]
        case "progress": keys = ["message", "completed", "total"]
        case "stopping": keys = ["reason"]
        case "terminal": keys = ["status", "receipt_id", "receipt_sha256"]
        default: throw LocalProgramError.invalidInput
        }
        guard Set(payload.keys) == keys else { throw LocalProgramError.invalidInput }
        guard let occurred = root["occurred_at"]?.stringValue, MacProtocolTimestamp.parse(occurred) != nil else {
            throw LocalProgramError.invalidInput
        }
        if kind == "approval_required" {
            guard let expires = payload["expires_at"]?.stringValue, MacProtocolTimestamp.parse(expires) != nil else {
                throw LocalProgramError.invalidInput
            }
        }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = MacProtocolTimestamp.decodingStrategy
        do { return try decoder.decode(Self.self, from: data) }
        catch { throw LocalProgramError.invalidInput }
    }

    private static func kind(of payload: Payload) -> String {
        switch payload {
        case .accepted: "accepted"; case .started: "started"
        case .toolStarted: "tool_started"; case .toolFinished: "tool_finished"
        case .approvalRequired: "approval_required"; case .approvalResolved: "approval_resolved"
        case .progress: "progress"
        case .stopping: "stopping"; case .terminal: "terminal"
        }
    }

    private static func valid(_ payload: Payload) -> Bool {
        let digest: (String) -> Bool = { $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
        switch payload {
        case .accepted(let proposal): return digest(proposal)
        case .started: return true
        case .toolStarted(let capability, let call, let attempt):
            return !capability.isEmpty && !call.isEmpty && attempt >= 1
        case .toolFinished(let capability, let call, let attempt, let status, let receipt, let receiptSHA):
            return !capability.isEmpty && !call.isEmpty && attempt >= 1 && !receipt.isEmpty && digest(receiptSHA) &&
                ["succeeded", "failed", "rejected", "stale_state", "timed_out", "stopped", "indeterminate"].contains(status)
        case .approvalRequired(let approval, let effect, let capability, let call, let attempt, _):
            return !approval.isEmpty && !capability.isEmpty && !call.isEmpty && attempt >= 1 &&
                ["read", "navigation", "local_mutation", "external_side_effect", "destructive",
                 "security_sensitive", "financial", "publishing", "sending"].contains(effect)
        case .approvalResolved(let approval, let status):
            return !approval.isEmpty && ["approved", "denied", "expired", "cancelled"].contains(status)
        case .progress(let message, let completed, let total):
            return !message.isEmpty && message.utf8.count <= 240 && completed >= 0 && completed <= total
        case .stopping(let reason): return ["user_stop", "timeout", "policy_revoked", "surface_shutdown"].contains(reason)
        case .terminal(let status, let receipt, let receiptSHA):
            return !receipt.isEmpty && digest(receiptSHA) &&
                ["rejected", "completed", "failed", "timed_out", "stopped", "interrupted", "indeterminate"].contains(status)
        }
    }

    enum CodingKeys: String, CodingKey {
        case version, type, sequence, kind, claimant, payload
        case eventID = "event_id", executionID = "execution_id", occurredAt = "occurred_at"
    }
    private struct Accepted: Codable { let proposalSHA256: String; enum CodingKeys: String, CodingKey { case proposalSHA256 = "proposal_sha256" } }
    private struct ToolStarted: Codable { let capabilityID: String, toolCallID: String, attempt: Int; enum CodingKeys: String, CodingKey { case attempt; case capabilityID = "capability_id", toolCallID = "tool_call_id" } }
    private struct ToolFinished: Codable {
        let capabilityID: String, toolCallID: String, attempt: Int, status: String, receiptID: String, receiptSHA256: String
        enum CodingKeys: String, CodingKey { case attempt, status; case capabilityID = "capability_id", toolCallID = "tool_call_id", receiptID = "receipt_id", receiptSHA256 = "receipt_sha256" }
    }
    private struct Stopping: Codable { let reason: String }
    private struct ApprovalRequired: Codable {
        let approvalID: String, effectClass: String, capabilityID: String, toolCallID: String, attempt: Int, expiresAt: Date
        enum CodingKeys: String, CodingKey { case attempt; case approvalID = "approval_id", effectClass = "effect_class", capabilityID = "capability_id", toolCallID = "tool_call_id", expiresAt = "expires_at" }
    }
    private struct ApprovalResolved: Codable { let approvalID: String, status: String; enum CodingKeys: String, CodingKey { case status; case approvalID = "approval_id" } }
    private struct Progress: Codable { let message: String, completed: Int, total: Int }
    private struct Terminal: Codable { let status: String, receiptID: String, receiptSHA256: String; enum CodingKeys: String, CodingKey { case status; case receiptID = "receipt_id", receiptSHA256 = "receipt_sha256" } }
    private struct Empty: Codable {}

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version); try container.encode(type, forKey: .type)
        try container.encode(eventID, forKey: .eventID); try container.encode(executionID, forKey: .executionID)
        try container.encode(sequence, forKey: .sequence); try container.encode(kind, forKey: .kind)
        try container.encode(occurredAt, forKey: .occurredAt); try container.encode(claimant, forKey: .claimant)
        switch payload {
        case .accepted(let digest): try container.encode(Accepted(proposalSHA256: digest), forKey: .payload)
        case .started: try container.encode(Empty(), forKey: .payload)
        case .toolStarted(let capability, let call, let attempt):
            try container.encode(ToolStarted(capabilityID: capability, toolCallID: call, attempt: attempt), forKey: .payload)
        case .toolFinished(let capability, let call, let attempt, let status, let receipt, let digest):
            try container.encode(ToolFinished(capabilityID: capability, toolCallID: call, attempt: attempt,
                status: status, receiptID: receipt, receiptSHA256: digest), forKey: .payload)
        case .approvalRequired(let approval, let effect, let capability, let call, let attempt, let expiry):
            try container.encode(ApprovalRequired(approvalID: approval, effectClass: effect,
                capabilityID: capability, toolCallID: call, attempt: attempt, expiresAt: expiry), forKey: .payload)
        case .approvalResolved(let approval, let status):
            try container.encode(ApprovalResolved(approvalID: approval, status: status), forKey: .payload)
        case .progress(let message, let completed, let total):
            try container.encode(Progress(message: message, completed: completed, total: total), forKey: .payload)
        case .stopping(let reason): try container.encode(Stopping(reason: reason), forKey: .payload)
        case .terminal(let status, let receipt, let digest):
            try container.encode(Terminal(status: status, receiptID: receipt, receiptSHA256: digest), forKey: .payload)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        let type = try container.decode(String.self, forKey: .type)
        let eventID = try container.decode(String.self, forKey: .eventID)
        let executionID = try container.decode(String.self, forKey: .executionID)
        let sequence = try container.decode(Int.self, forKey: .sequence)
        let kind = try container.decode(String.self, forKey: .kind)
        let occurredAt = try container.decode(Date.self, forKey: .occurredAt)
        let claimant = try container.decode(MacReceiptClaimant.self, forKey: .claimant)
        let payload: Payload
        switch kind {
        case "accepted": payload = .accepted(proposalSHA256: try container.decode(Accepted.self, forKey: .payload).proposalSHA256)
        case "started": _ = try container.decode(Empty.self, forKey: .payload); payload = .started
        case "tool_started": let value = try container.decode(ToolStarted.self, forKey: .payload); payload = .toolStarted(capabilityID: value.capabilityID, toolCallID: value.toolCallID, attempt: value.attempt)
        case "tool_finished": let value = try container.decode(ToolFinished.self, forKey: .payload); payload = .toolFinished(capabilityID: value.capabilityID, toolCallID: value.toolCallID, attempt: value.attempt, status: value.status, receiptID: value.receiptID, receiptSHA256: value.receiptSHA256)
        case "approval_required": let value = try container.decode(ApprovalRequired.self, forKey: .payload); payload = .approvalRequired(approvalID: value.approvalID, effectClass: value.effectClass, capabilityID: value.capabilityID, toolCallID: value.toolCallID, attempt: value.attempt, expiresAt: value.expiresAt)
        case "approval_resolved": let value = try container.decode(ApprovalResolved.self, forKey: .payload); payload = .approvalResolved(approvalID: value.approvalID, status: value.status)
        case "progress": let value = try container.decode(Progress.self, forKey: .payload); payload = .progress(message: value.message, completed: value.completed, total: value.total)
        case "stopping": payload = .stopping(reason: try container.decode(Stopping.self, forKey: .payload).reason)
        case "terminal": let value = try container.decode(Terminal.self, forKey: .payload); payload = .terminal(status: value.status, receiptID: value.receiptID, receiptSHA256: value.receiptSHA256)
        default: throw LocalProgramError.invalidInput
        }
        guard version == 1, type == "surface.execution.event" else { throw LocalProgramError.invalidInput }
        try self.init(eventID: eventID, executionID: executionID, sequence: sequence,
            kind: kind, occurredAt: occurredAt, claimant: claimant, payload: payload)
    }
}

public struct MacProgramPendingTool: Codable, Equatable, Sendable {
    public let toolCallID: String, capabilityID: String, inputSHA256: String, preStateSHA256: String
    public let effectClass: String
    public let sequence: Int
    public let startedAt: Date
    public init(toolCallID: String, capabilityID: String, inputSHA256: String,
                preStateSHA256: String, effectClass: String = "read", sequence: Int, startedAt: Date) {
        self.toolCallID = toolCallID; self.capabilityID = capabilityID
        self.inputSHA256 = inputSHA256; self.preStateSHA256 = preStateSHA256
        self.effectClass = effectClass
        self.sequence = sequence; self.startedAt = startedAt
    }
    enum CodingKeys: String, CodingKey {
        case sequence; case toolCallID = "tool_call_id", capabilityID = "capability_id", effectClass = "effect_class"
        case inputSHA256 = "input_sha256", preStateSHA256 = "pre_state_sha256", startedAt = "started_at"
    }
}

public enum MacProgramClaim: Equatable, Sendable {
    case accepted
    case replay(MacLocalProgramResult?)
}

public protocol MacProgramJournaling: AnyObject, Sendable {
    func reject(_ envelope: MacLocalProgramEnvelope, claimantDeviceID: String,
                clientInstanceID: String, reason: String, at: Date) throws -> MacLocalProgramResult
    func claim(_ envelope: MacLocalProgramEnvelope, claimantDeviceID: String,
               clientInstanceID: String, at: Date) throws -> MacProgramClaim
    func markStarted(executionID: String, at: Date) throws
    func beginTool(executionID: String, pending: MacProgramPendingTool) throws
    func finishTool(executionID: String, receipt: MacLocalActionReceipt, at: Date) throws
    func requireApproval(executionID: String, approvalID: String, effectClass: String,
                         capabilityID: String, toolCallID: String, expiresAt: Date, at: Date) throws
    func resolveApproval(executionID: String, approvalID: String, status: String, at: Date) throws
    func recordProgress(executionID: String, message: String,
                        completed: Int, total: Int, at: Date) throws
    func finish(executionID: String, result: MacLocalProgramResult, at: Date) throws
    func requestStop(executionID: String, at: Date) throws
    func isStopRequested(executionID: String) throws -> Bool
    func events(executionID: String) throws -> [MacProgramLifecycleEvent]
    func toolReceipts(executionID: String) throws -> [MacLocalActionReceipt]
    func terminalReceipt(executionID: String) throws -> MacProgramTerminalReceipt?
}

public extension MacProgramJournaling {
    func reject(_ envelope: MacLocalProgramEnvelope, claimantDeviceID: String,
                clientInstanceID: String, at: Date) throws -> MacLocalProgramResult {
        try reject(envelope, claimantDeviceID: claimantDeviceID,
            clientInstanceID: clientInstanceID, reason: "proposal_rejected", at: at)
    }
}

/// A closed, fsync-backed snapshot journal. It persists only identifiers,
/// digests, bounded receipt summaries, and lifecycle state—never source,
/// result JSON, AX labels/trees, values, screenshots, environment, or tokens.
public final class AtomicFileMacProgramJournal: MacProgramJournaling, @unchecked Sendable {
    private struct ApprovalRecord: Codable {
        let effectClass: String, capabilityID: String, toolCallID: String, expiresAt: Date
        var status: String
        var consumed: Bool
    }
    private struct Record: Codable {
        let executionID: String, idempotencyKey: String, sessionID: String, turnID: String
        let claimantDeviceID: String, clientInstanceID: String
        let runtimeID: String, proposalSHA256: String, programSHA256: String, catalogSHA256: String, bindingsSHA256: String
        let initialStateSHA256: String
        let proposalExpiresAt: Date
        var nextSequence: Int
        var stopRequested: Bool
        var events: [MacProgramLifecycleEvent]
        var pending: [String: MacProgramPendingTool]
        var approvals: [String: ApprovalRecord]
        var receipts: [MacLocalActionReceipt]
        var terminal: MacLocalProgramResult?
        var terminalReceipt: MacProgramTerminalReceipt?
    }
    private struct State: Codable { var records: [String: Record] = [:] }

    private let fileURL: URL
    private let lockURL: URL

    public init(fileURL: URL) throws {
        guard fileURL.isFileURL, !fileURL.path.isEmpty else { throw LocalProgramError.invalidInput }
        self.fileURL = fileURL
        self.lockURL = fileURL.appendingPathExtension("lock")
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
    }

    public func reject(_ envelope: MacLocalProgramEnvelope, claimantDeviceID: String,
                       clientInstanceID: String, reason: String, at: Date) throws -> MacLocalProgramResult {
        try mutate { state in
            if let existing = state.records[envelope.executionID] {
                guard existing.proposalSHA256 == envelope.proposalSHA256,
                      existing.claimantDeviceID == claimantDeviceID,
                      existing.clientInstanceID == clientInstanceID,
                      let terminal = existing.terminal else { throw LocalProgramError.replayed }
                return terminal
            }
            guard !state.records.values.contains(where: { $0.idempotencyKey == envelope.idempotencyKey })
            else { throw LocalProgramError.replayed }
            let claimant = MacReceiptClaimant(deviceID: claimantDeviceID,
                clientInstanceID: clientInstanceID)
            let local = MacLocalProgramResult(executionID: envelope.executionID,
                sessionID: envelope.sessionID, turnID: envelope.turnID,
                claimantDeviceID: claimantDeviceID, runtimeID: envelope.runtime.runtimeID,
                status: "rejected", resultJSON: nil, error: reason, toolCalls: 0,
                receipts: [], programSHA256: envelope.program.sha256,
                catalogSHA256: envelope.catalog.sha256,
                bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings),
                startedAt: nil, finishedAt: at)
            let terminalReceipt = MacProgramTerminalReceipt.make(
                receiptID: "receipt_\(UUID().uuidString.lowercased())", result: local,
                claimant: claimant, receipts: [], status: "rejected", finishedAt: at)
            let event = try MacProgramLifecycleEvent(executionID: envelope.executionID,
                sequence: 1, kind: "terminal", occurredAt: at, claimant: claimant,
                payload: .terminal(status: "rejected", receiptID: terminalReceipt.receiptID,
                    receiptSHA256: terminalReceipt.receiptSHA256))
            state.records[envelope.executionID] = Record(executionID: envelope.executionID,
                idempotencyKey: envelope.idempotencyKey, sessionID: envelope.sessionID,
                turnID: envelope.turnID, claimantDeviceID: claimantDeviceID,
                clientInstanceID: clientInstanceID, runtimeID: envelope.runtime.runtimeID,
                proposalSHA256: envelope.proposalSHA256,
                programSHA256: envelope.program.sha256, catalogSHA256: envelope.catalog.sha256,
                bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings),
                initialStateSHA256: envelope.bindings.stateSHA256,
                proposalExpiresAt: envelope.expiresAt, nextSequence: 2, stopRequested: false,
                events: [event], pending: [:], approvals: [:], receipts: [], terminal: local,
                terminalReceipt: terminalReceipt)
            return local
        }
    }

    public func claim(_ envelope: MacLocalProgramEnvelope, claimantDeviceID: String,
                      clientInstanceID: String, at: Date) throws -> MacProgramClaim {
        try mutate { state in
            if let record = state.records[envelope.executionID] {
                guard record.idempotencyKey == envelope.idempotencyKey,
                      record.programSHA256 == envelope.program.sha256,
                      record.catalogSHA256 == envelope.catalog.sha256,
                      record.bindingsSHA256 == MacLocalProgramDigest.bindings(envelope.bindings),
                      record.claimantDeviceID == claimantDeviceID,
                      record.clientInstanceID == clientInstanceID,
                      record.proposalSHA256 == envelope.proposalSHA256
                else { throw LocalProgramError.replayed }
                return .replay(record.terminal)
            }
            guard !state.records.values.contains(where: { $0.idempotencyKey == envelope.idempotencyKey })
            else { throw LocalProgramError.replayed }
            let proposalSHA256 = envelope.proposalSHA256
            let claimant = MacReceiptClaimant(deviceID: claimantDeviceID, clientInstanceID: clientInstanceID)
            let event = try MacProgramLifecycleEvent(executionID: envelope.executionID,
                sequence: 1, kind: "accepted", occurredAt: at, claimant: claimant,
                payload: .accepted(proposalSHA256: proposalSHA256))
            state.records[envelope.executionID] = Record(executionID: envelope.executionID,
                idempotencyKey: envelope.idempotencyKey, sessionID: envelope.sessionID,
                turnID: envelope.turnID, claimantDeviceID: claimantDeviceID,
                clientInstanceID: clientInstanceID, runtimeID: envelope.runtime.runtimeID,
                proposalSHA256: proposalSHA256,
                programSHA256: envelope.program.sha256, catalogSHA256: envelope.catalog.sha256,
                bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings),
                initialStateSHA256: envelope.bindings.stateSHA256,
                proposalExpiresAt: envelope.expiresAt, nextSequence: 2,
                stopRequested: false, events: [event], pending: [:], approvals: [:], receipts: [], terminal: nil,
                terminalReceipt: nil)
            return .accepted
        }
    }

    public func markStarted(executionID: String, at: Date) throws {
        try update(executionID) { record in
            guard record.terminal == nil, !record.stopRequested else { throw LocalProgramError.stopped }
            try Self.append(kind: "started", at: at, to: &record)
        }
    }

    public func beginTool(executionID: String, pending: MacProgramPendingTool) throws {
        try update(executionID) { record in
            guard record.terminal == nil, !record.stopRequested else { throw LocalProgramError.stopped }
            guard record.pending[pending.toolCallID] == nil,
                  !record.receipts.contains(where: { $0.toolCallID == pending.toolCallID }),
                  pending.preStateSHA256 == (record.receipts.last(where: {
                      $0.postStateSHA256 != nil
                  })?.postStateSHA256 ?? record.initialStateSHA256)
            else { throw LocalProgramError.replayed }
            record.pending[pending.toolCallID] = pending
            try Self.append(kind: "tool_started", at: pending.startedAt,
                capabilityID: pending.capabilityID, toolCallID: pending.toolCallID, to: &record)
        }
    }

    public func finishTool(executionID: String, receipt: MacLocalActionReceipt, at: Date) throws {
        try update(executionID) { record in
            guard record.terminal == nil else { throw LocalProgramError.replayed }
            guard receipt.hasValidDigest,
                  receipt.version == 1, receipt.type == "surface.execution.tool_receipt",
                  receipt.attempt == 1, receipt.startedAt <= receipt.finishedAt,
                  ["succeeded", "failed", "rejected", "stale_state", "timed_out", "stopped", "indeterminate"].contains(receipt.status),
                  Self.isDigest(receipt.programSHA256), Self.isDigest(receipt.catalogSHA256),
                  Self.isDigest(receipt.bindingsSHA256), Self.isDigest(receipt.inputSHA256),
                  Self.isDigest(receipt.preStateSHA256),
                  receipt.postStateSHA256.map(Self.isDigest) ?? true,
                  receipt.result.dataSHA256.map(Self.isDigest) ?? true,
                  ["semantic_ax_action_executed", "bounded_local_read_completed",
                   "local_capability_did_not_complete", "local_capability_outcome_indeterminate"].contains(receipt.result.summary),
                  receipt.executionID == record.executionID,
                  receipt.claimant == MacReceiptClaimant(deviceID: record.claimantDeviceID,
                    clientInstanceID: record.clientInstanceID),
                  receipt.programSHA256 == record.programSHA256,
                  receipt.catalogSHA256 == record.catalogSHA256,
                  receipt.bindingsSHA256 == record.bindingsSHA256,
                  receipt.previousReceiptSHA256 == record.receipts.last?.receiptSHA256,
                  let pending = record.pending[receipt.toolCallID],
                  pending.capabilityID == receipt.capabilityID,
                  pending.inputSHA256 == receipt.inputSHA256,
                  pending.preStateSHA256 == receipt.preStateSHA256
            else { throw LocalProgramError.replayed }
            guard pending.effectClass == "read" || receipt.status != "succeeded" || receipt.postStateSHA256 != nil
            else { throw LocalProgramError.replayed }
            let approvals = record.approvals.filter { $0.value.toolCallID == receipt.toolCallID }
            if let approvalID = receipt.approvalID {
                guard var approval = record.approvals[approvalID], approval.status == "approved", !approval.consumed,
                      approval.toolCallID == receipt.toolCallID, approval.capabilityID == receipt.capabilityID,
                      approval.effectClass == pending.effectClass else { throw LocalProgramError.replayed }
                approval.consumed = true; record.approvals[approvalID] = approval
            } else if approvals.values.contains(where: { $0.status == "approved" }) {
                throw LocalProgramError.replayed
            }
            record.pending.removeValue(forKey: receipt.toolCallID)
            record.receipts.append(receipt)
            try Self.append(kind: "tool_finished", at: at, capabilityID: receipt.capabilityID,
                toolCallID: receipt.toolCallID, status: receipt.status, to: &record)
        }
    }

    public func requireApproval(executionID: String, approvalID: String, effectClass: String,
                                capabilityID: String, toolCallID: String, expiresAt: Date, at: Date) throws {
        try update(executionID) { record in
            guard record.terminal == nil, record.pending[toolCallID] != nil,
                  record.approvals[approvalID] == nil, expiresAt <= record.proposalExpiresAt,
                  expiresAt > at else { throw LocalProgramError.replayed }
            guard let pending = record.pending[toolCallID], pending.capabilityID == capabilityID,
                  pending.effectClass == effectClass else { throw LocalProgramError.replayed }
            record.approvals[approvalID] = ApprovalRecord(effectClass: effectClass,
                capabilityID: capabilityID, toolCallID: toolCallID, expiresAt: expiresAt,
                status: "pending", consumed: false)
            try Self.append(kind: "approval_required", at: at, capabilityID: capabilityID,
                toolCallID: toolCallID, status: effectClass, approvalID: approvalID,
                approvalExpiresAt: expiresAt, to: &record)
        }
    }

    public func resolveApproval(executionID: String, approvalID: String, status: String, at: Date) throws {
        try update(executionID) { record in
            guard record.terminal == nil, ["approved", "denied", "expired", "cancelled"].contains(status),
                  var approval = record.approvals[approvalID], approval.status == "pending",
                  (status == "expired" ? at >= approval.expiresAt : at < approval.expiresAt) else {
                throw LocalProgramError.replayed
            }
            approval.status = status; record.approvals[approvalID] = approval
            try Self.append(kind: "approval_resolved", at: at, status: status,
                approvalID: approvalID, to: &record)
        }
    }

    public func recordProgress(executionID: String, message: String,
                               completed: Int, total: Int, at: Date) throws {
        try update(executionID) { record in
            guard record.terminal == nil, !record.stopRequested else {
                throw LocalProgramError.stopped
            }
            try Self.append(kind: "progress", at: at, status: message,
                progressCompleted: completed, progressTotal: total, to: &record)
        }
    }

    public func finish(executionID: String, result: MacLocalProgramResult, at: Date) throws {
        try update(executionID) { record in
            if let terminal = record.terminal {
                guard terminal.status == result.status,
                      terminal.programSHA256 == result.programSHA256,
                      terminal.catalogSHA256 == result.catalogSHA256,
                      terminal.bindingsSHA256 == result.bindingsSHA256
                else { throw LocalProgramError.replayed }
                return
            }
            let status = record.pending.isEmpty ? result.status : "interrupted"
            record.pending.removeAll()
            record.terminal = MacLocalProgramResult(executionID: result.executionID,
                sessionID: result.sessionID, turnID: result.turnID,
                claimantSurfaceType: result.claimantSurfaceType,
                claimantDeviceID: result.claimantDeviceID, runtimeID: result.runtimeID,
                status: status, resultJSON: nil, error: result.error,
                toolCalls: result.toolCalls, receipts: record.receipts,
                programSHA256: result.programSHA256, catalogSHA256: result.catalogSHA256,
                bindingsSHA256: result.bindingsSHA256, startedAt: result.startedAt, finishedAt: at)
            record.terminalReceipt = MacProgramTerminalReceipt.make(
                receiptID: "receipt_\(UUID().uuidString.lowercased())", result: result,
                claimant: .init(deviceID: record.claimantDeviceID,
                    clientInstanceID: record.clientInstanceID), receipts: record.receipts,
                status: status, finishedAt: at)
            try Self.append(kind: "terminal", at: at, status: status, to: &record)
        }
    }

    public func requestStop(executionID: String, at: Date) throws {
        try update(executionID) { record in
            guard record.terminal == nil else { return }
            if !record.stopRequested {
                record.stopRequested = true
                try Self.append(kind: "stopping", at: at, to: &record)
            }
        }
    }

    public func isStopRequested(executionID: String) throws -> Bool {
        try read { state in
            guard let record = state.records[executionID] else { throw LocalProgramError.invalidEnvelope }
            return record.stopRequested
        }
    }

    public func events(executionID: String) throws -> [MacProgramLifecycleEvent] {
        try read { state in
            guard let record = state.records[executionID] else { throw LocalProgramError.invalidEnvelope }
            return record.events
        }
    }

    public func toolReceipts(executionID: String) throws -> [MacLocalActionReceipt] {
        try read { state in
            guard let record = state.records[executionID] else { throw LocalProgramError.invalidEnvelope }
            guard record.receipts.allSatisfy(\.hasValidDigest) else {
                throw LocalProgramError.executionFailed("tool receipt digest mismatch")
            }
            return record.receipts
        }
    }

    public func terminalReceipt(executionID: String) throws -> MacProgramTerminalReceipt? {
        try read { state in
            guard let record = state.records[executionID] else { throw LocalProgramError.invalidEnvelope }
            guard record.terminalReceipt?.hasValidDigest != false else {
                throw LocalProgramError.executionFailed("terminal receipt digest mismatch")
            }
            return record.terminalReceipt
        }
    }

    private static func append(kind: String, at: Date, capabilityID: String? = nil,
                               toolCallID: String? = nil, status: String? = nil,
                               approvalID: String? = nil, approvalExpiresAt: Date? = nil,
                               progressCompleted: Int? = nil, progressTotal: Int? = nil,
                               to record: inout Record) throws {
        let claimant = MacReceiptClaimant(deviceID: record.claimantDeviceID,
            clientInstanceID: record.clientInstanceID)
        guard record.events.last.map({ at >= $0.occurredAt }) ?? true else {
            throw LocalProgramError.invalidInput
        }
        let payload: MacProgramLifecycleEvent.Payload
        switch kind {
        case "started": payload = .started
        case "tool_started":
            guard let capabilityID, let toolCallID else { throw LocalProgramError.invalidInput }
            payload = .toolStarted(capabilityID: capabilityID, toolCallID: toolCallID, attempt: 1)
        case "tool_finished":
            guard let receipt = record.receipts.last, let capabilityID, let toolCallID, let status
            else { throw LocalProgramError.invalidInput }
            payload = .toolFinished(capabilityID: capabilityID, toolCallID: toolCallID, attempt: 1,
                status: status, receiptID: receipt.receiptID, receiptSHA256: receipt.receiptSHA256)
        case "stopping": payload = .stopping(reason: "user_stop")
        case "approval_required":
            guard let approvalID, let status, let capabilityID, let toolCallID, let approvalExpiresAt
            else { throw LocalProgramError.invalidInput }
            payload = .approvalRequired(approvalID: approvalID, effectClass: status,
                capabilityID: capabilityID, toolCallID: toolCallID, attempt: 1, expiresAt: approvalExpiresAt)
        case "approval_resolved":
            guard let approvalID, let status else { throw LocalProgramError.invalidInput }
            payload = .approvalResolved(approvalID: approvalID, status: status)
        case "progress":
            guard let status, let progressCompleted, let progressTotal else {
                throw LocalProgramError.invalidInput
            }
            payload = .progress(message: status, completed: progressCompleted, total: progressTotal)
        case "terminal":
            guard let receipt = record.terminalReceipt, let status else { throw LocalProgramError.invalidInput }
            payload = .terminal(status: status, receiptID: receipt.receiptID,
                receiptSHA256: receipt.receiptSHA256)
        default: throw LocalProgramError.invalidInput
        }
        let event = try MacProgramLifecycleEvent(executionID: record.executionID,
            sequence: record.nextSequence, kind: kind, occurredAt: at,
            claimant: claimant, payload: payload)
        record.events.append(event); record.nextSequence += 1
    }

    private static func isDigest(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    private func update<T>(_ executionID: String, _ body: (inout Record) throws -> T) throws -> T {
        try mutate { state in
            guard var record = state.records[executionID] else { throw LocalProgramError.invalidEnvelope }
            let result = try body(&record); state.records[executionID] = record; return result
        }
    }

    private func read<T>(_ body: (State) throws -> T) throws -> T {
        try withLock { try body(try load()) }
    }

    private func mutate<T>(_ body: (inout State) throws -> T) throws -> T {
        try withLock {
            var state = try load()
            let result = try body(&state)
            try persist(state)
            return result
        }
    }

    private func withLock<T>(_ body: () throws -> T) throws -> T {
        let descriptor = Darwin.open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw LocalProgramError.executionFailed("journal lock unavailable") }
        defer { flock(descriptor, LOCK_UN); close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw LocalProgramError.executionFailed("journal lock unavailable") }
        return try body()
    }

    private func load() throws -> State {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return State() }
        do {
            let decoder = JSONDecoder(); decoder.dateDecodingStrategy = MacProtocolTimestamp.decodingStrategy
            return try decoder.decode(State.self, from: Data(contentsOf: fileURL))
        } catch { throw LocalProgramError.executionFailed("journal is unreadable") }
    }

    private func persist(_ state: State) throws {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = MacProtocolTimestamp.encodingStrategy; encoder.outputFormatting = [.sortedKeys]
        let data: Data
        do { data = try encoder.encode(state) }
        catch { throw LocalProgramError.executionFailed("journal encoding failed") }
        let temporary = fileURL.appendingPathExtension("tmp.\(UUID().uuidString)")
        let descriptor = Darwin.open(temporary.path, O_CREAT | O_EXCL | O_WRONLY, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw LocalProgramError.executionFailed("journal write unavailable") }
        var succeeded = false
        defer { close(descriptor); if !succeeded { unlink(temporary.path) } }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                guard count > 0 else { throw LocalProgramError.executionFailed("journal write failed") }
                offset += count
            }
        }
        guard fsync(descriptor) == 0, rename(temporary.path, fileURL.path) == 0 else {
            throw LocalProgramError.executionFailed("journal durability failed")
        }
        succeeded = true
        let directory = Darwin.open(fileURL.deletingLastPathComponent().path, O_RDONLY)
        guard directory >= 0 else { throw LocalProgramError.executionFailed("journal directory unavailable") }
        defer { close(directory) }
        guard fsync(directory) == 0 else { throw LocalProgramError.executionFailed("journal durability failed") }
    }
}
#endif
