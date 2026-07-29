#if os(macOS)
import Foundation
import MoaMacCore
import SwiftUI

public protocol GatewayConnectionStore: Sendable {
    func loadOrigin() -> String
    func loadToken() -> String
    func loadSessionID() -> String
    func save(origin: String, token: String) throws
}

public struct SystemGatewayConnectionStore: GatewayConnectionStore {
    public init() {}
    public func loadOrigin() -> String { UserDefaults.standard.string(forKey: "moa.gateway.origin") ?? "" }
    public func loadToken() -> String { KeychainToken.load() ?? "" }
    public func loadSessionID() -> String {
        if let value = UserDefaults.standard.string(forKey: "moa.gateway.session"), !value.isEmpty { return value }
        let value = "mac-\(UUID().uuidString.lowercased())"
        UserDefaults.standard.set(value, forKey: "moa.gateway.session")
        return value
    }
    public func save(origin: String, token: String) throws {
        guard let url = URL(string: origin) else { throw MoaMacError.invalidDestination }
        _ = try GatewayOrigin.endpoint(origin: url, path: ["v1", "chat"])
        guard !token.isEmpty else { throw MoaMacError.missingToken }
        try KeychainToken.save(token)
        UserDefaults.standard.set(origin, forKey: "moa.gateway.origin")
    }
}

public enum GatewayChatTransportError: Error, Equatable, Sendable {
    case unauthorized
    case server(Int)
    case invalidHTTPResponse
}

public protocol GatewayChatSending: Sendable {
    func send(_ request: GatewayChatRequest, bearerToken: String) async throws -> GatewayChatReply
}

public struct URLSessionGatewayChatSender: GatewayChatSending, ScreenAwareChatSending {
    public init() {}
    public func send(_ chat: GatewayChatRequest, bearerToken: String) async throws -> GatewayChatReply {
        try await send(endpoint: chat.endpoint, body: chat.body, bearerToken: bearerToken)
    }

    public func send(_ chat: GatewayScreenAwareChatRequest, bearerToken: String) async throws -> GatewayChatReply {
        try await send(endpoint: chat.endpoint, body: chat.body, bearerToken: bearerToken)
    }

    private func send(endpoint: URL, body: Data, bearerToken: String) async throws -> GatewayChatReply {
        guard !bearerToken.isEmpty else { throw MoaMacError.missingToken }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw GatewayChatTransportError.invalidHTTPResponse }
        if http.statusCode == 401 { throw GatewayChatTransportError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw GatewayChatTransportError.server(http.statusCode) }
        var buffer = BoundedResponseBuffer()
        for try await byte in bytes { try buffer.append(byte) }
        return try GatewayChatReplyDecoder.decode(buffer.value)
    }
}

@MainActor public final class CommandModel: ObservableObject {
    @Published public var origin: String
    @Published public var token: String
    @Published public var prompt = ""
    @Published public private(set) var reply = ""
    @Published public private(set) var replyIsDerivedCandidate = false
    @Published public private(set) var status = "Ready"
    @Published public private(set) var isSending = false
    @Published public private(set) var voiceState = VoiceTranscriptState()
    @Published public private(set) var hasInsertionTarget = false

    private let store: any GatewayConnectionStore
    private let sender: any GatewayChatSending
    private let voiceController: any VoiceCaptureControlling
    private let insertionCoordinator: TranscriptInsertionCoordinator
    private let insertionApprover: any TranscriptInsertionApproving
    private let currentAppAsk: CurrentAppAskCoordinator
    private let currentAppAskApprover: any CurrentAppAskApproving
    private let currentAppAskScope: any CurrentAppAskScopeValidating
    private let screenAwareSender: any ScreenAwareChatSending
    private let sessionID: String
    private var voiceGeneration: UInt64 = 0
    private var voiceReleaseRequested = false

    public convenience init() {
        self.init(
            store: SystemGatewayConnectionStore(),
            sender: URLSessionGatewayChatSender(),
            voiceController: VoiceCaptureController(),
            insertionCoordinator: TranscriptInsertionCoordinator(
                adapter: SystemTranscriptInsertionAXAdapter(),
                journal: SystemTranscriptReceiptJournal.make()
            ),
            insertionApprover: SystemTranscriptInsertionApprover(),
            currentAppAsk: SystemCurrentAppAskContext.shared,
            currentAppAskApprover: SystemCurrentAppAskApprover(),
            currentAppAskScope: CurrentAppAskWorkspaceScope()
        )
    }

