import CryptoKit
import Foundation

public enum CurrentAppAskError: Error, Equatable, Sendable {
    case unavailable
    case invalidEvidence
    case expired
    case staleEvidence
    case destinationChanged
    case approvalMismatch
    case scopeChanged
    case cancelled
    case journalFailure
    case terminalJournalFailure
}

public struct GatewayScreenAwareChatRequest: Sendable {
    public static let maximumSemanticSummaryBytes = 6_000
    public static let maximumBodyBytes = 1_572_864

    public let endpoint: URL
    public let body: Data
    public let bodySHA256: String
    public let semanticSummary: String
    public let screenshotBytes: Int
    public let screenshotSHA256: String?

    public init(
        origin: URL,
        sessionID: String,
        prompt: String,
        process: ProcessIdentity,
        observation: Observation,
        includeScreenshot: Bool
    ) throws {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw GatewayChatError.emptyPrompt }
        guard trimmed.utf8.count <= GatewayChatRequest.maximumPromptBytes else {
            throw GatewayChatError.promptTooLarge
        }
        guard observation.app.bundleID == process.bundleID else {
            throw CurrentAppAskError.invalidEvidence
        }

        endpoint = try GatewayOrigin.endpoint(origin: origin, path: ["v1", "chat"])
        semanticSummary = try Self.semanticSummary(for: observation)
        let screenshot = try Self.screenEvidence(observation.screenshot, enabled: includeScreenshot)
        screenshotBytes = screenshot?.bytes ?? 0
        screenshotSHA256 = screenshot?.sha256

        let evidence = ScreenEvidence(
            surface: "macos",
            capturedAt: Self.timestamp(observation.capturedAt),
            binding: .init(
                kind: "macos_process",
                id: process.bundleID,
                generation: Self.processGeneration(process)
            ),
            semanticSummary: semanticSummary,
            screenshot: screenshot
        )
        let value = Body(
            sessionID: sessionID,
            conversationID: sessionID,
            source: "moa-macos",
            deliveryIntent: "assistant_response",
            messages: [.init(role: "user", content: trimmed)],
            screenEvidence: evidence
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        body = try encoder.encode(value)
        guard body.count <= Self.maximumBodyBytes else { throw GatewayChatError.promptTooLarge }
        bodySHA256 = Self.digest(body)
    }

    public func validateApproval(_ digest: String) throws {
        guard digest == bodySHA256 else { throw CurrentAppAskError.approvalMismatch }
    }

