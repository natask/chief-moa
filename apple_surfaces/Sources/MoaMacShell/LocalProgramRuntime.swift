#if os(macOS)
import Foundation
import MoaMacCore

public struct MacProgramApprovalDecision: Sendable {
    public let approvalID: String
    public let status: String
    public init(approvalID: String, status: String) { self.approvalID = approvalID; self.status = status }
}

public protocol MacProgramApprovalAuthorizing: Sendable {
    func resolve(approvalID: String, effectClass: String, capabilityID: String,
                 executionID: String, expiresAt: Date) -> MacProgramApprovalDecision
}

/// Parent-side semantic capability broker. The JavaScript helper has no direct
/// AppKit, Accessibility, filesystem, network, Apple Events, JXA, or shell bridge.
final class MacProgramBridge: @unchecked Sendable {
    private let authority: any MacAccessibilityProgramAuthority
    private let executionID: String
    private let allowed: Set<String>
    private let maximumCalls: Int
    private let deadline: Date
    private var preStateSHA256: String
    private let journal: any MacProgramJournaling
    private let claimant: MacReceiptClaimant
    private let programSHA256: String
    private let catalogSHA256: String
    private let bindingsSHA256: String
    private let now: @Sendable () -> Date
    private let isRevoked: @Sendable () -> Bool
    private let bindings: MacLocalProgramEnvelope.Bindings?
    private let alwaysAsk: Set<String>
    private let approvalAuthorizer: (any MacProgramApprovalAuthorizing)?
    private(set) var calls = 0
    private(set) var receipts: [MacLocalActionReceipt] = []
    private(set) var failure: LocalProgramError?

    init(authority: any MacAccessibilityProgramAuthority, executionID: String,
         allowed: Set<String>, maximumCalls: Int, deadline: Date,
         preStateSHA256: String,
         journal: any MacProgramJournaling,
         claimant: MacReceiptClaimant, programSHA256: String,
         catalogSHA256: String, bindingsSHA256: String,
         bindings: MacLocalProgramEnvelope.Bindings? = nil,
         alwaysAsk: Set<String> = [], approvalAuthorizer: (any MacProgramApprovalAuthorizing)? = nil,
         isRevoked: @escaping @Sendable () -> Bool = { false },
         now: @escaping @Sendable () -> Date) {
        self.authority = authority
        self.executionID = executionID
        self.allowed = allowed
        self.maximumCalls = maximumCalls
        self.deadline = deadline
        self.preStateSHA256 = preStateSHA256
        self.journal = journal
        self.claimant = claimant; self.programSHA256 = programSHA256
        self.catalogSHA256 = catalogSHA256; self.bindingsSHA256 = bindingsSHA256
        self.bindings = bindings; self.alwaysAsk = alwaysAsk; self.approvalAuthorizer = approvalAuthorizer
        self.isRevoked = isRevoked
        self.now = now
    }