    public init(
        store: any GatewayConnectionStore,
        sender: any GatewayChatSending,
        voiceController: (any VoiceCaptureControlling)? = nil,
        insertionCoordinator: TranscriptInsertionCoordinator? = nil,
        insertionApprover: (any TranscriptInsertionApproving)? = nil,
        currentAppAsk: CurrentAppAskCoordinator = CurrentAppAskCoordinator(),
        currentAppAskApprover: (any CurrentAppAskApproving)? = nil,
        currentAppAskScope: (any CurrentAppAskScopeValidating)? = nil,
        screenAwareSender: (any ScreenAwareChatSending)? = nil
    ) {
        self.store = store
        self.sender = sender
        self.voiceController = voiceController ?? VoiceCaptureController()
        self.insertionCoordinator = insertionCoordinator ?? TranscriptInsertionCoordinator(
            adapter: SystemTranscriptInsertionAXAdapter(),
            journal: InMemoryTranscriptReceiptJournal()
        )
        self.insertionApprover = insertionApprover ?? SystemTranscriptInsertionApprover()
        self.currentAppAsk = currentAppAsk
        self.currentAppAskApprover = currentAppAskApprover ?? SystemCurrentAppAskApprover()
        self.currentAppAskScope = currentAppAskScope ?? CurrentAppAskWorkspaceScope()
        if let screenAwareSender {
            self.screenAwareSender = screenAwareSender
        } else if let compatibleSender = sender as? any ScreenAwareChatSending {
            self.screenAwareSender = compatibleSender
        } else {
            self.screenAwareSender = URLSessionGatewayChatSender()
        }
        origin = store.loadOrigin()
        token = store.loadToken()
        sessionID = store.loadSessionID()
    }

    public var isConfigured: Bool { !origin.isEmpty && !token.isEmpty }

    /// Called by the panel controller before NSApp activation. The binding is
    /// memory-only and is never inferred after Moa owns focus.
    public func captureInsertionTargetBeforeFocus() {
        hasInsertionTarget = insertionCoordinator.captureBeforeMoaTakesFocus()
    }

    public func insertTranscriptAtPriorCursor() async {
        await insertCandidate(voiceState.final, success: "Transcript inserted — no click or submit performed")
    }

    public func insertDerivedCandidateAtPriorCursor() async {
        await insertCandidate(reply, success: "Candidate inserted — no click or submit performed")
    }

    private func insertCandidate(_ candidate: String, success: String) async {
        do {
            _ = try await insertionCoordinator.insertLiteralTranscript(candidate, approver: insertionApprover)
            hasInsertionTarget = false
            status = success
        } catch TranscriptInsertionError.denied {
            status = "Insertion canceled — no text changed"
        } catch TranscriptInsertionError.secureTarget {
            hasInsertionTarget = false
            status = "Secure fields cannot receive transcripts"
        } catch TranscriptInsertionError.wrongApplication {
            hasInsertionTarget = false
            status = "Target app changed — no text inserted"
        } catch TranscriptInsertionError.nonSettable {
            hasInsertionTarget = false
            status = "Target is no longer editable — no text inserted"
        } catch TranscriptInsertionError.focusChanged {
            hasInsertionTarget = false
            status = "Focused field changed — no text inserted"
        } catch TranscriptInsertionError.staleState {
            hasInsertionTarget = false
            status = "Target text changed — no text inserted"
        } catch TranscriptInsertionError.journalFailure {
            status = "Could not save the pending receipt — no text inserted"
        } catch TranscriptInsertionError.terminalJournalFailure {
            hasInsertionTarget = false
            status = "Transcript inserted; pending receipt will recover on next launch"
        } catch {
            hasInsertionTarget = false
            status = "Transcript was not inserted"
        }
    }

    @discardableResult public func saveConnection() -> Bool {
        do {
            try store.save(origin: origin, token: token)
            status = "Connected to your gateway"
            return true
        } catch {
            status = "Enter a canonical HTTPS gateway origin and bearer token"
            return false
        }
    }

    public func submit() async {
        guard !isSending else { return }
        isSending = true
        status = "Thinking…"
        defer { isSending = false }
        do {
            guard let url = URL(string: origin) else { throw MoaMacError.invalidDestination }
            let request = try GatewayChatRequest(origin: url, sessionID: sessionID, prompt: prompt)
            let result = try await sender.send(request, bearerToken: token)
            reply = result.text
            replyIsDerivedCandidate = false
            prompt = ""
            status = "Reply received"
        } catch GatewayChatTransportError.unauthorized {
            status = "Gateway rejected the token"
        } catch GatewayChatError.emptyPrompt {
            status = "Type something first"
        } catch GatewayChatError.promptTooLarge {
            status = "That message is too large"
        } catch MoaMacError.missingToken {
            status = "Add your gateway token"
        } catch MoaMacError.invalidDestination {
            status = "Use a canonical HTTPS gateway origin"
        } catch {
            status = "Could not reach the gateway"
        }
    }