    private struct Body: Encodable {
        struct Message: Encodable { let role: String; let content: String }
        let sessionID: String
        let conversationID: String
        let source: String
        let deliveryIntent: String
        let messages: [Message]
        let screenEvidence: ScreenEvidence

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case conversationID = "conversation_id"
            case deliveryIntent = "delivery_intent"
            case screenEvidence = "screen_evidence"
            case source, messages
        }
    }

    private struct ScreenEvidence: Encodable {
        struct Binding: Encodable { let kind: String; let id: String; let generation: String }
        let surface: String
        let capturedAt: String
        let binding: Binding
        let semanticSummary: String
        let screenshot: Screenshot?

        enum CodingKeys: String, CodingKey {
            case surface, binding, screenshot
            case capturedAt = "captured_at"
            case semanticSummary = "semantic_summary"
        }
    }

    private struct Screenshot: Encodable {
        let mimeType: String
        let dataBase64: String
        let bytes: Int
        let width: Int
        let height: Int
        let sha256: String

        enum CodingKeys: String, CodingKey {
            case bytes, width, height, sha256
            case mimeType = "mime_type"
            case dataBase64 = "data_base64"
        }
    }

    private struct Semantic: Encodable {
        struct App: Encodable { let bundleID: String; let name: String }
        struct Window: Encodable { let title: String }
        let app: App
        let window: Window
        let nodes: [AXNode]
        let truncated: Bool
        let dropped: Int

        enum CodingKeys: String, CodingKey {
            case app, window, nodes, truncated, dropped
        }
    }

    private static func semanticSummary(for observation: Observation) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var nodes = observation.ax.nodes
        var removed = 0
        while true {
            let value = Semantic(
                app: .init(bundleID: observation.app.bundleID, name: observation.app.name),
                window: .init(title: observation.window.title),
                nodes: nodes,
                truncated: observation.ax.truncated || removed > 0,
                dropped: observation.ax.dropped + removed
            )
            let data = try encoder.encode(value)
            if data.count <= maximumSemanticSummaryBytes, let text = String(data: data, encoding: .utf8) {
                return text
            }
            guard !nodes.isEmpty else { throw CurrentAppAskError.invalidEvidence }
            nodes.removeLast()
            removed += 1
        }
    }

    private static func screenEvidence(_ value: ScreenshotEvidence?, enabled: Bool) throws -> Screenshot? {
        guard enabled else {
            guard value == nil else { throw CurrentAppAskError.invalidEvidence }
            return nil
        }
        guard let value else { return nil }
        guard value.mimeType == "image/jpeg", value.width > 0, value.height > 0,
              let data = Data(base64Encoded: value.dataBase64),
              !data.isEmpty, data.count <= ObservationBounds.maxScreenshotBytes,
              data.base64EncodedString() == value.dataBase64,
              digest(data) == value.sha256.lowercased() else {
            throw CurrentAppAskError.invalidEvidence
        }
        return Screenshot(
            mimeType: value.mimeType,
            dataBase64: value.dataBase64,
            bytes: data.count,
            width: value.width,
            height: value.height,
            sha256: value.sha256.lowercased()
        )
    }

    private static func processGeneration(_ process: ProcessIdentity) -> String {
        digest(Data("\(process.pid)\u{1f}\(timestamp(process.processStart))\u{1f}\(process.signingIdentity)".utf8))
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

public struct CurrentAppAskPreview: Sendable {
    public let destination: URL
    public let body: Data
    public let bodySHA256: String
    public let semanticSummary: String
    public let screenshotBytes: Int
    public let screenshotSHA256: String?
    public let applicationBundleID: String
    public let windowTitle: String
    public let expiresAt: Date
}

public protocol CurrentAppAskApproving: Sendable {
    func approve(_ preview: CurrentAppAskPreview) async throws -> String
}

public protocol CurrentAppAskScopeValidating: Sendable {
    func validate(process: ProcessIdentity, focusedWindowID: UInt32?) async -> Bool
}

public protocol ScreenAwareChatSending: Sendable {
    func send(_ request: GatewayScreenAwareChatRequest, bearerToken: String) async throws -> GatewayChatReply
}

public actor CurrentAppAskCoordinator {
    private struct Entry: Sendable {
        let id: UUID
        let grant: ObservationGrant
        let observation: Observation
        let focusedWindowID: UInt32?
    }

    private struct ReceiptContext: Sendable {
        let attemptID: UUID
        let grantID: UUID
        let requestDigest: String
        let semanticDigest: String
        let screenshotDigest: String?
        let destinationDigest: String
        let scopeDigest: String
    }

    private var entry: Entry?
    private var generation: UInt64 = 0
    private let journal: any CurrentAppAskReceiptJournaling
    private var activeReceipt: ReceiptContext?
    private var activeSend: Task<GatewayChatReply, Error>?

    public init(journal: any CurrentAppAskReceiptJournaling = InMemoryCurrentAppAskReceiptJournal()) {
        self.journal = journal
    }

    public func publishVerified(
        grant: ObservationGrant,
        observation: Observation,
        focusedWindowID: UInt32?
    ) throws {
        guard grant.mode != .localOnly, grant.destinationOrigin != nil,
              observation.app.bundleID == grant.process.bundleID,
              observation.capturedAt >= grant.issuedAt,
              observation.capturedAt < grant.expiresAt,
              grant.includeScreenshot || observation.screenshot == nil else {
            throw CurrentAppAskError.invalidEvidence
        }
        generation &+= 1
        entry = Entry(id: UUID(), grant: grant, observation: observation, focusedWindowID: focusedWindowID)
    }

    public func revoke(at date: Date = Date()) throws {
        generation &+= 1
        entry = nil
        activeSend?.cancel()
        activeSend = nil
        guard let context = activeReceipt else { return }
        activeReceipt = nil
        do {
            _ = try journal.append(draft(context, stage: .terminal, outcome: .canceled, at: date, error: "revoked"))
        } catch {
            throw CurrentAppAskError.terminalJournalFailure
        }
    }

    public func hasEvidence(now: Date) -> Bool {
        guard let entry, now < entry.grant.expiresAt,
              now.timeIntervalSince(entry.observation.capturedAt) <= 60 else { return false }
        return true
    }

    public func ask(
        origin: URL,
        sessionID: String,
        prompt: String,
        bearerToken: String,
        now: @Sendable () -> Date,
        approver: any CurrentAppAskApproving,
        scope: any CurrentAppAskScopeValidating,
        sender: any ScreenAwareChatSending
    ) async throws -> GatewayChatReply {
        let started = generation
        guard let selected = entry else { throw CurrentAppAskError.unavailable }
        defer {
            if entry?.id == selected.id {
                generation &+= 1
                entry = nil
            }
        }
        try validate(selected, origin: origin, at: now())
        let request = try GatewayScreenAwareChatRequest(
            origin: origin,
            sessionID: sessionID,
            prompt: prompt,
            process: selected.grant.process,
            observation: selected.observation,
            includeScreenshot: selected.grant.includeScreenshot
        )
        let preview = CurrentAppAskPreview(
            destination: request.endpoint,
            body: request.body,
            bodySHA256: request.bodySHA256,
            semanticSummary: request.semanticSummary,
            screenshotBytes: request.screenshotBytes,
            screenshotSHA256: request.screenshotSHA256,
            applicationBundleID: selected.grant.process.bundleID,
            windowTitle: selected.observation.window.title,
            expiresAt: selected.grant.expiresAt
        )
        let context = ReceiptContext(
            attemptID: UUID(),
            grantID: selected.grant.id,
            requestDigest: request.bodySHA256,
            semanticDigest: TranscriptDigest.sha256(request.semanticSummary),
            screenshotDigest: request.screenshotSHA256,
            destinationDigest: TranscriptDigest.sha256(request.endpoint.absoluteString),
            scopeDigest: Self.scopeDigest(selected)
        )
        do {
            _ = try journal.append(draft(context, stage: .pending, outcome: .pending, at: now()))
        } catch {
            throw CurrentAppAskError.journalFailure
        }
        activeReceipt = context

        do {
            let approval = try await approver.approve(preview)
            try current(selected, started: started, origin: origin, at: now())
            try request.validateApproval(approval)
            try append(context, stage: .approved, outcome: .approved, at: now())
            guard await scope.validate(process: selected.grant.process, focusedWindowID: selected.focusedWindowID) else {
                throw CurrentAppAskError.scopeChanged
            }
            try current(selected, started: started, origin: origin, at: now())
            try append(context, stage: .released, outcome: .released, at: now())
            let send = Task { try await sender.send(request, bearerToken: bearerToken) }
            activeSend = send
            let reply = try await send.value
            activeSend = nil
            try current(selected, started: started, origin: origin, at: now())
            guard await scope.validate(process: selected.grant.process, focusedWindowID: selected.focusedWindowID) else {
                throw CurrentAppAskError.scopeChanged
            }
            try current(selected, started: started, origin: origin, at: now())
            try terminate(context, outcome: .completed, at: now())
            return reply
        } catch {
            activeSend?.cancel()
            activeSend = nil
            if activeReceipt?.attemptID == context.attemptID {
                do {
                    try terminate(context, outcome: terminalOutcome(error), at: now(), error: errorCode(error))
                } catch {
                    throw CurrentAppAskError.terminalJournalFailure
                }
            }
            throw error
        }
    }

    private func current(_ selected: Entry, started: UInt64, origin: URL, at date: Date) throws {
        guard generation == started, entry?.id == selected.id else { throw CurrentAppAskError.cancelled }
        try validate(selected, origin: origin, at: date)
    }

    private func validate(_ selected: Entry, origin: URL, at date: Date) throws {
        guard date < selected.grant.expiresAt else { throw CurrentAppAskError.expired }
        guard date >= selected.observation.capturedAt,
              date.timeIntervalSince(selected.observation.capturedAt) <= 60 else {
            throw CurrentAppAskError.staleEvidence
        }
        guard selected.grant.destinationOrigin == origin else { throw CurrentAppAskError.destinationChanged }
    }

    private func append(
        _ context: ReceiptContext,
        stage: CurrentAppAskReceiptStage,
        outcome: CurrentAppAskReceiptOutcome,
        at date: Date
    ) throws {
        do { _ = try journal.append(draft(context, stage: stage, outcome: outcome, at: date)) }
        catch { throw CurrentAppAskError.journalFailure }
    }

    private func terminate(
        _ context: ReceiptContext,
        outcome: CurrentAppAskReceiptOutcome,
        at date: Date,
        error: String? = nil
    ) throws {
        activeReceipt = nil
        do { _ = try journal.append(draft(context, stage: .terminal, outcome: outcome, at: date, error: error)) }
        catch { throw CurrentAppAskError.terminalJournalFailure }
    }

    private func draft(
        _ context: ReceiptContext,
        stage: CurrentAppAskReceiptStage,
        outcome: CurrentAppAskReceiptOutcome,
        at date: Date,
        error: String? = nil
    ) -> CurrentAppAskReceiptDraft {
        .init(
            attemptID: context.attemptID,
            grantID: context.grantID,
            stage: stage,
            outcome: outcome,
            requestDigest: context.requestDigest,
            semanticDigest: context.semanticDigest,
            screenshotDigest: context.screenshotDigest,
            destinationDigest: context.destinationDigest,
            scopeDigest: context.scopeDigest,
            recordedAt: date,
            errorCode: error
        )
    }

    private func terminalOutcome(_ error: Error) -> CurrentAppAskReceiptOutcome {
        switch error as? CurrentAppAskError {
        case .cancelled: return .canceled
        case .expired: return .expired
        case .staleEvidence, .destinationChanged, .approvalMismatch, .scopeChanged: return .stale
        default: return .failed
        }
    }

    private func errorCode(_ error: Error) -> String {
        if let value = error as? CurrentAppAskError { return String(describing: value) }
        if error is CancellationError { return "cancelled" }
        return "send_failed"
    }

    private static func scopeDigest(_ entry: Entry) -> String {
        let process = entry.grant.process
        return TranscriptDigest.sha256([
            process.bundleID,
            String(process.pid),
            String(process.processStart.timeIntervalSince1970),
            process.signingIdentity,
            entry.focusedWindowID.map(String.init) ?? "missing",
        ].joined(separator: "\u{1f}"))
    }
}