    func call(_ capabilityID: String, _ inputJSON: String) -> String {
        let startedAt = now()
        var inputDigest: String?
        var toolCallID: String?
        var consumedApprovalID: String?
        do {
            if let failure { throw failure }
            guard try !journal.isStopRequested(executionID: executionID) else {
                throw LocalProgramError.stopped
            }
            let calledAt = startedAt
            calls += 1
            let data = Data(inputJSON.utf8)
            let parsed = try? MacCanonicalJSON.parse(data)
            inputDigest = MacLocalProgramDigest.data(parsed?.canonicalData ?? data)
            let callID = "call_\(executionID)_\(calls)"
            toolCallID = callID
            let effectClass = MacLocalProgramAdvertisement.descriptors.first {
                $0.capabilityID == capabilityID
            }?.effectClass ?? "external_side_effect"
            try journal.beginTool(executionID: executionID,
                pending: .init(toolCallID: callID, capabilityID: capabilityID,
                    inputSHA256: inputDigest!, preStateSHA256: preStateSHA256,
                    effectClass: effectClass, sequence: calls, startedAt: calledAt))
            guard data.count <= 8 * 1024, let canonical = parsed,
                  case .object(let input) = canonical else { throw LocalProgramError.invalidInput }
            try Self.validateInput(capabilityID: capabilityID, input: input)
            guard calledAt < deadline else { throw LocalProgramError.expired }
            guard calls <= maximumCalls else { throw LocalProgramError.toolBudgetExceeded }
            guard allowed.contains(capabilityID) else { throw LocalProgramError.capabilityDenied }
            if alwaysAsk.contains(effectClass) || effectClass != "read" {
                let approvalID = "approval_\(UUID().uuidString.lowercased())"
                let expiresAt = min(deadline, calledAt.addingTimeInterval(60))
                try journal.requireApproval(executionID: executionID, approvalID: approvalID,
                    effectClass: effectClass, capabilityID: capabilityID, toolCallID: callID,
                    expiresAt: expiresAt, at: calledAt)
                let decision = approvalAuthorizer?.resolve(approvalID: approvalID,
                    effectClass: effectClass, capabilityID: capabilityID,
                    executionID: executionID, expiresAt: expiresAt) ??
                    .init(approvalID: approvalID, status: "denied")
                let resolvedAt = now()
                let validDecision = decision.approvalID == approvalID &&
                    ["approved", "denied", "expired", "cancelled"].contains(decision.status)
                let resolution = !validDecision ? "cancelled" :
                    (decision.status == "approved" && resolvedAt >= expiresAt ? "expired" : decision.status)
                try journal.resolveApproval(executionID: executionID, approvalID: approvalID,
                    status: resolution, at: resolvedAt)
                guard resolution == "approved" else {
                    throw LocalProgramError.approvalRequired
                }
                consumedApprovalID = approvalID
            }
            if let bindings { try authority.validate(bindings: bindings, now: now()) }

            let output: String
            switch capabilityID {
            case "macos.accessibility.observe":
                output = try Self.json(authority.observe(now: calledAt))
            case "macos.accessibility.find":
                let observation = try authority.observe(now: calledAt)
                let role = input["role"]?.stringValue
                let label = input["label"]?.stringValue
                output = try Self.json(observation.nodes.filter {
                    (role == nil || $0.role == role) && (label == nil || $0.label == label)
                })
            case "macos.app.current":
                let observation = try authority.observe(now: calledAt)
                output = try Self.json(CurrentApplication(name: observation.applicationName,
                    bundleID: observation.binding.bundleID, pid: observation.binding.pid))
            case "macos.window.current":
                let observation = try authority.observe(now: calledAt)
                output = try Self.json(CurrentWindow(title: observation.windowTitle,
                    windowID: observation.binding.windowID,
                    observationID: observation.binding.observationID))
            default:
                let request = try JSONDecoder().decode(MacAXActionRequest.self, from: canonical.canonicalData)
                let expected = "macos.accessibility.\(request.action)"
                guard capabilityID == expected else { throw LocalProgramError.invalidInput }
                let outcome = try authority.perform(request, executionID: executionID,
                    sequence: calls, now: calledAt)
                let stopRequested = try journal.isStopRequested(executionID: executionID)
                if (effectClass != "read" && outcome.postStateSHA256 == nil) || isRevoked() || stopRequested {
                    let uncertain = receipt(receiptID: "tool_receipt_\(UUID().uuidString.lowercased())",
                        toolCallID: callID, capabilityID: capabilityID, attempt: 1,
                        inputSHA256: inputDigest!, status: "indeterminate",
                        summary: "local_capability_outcome_indeterminate", resourceID: nil,
                        postStateSHA256: nil, approvalID: consumedApprovalID,
                        startedAt: startedAt, finishedAt: now())
                    try commit(uncertain, at: now()); failure = .indeterminate
                    return Self.errorJSON(.indeterminate)
                }
                let normalized = receipt(receiptID: "tool_receipt_\(UUID().uuidString.lowercased())",
                    toolCallID: callID, capabilityID: capabilityID, attempt: 1,
                    inputSHA256: inputDigest!, status: "succeeded",
                    summary: "semantic_ax_action_executed", resourceID: outcome.resourceID,
                    postStateSHA256: outcome.postStateSHA256,
                    approvalID: consumedApprovalID,
                    startedAt: startedAt, finishedAt: now())
                try commit(normalized, at: now())
                if let postState = normalized.postStateSHA256 { preStateSHA256 = postState }
                return try Self.json(normalized)
            }
            guard !isRevoked(), try !journal.isStopRequested(executionID: executionID) else {
                throw LocalProgramError.stopped
            }
            let receipt = self.receipt(receiptID: "tool_receipt_\(UUID().uuidString.lowercased())",
                toolCallID: callID, capabilityID: capabilityID, attempt: 1,
                inputSHA256: inputDigest!, status: "succeeded", summary: "bounded_local_read_completed",
                resourceID: nil, postStateSHA256: nil,
                startedAt: startedAt, finishedAt: now())
            try commit(receipt, at: now())
            return output
        }
        catch let error as LocalProgramError {
            failure = error
            if error == .receiptFailed { return Self.errorJSON(error) }
            let receipt = self.receipt(receiptID: "tool_receipt_\(UUID().uuidString.lowercased())",
                toolCallID: toolCallID ?? "call_\(executionID)_rejected_\(calls + 1)",
                capabilityID: capabilityID, attempt: 1,
                inputSHA256: inputDigest ?? MacLocalProgramDigest.data(Data()),
                status: Self.receiptStatus(error), summary: "local_capability_did_not_complete",
                resourceID: nil, postStateSHA256: nil,
                approvalID: consumedApprovalID,
                startedAt: startedAt, finishedAt: now())
            if toolCallID != nil, inputDigest != nil {
                do { try commit(receipt, at: now()) }
                catch { failure = .receiptFailed; return Self.errorJSON(.receiptFailed) }
            }
            return Self.errorJSON(error)
        } catch {
            let wrapped = LocalProgramError.executionFailed("host operation failed")
            failure = wrapped
            let receipt = self.receipt(receiptID: "tool_receipt_\(UUID().uuidString.lowercased())",
                toolCallID: toolCallID ?? "call_\(executionID)_failed_\(calls + 1)",
                capabilityID: capabilityID, attempt: 1,
                inputSHA256: inputDigest ?? MacLocalProgramDigest.data(Data()),
                status: "failed", summary: "local_capability_did_not_complete",
                resourceID: nil, postStateSHA256: nil,
                approvalID: consumedApprovalID,
                startedAt: startedAt, finishedAt: now())
            if toolCallID != nil, inputDigest != nil {
                do { try commit(receipt, at: now()) }
                catch { failure = .receiptFailed; return Self.errorJSON(.receiptFailed) }
            }
            return Self.errorJSON(wrapped)
        }
    }