    public func askWithCurrentApp() async {
        guard !isSending else { return }
        isSending = true
        status = "Preparing current-app scope…"
        defer { isSending = false }
        do {
            guard let url = URL(string: origin) else { throw MoaMacError.invalidDestination }
            let result = try await currentAppAsk.ask(
                origin: url,
                sessionID: sessionID,
                prompt: prompt,
                bearerToken: token,
                now: Date.init,
                approver: currentAppAskApprover,
                scope: currentAppAskScope,
                sender: screenAwareSender
            )
            reply = result.text
            replyIsDerivedCandidate = true
            prompt = ""
            status = "Screen-aware candidate ready — inert until you choose insertion"
        } catch CurrentAppAskError.unavailable {
            status = "Start a network-enabled one-app Screen Context grant first"
        } catch CurrentAppAskError.staleEvidence {
            status = "Current-app evidence expired — no request sent"
        } catch CurrentAppAskError.expired {
            status = "Current-app grant expired — no request sent"
        } catch CurrentAppAskError.destinationChanged {
            status = "Gateway destination changed — no request sent"
        } catch CurrentAppAskError.scopeChanged {
            status = "App or focused window changed — candidate discarded"
        } catch CurrentAppAskError.cancelled, MoaMacError.cancelled {
            status = "Screen-aware Ask canceled — evidence stripped"
        } catch CurrentAppAskError.approvalMismatch {
            status = "Approval no longer matches the exact request"
        } catch CurrentAppAskError.journalFailure {
            status = "Could not save the Ask receipt — no evidence released"
        } catch CurrentAppAskError.terminalJournalFailure {
            status = "Ask stopped, but its terminal receipt could not be saved"
        } catch GatewayChatTransportError.unauthorized {
            status = "Gateway rejected the token"
        } catch GatewayChatError.emptyPrompt {
            status = "Type what you want Aggie to do with the current app"
        } catch GatewayChatError.promptTooLarge {
            status = "That message or evidence is too large"
        } catch {
            status = "Screen-aware Ask failed — evidence stripped"
        }
    }

    public func resetPresentation() {
        prompt = ""
        reply = ""
        replyIsDerivedCandidate = false
        status = "Ready"
        voiceState.apply(.reset)
        insertionCoordinator.clear()
        hasInsertionTarget = false
    }

    public func startVoice() async {
        guard !voiceState.isActive else { return }
        voiceGeneration &+= 1
        let generation = voiceGeneration
        voiceReleaseRequested = false
        voiceState.apply(.begin)
        do {
            guard isConfigured else { throw MoaMacError.missingToken }
            guard let url = URL(string: origin) else { throw MoaMacError.invalidDestination }
            let turnID = "turn-\(UUID().uuidString.lowercased())"
            try await voiceController.start(
                origin: url,
                bearerToken: token,
                sessionID: sessionID,
                turnID: turnID
            ) { [weak self] event in
                guard let self, self.voiceGeneration == generation else { return }
                self.voiceState.apply(.server(event))
            }
            guard voiceGeneration == generation else {
                await voiceController.cancel()
                return
            }
            voiceState.apply(.captureStarted)
            if voiceReleaseRequested {
                try await voiceController.stopAndCommit()
            }
        } catch VoiceCaptureError.microphoneDenied {
            voiceState.apply(.permissionDenied)
        } catch MoaMacError.missingToken {
            voiceState.apply(.failed("Add your gateway origin and token first"))
        } catch MoaMacError.invalidDestination {
            voiceState.apply(.failed("Use a canonical HTTPS gateway origin"))
        } catch {
            voiceState.apply(.failed("Could not start microphone transcription"))
            await voiceController.cancel()
        }
    }

    public func finishVoice() async {
        guard voiceState.isActive else { return }
        voiceReleaseRequested = true
        let wasStarting = voiceState.phase == .requestingPermission || voiceState.phase == .connecting
        voiceState.apply(.release)
        guard !wasStarting else { return }
        do {
            try await voiceController.stopAndCommit()
        } catch {
            voiceState.apply(.interrupted("Microphone capture was interrupted"))
            await voiceController.cancel()
        }
    }

    public func cancelVoice() async {
        voiceGeneration &+= 1
        voiceReleaseRequested = false
        await voiceController.cancel()
        if voiceState.isActive {
            voiceState.apply(.interrupted("Transcription canceled"))
        }
    }
}
#endif