    private func commit(_ receipt: MacLocalActionReceipt, at: Date) throws {
        do { try journal.finishTool(executionID: executionID, receipt: receipt, at: at) }
        catch { throw LocalProgramError.receiptFailed }
        receipts.append(receipt)
    }

    private static func validateInput(capabilityID: String,
                                      input: [String: MacCanonicalJSON]) throws {
        let keys = Set(input.keys)
        let allStrings = input.values.allSatisfy { $0.stringValue != nil }
        switch capabilityID {
        case "macos.accessibility.observe", "macos.app.current", "macos.window.current":
            guard keys.isEmpty else { throw LocalProgramError.invalidInput }
        case "macos.accessibility.find":
            guard keys.isSubset(of: ["role", "label"]), allStrings else {
                throw LocalProgramError.invalidInput
            }
        default:
            let required: Set<String> = ["action", "handle", "observation_id"]
            let allowed = capabilityID == "macos.accessibility.set_value" ?
                required.union(["value"]) : required
            guard keys == allowed, allStrings,
                  input["action"]?.stringValue == capabilityID.split(separator: ".").last.map(String.init)
            else { throw LocalProgramError.invalidInput }
        }
    }

    private func receipt(receiptID: String, toolCallID: String, capabilityID: String, attempt: Int,
                         inputSHA256: String, status: String, summary: String,
                         resourceID: String?, postStateSHA256: String?,
                         approvalID: String? = nil,
                         startedAt: Date, finishedAt: Date) -> MacLocalActionReceipt {
        MacLocalActionReceipt.make(receiptID: receiptID, executionID: executionID,
            claimant: claimant, toolCallID: toolCallID, attempt: attempt,
            capabilityID: capabilityID, programSHA256: programSHA256,
            catalogSHA256: catalogSHA256, bindingsSHA256: bindingsSHA256,
            inputSHA256: inputSHA256, preStateSHA256: preStateSHA256,
            approvalID: approvalID,
            startedAt: startedAt, finishedAt: finishedAt, status: status,
            result: .init(summary: summary, resourceID: resourceID),
            postStateSHA256: postStateSHA256,
            previousReceiptSHA256: receipts.last?.receiptSHA256)
    }

    private static func receiptStatus(_ error: LocalProgramError) -> String {
        switch error {
        case .staleObservation, .staleTarget, .unknownHandle: "stale_state"
        case .expired: "timed_out"
        case .stopped: "stopped"
        case .indeterminate: "indeterminate"
        case .receiptFailed: "failed"
        case .capabilityDenied, .approvalRequired, .unsupportedAction, .invalidInput: "rejected"
        default: "failed"
        }
    }

    private static func json<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    private static func errorJSON(_ error: LocalProgramError) -> String {
        let message: String
        switch error {
        case .executionFailed: message = "local operation failed"
        case .receiptFailed: message = "receipt_failed"
        default: message = String(describing: error)
        }
        let data = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": message], options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    private struct CurrentApplication: Encodable {
        let name: String; let bundleID: String; let pid: Int32
        enum CodingKeys: String, CodingKey { case name, pid; case bundleID = "bundle_id" }
    }

    private struct CurrentWindow: Encodable {
        let title: String; let windowID: String; let observationID: String
        enum CodingKeys: String, CodingKey {
            case title; case windowID = "window_id"; case observationID = "observation_id"
        }
    }
}

public final class JavaScriptCoreMacProgramRuntime: @unchecked Sendable {
    private let deviceID: String
    private let authority: any MacAccessibilityProgramAuthority
    private let now: @Sendable () -> Date
    private let localAdvertisement: MacLocalProgramAdvertisement
    private let journal: any MacProgramJournaling
    private let clientInstanceID: String
    private let approvalAuthorizer: (any MacProgramApprovalAuthorizing)?
    private let runnerURL: URL?
    private let runnersLock = NSLock()
    private var runners: [String: MacProgramRunnerHandle] = [:]

    public init(deviceID: String, authority: any MacAccessibilityProgramAuthority,
                clientInstanceID: String, journal: any MacProgramJournaling,
                approvalAuthorizer: (any MacProgramApprovalAuthorizing)? = nil,
                runnerURL: URL? = nil,
                now: @escaping @Sendable () -> Date = Date.init) {
        self.deviceID = deviceID
        self.authority = authority
        self.now = now
        self.clientInstanceID = clientInstanceID
        self.approvalAuthorizer = approvalAuthorizer
        self.journal = journal
        self.runnerURL = runnerURL
        let issuedAt = now()
        self.localAdvertisement = .init(deviceID: deviceID, issuedAt: issuedAt,
            expiresAt: issuedAt.addingTimeInterval(5 * 60))
    }

    public var advertisement: MacLocalProgramAdvertisement { localAdvertisement }

    public func requestStop(executionID: String) throws {
        try journal.requestStop(executionID: executionID, at: now())
        runnersLock.withLock { runners[executionID] }?.stop()
    }
    public func lifecycleEvents(executionID: String) throws -> [MacProgramLifecycleEvent] { try journal.events(executionID: executionID) }
    public func toolReceipts(executionID: String) throws -> [MacLocalActionReceipt] {
        try journal.toolReceipts(executionID: executionID)
    }
    public func terminalReceipt(executionID: String) throws -> MacProgramTerminalReceipt? {
        try journal.terminalReceipt(executionID: executionID)
    }

    public func execute(_ envelope: MacLocalProgramEnvelope,
                        approvedProgramSHA256: String) -> MacLocalProgramResult {
        var bridge: MacProgramBridge?
        var executionStartedAt: Date?
        var accepted = false
        var terminalCommitAttempted = false
        var preacceptCommitAttempted = false
        do {
            let startedAt = now()
            try envelope.validate(advertisement: localAdvertisement, now: startedAt)
            guard approvedProgramSHA256 == envelope.program.sha256,
                  envelope.approvalPolicy.program != "approval_required" else {
                preacceptCommitAttempted = true
                return try journal.reject(envelope, claimantDeviceID: deviceID,
                    clientInstanceID: clientInstanceID, at: startedAt)
            }
            try authority.validate(bindings: envelope.bindings, now: startedAt)
            switch try journal.claim(envelope, claimantDeviceID: deviceID,
                                     clientInstanceID: clientInstanceID, at: startedAt) {
            case .accepted: accepted = true
            case .replay(let terminal):
                if let terminal { return terminal }
                throw LocalProgramError.replayed
            }
            try journal.markStarted(executionID: envelope.executionID, at: startedAt)
            executionStartedAt = startedAt
            let handle = MacProgramRunnerHandle()
            runnersLock.withLock { runners[envelope.executionID] = handle }
            defer { _ = runnersLock.withLock { runners.removeValue(forKey: envelope.executionID) } }
            let createdBridge = MacProgramBridge(authority: authority,
                executionID: envelope.executionID,
                allowed: Set(envelope.catalog.allowedCapabilityIDs),
                maximumCalls: envelope.limits.toolCalls,
                deadline: min(envelope.expiresAt,
                    startedAt.addingTimeInterval(Double(envelope.limits.wallMS) / 1_000)),
                preStateSHA256: envelope.bindings.stateSHA256,
                journal: journal,
                claimant: .init(deviceID: deviceID, clientInstanceID: clientInstanceID),
                programSHA256: envelope.program.sha256,
                catalogSHA256: envelope.catalog.sha256,
                bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings),
                bindings: envelope.bindings,
                alwaysAsk: Set(envelope.approvalPolicy.alwaysAsk),
                approvalAuthorizer: approvalAuthorizer,
                isRevoked: { !handle.isActive },
                now: now)
            bridge = createdBridge
            guard let executableURL = runnerURL ?? Self.defaultRunnerURL() else {
                throw LocalProgramError.executionFailed("program runner unavailable")
            }
            let outcome = try MacProgramProcessRunner.run(executableURL: executableURL,
                source: envelope.program.source, wallMS: envelope.limits.wallMS,
                handle: handle, resultBytes: envelope.limits.resultBytes,
                logBytes: envelope.limits.logBytes, progress: { [journal, now] message, completed, total in
                    do {
                        try journal.recordProgress(executionID: envelope.executionID,
                            message: message, completed: completed, total: total, at: now())
                        return true
                    } catch { return false }
                }, call: createdBridge.call)
            if let failure = createdBridge.failure { throw failure }
            if try journal.isStopRequested(executionID: envelope.executionID) {
                throw LocalProgramError.stopped
            }
            if outcome.timedOut { throw LocalProgramError.expired }
            if let error = outcome.error { throw LocalProgramError.executionFailed(error) }
            let output = outcome.outputJSON ?? "null"
            guard output.utf8.count <= envelope.limits.resultBytes else {
                throw LocalProgramError.outputTooLarge
            }
            let completed = result(envelope, status: "completed", resultJSON: output,
                error: nil, bridge: createdBridge, startedAt: executionStartedAt)
            terminalCommitAttempted = true
            try journal.finish(executionID: envelope.executionID, result: completed, at: now())
            return completed
        } catch {
            let status: String
            switch error as? LocalProgramError {
            case .stopped: status = "stopped"
            case .expired: status = "timed_out"
            case .indeterminate: status = "indeterminate"
            default: status = "failed"
            }
            let failed = result(envelope, status: status, resultJSON: nil,
                error: Self.safeError(error), bridge: bridge, startedAt: executionStartedAt)
            if !accepted {
                guard !preacceptCommitAttempted else {
                    return result(envelope, status: "failed", resultJSON: nil,
                        error: "receipt_failed", bridge: bridge, startedAt: executionStartedAt)
                }
                preacceptCommitAttempted = true
                do {
                    return try journal.reject(envelope, claimantDeviceID: deviceID,
                        clientInstanceID: clientInstanceID, reason: Self.safeError(error), at: now())
                } catch LocalProgramError.replayed {
                    return result(envelope, status: "failed", resultJSON: nil,
                        error: "replayed", bridge: bridge, startedAt: executionStartedAt)
                } catch {
                    return result(envelope, status: "failed", resultJSON: nil,
                        error: "receipt_failed", bridge: bridge, startedAt: executionStartedAt)
                }
            }
            guard !terminalCommitAttempted else {
                return result(envelope, status: "failed", resultJSON: nil,
                    error: "receipt_failed", bridge: bridge, startedAt: executionStartedAt)
            }
            do { try journal.finish(executionID: envelope.executionID, result: failed, at: now()) }
            catch {
                return result(envelope, status: "failed", resultJSON: nil,
                    error: "receipt_failed", bridge: bridge, startedAt: executionStartedAt)
            }
            return failed
        }
    }

    private func result(_ envelope: MacLocalProgramEnvelope, status: String,
                        resultJSON: String?, error: String?, bridge: MacProgramBridge?,
                        startedAt: Date?) -> MacLocalProgramResult {
        MacLocalProgramResult(executionID: envelope.executionID,
            sessionID: envelope.sessionID, turnID: envelope.turnID,
            claimantDeviceID: deviceID, runtimeID: envelope.runtime.runtimeID,
            status: status, resultJSON: resultJSON, error: error,
            toolCalls: bridge?.calls ?? 0, receipts: bridge?.receipts ?? [],
            programSHA256: envelope.program.sha256,
            catalogSHA256: envelope.catalog.sha256,
            bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings),
            startedAt: startedAt, finishedAt: now())
    }

    private static func defaultRunnerURL() -> URL? {
        let executable = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        let workingDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let candidates = [
            executable.deletingLastPathComponent().appendingPathComponent("MoaMacProgramRunner"),
            Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/MoaMacProgramRunner"),
            workingDirectory.appendingPathComponent(".build/debug/MoaMacProgramRunner"),
            workingDirectory.appendingPathComponent(".build/arm64-apple-macosx/debug/MoaMacProgramRunner"),
        ]
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) })
    }

    private static func safeError(_ error: Error) -> String {
        switch error {
        case LocalProgramError.executionFailed: return "local program failed"
        case LocalProgramError.receiptFailed: return "receipt_failed"
        case let local as LocalProgramError: return String(describing: local)
        default: return "local program failed"
        }
    }
}
#endif
