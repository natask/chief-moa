#if os(macOS)
import Foundation
import AppKit
import MoaMacCore
import SwiftUI

public protocol GatewayConnectionStore: Sendable {
    func loadOrigin() -> String
    func loadSessionID() -> String
    func saveOrigin(_ origin: String) throws
}

public struct SystemGatewayConnectionStore: GatewayConnectionStore {
    public init() {}
    public func loadOrigin() -> String { UserDefaults.standard.string(forKey: "moa.gateway.origin") ?? "" }
    public func loadSessionID() -> String {
        if let value = UserDefaults.standard.string(forKey: "moa.gateway.session"), !value.isEmpty { return value }
        let value = "mac-\(UUID().uuidString.lowercased())"
        UserDefaults.standard.set(value, forKey: "moa.gateway.session")
        return value
    }
    public func saveOrigin(_ origin: String) throws {
        guard let url = URL(string: origin) else { throw MoaMacError.invalidDestination }
        _ = try GatewayOrigin.endpoint(origin: url, path: ["v1", "chat"])
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

public protocol BrowserDelegationSending: Sendable {
    func onlineBrowsers(origin: URL, bearerToken: String) async throws -> [BrowserDevice]
    func open(_ request: BrowserOpenRequest, bearerToken: String) async throws -> BrowserOpenQueueResult
    func waitForTerminal(origin: URL, queued: BrowserOpenQueueResult, sourceDeviceID: String, bearerToken: String,
                         progress: @escaping @MainActor @Sendable (BrowserHandoffPhase) -> Void) async throws -> BrowserOpenTerminalResult
}

public struct URLSessionBrowserDelegationSender: BrowserDelegationSending {
    public init() {}

    public func onlineBrowsers(origin: URL, bearerToken: String) async throws -> [BrowserDevice] {
        let endpoint = try GatewayOrigin.endpoint(origin: origin, path: ["v1", "device-clients"])
        let data = try await send(endpoint: endpoint, method: "GET", body: nil, bearerToken: bearerToken)
        guard let list = try? JSONDecoder().decode(BrowserDeviceList.self, from: data) else {
            throw BrowserDelegationError.invalidResponse
        }
        return list.devices.filter(\.canOpenTab)
    }

    public func open(_ request: BrowserOpenRequest, bearerToken: String) async throws -> BrowserOpenQueueResult {
        let data = try await send(endpoint: request.endpoint, method: "POST", body: request.body, bearerToken: bearerToken)
        return try BrowserOpenResponseDecoder.decode(data)
    }

    public func waitForTerminal(origin: URL, queued: BrowserOpenQueueResult, sourceDeviceID: String, bearerToken: String,
                                progress: @escaping @MainActor @Sendable (BrowserHandoffPhase) -> Void) async throws -> BrowserOpenTerminalResult {
        let endpoint = try statusEndpoint(origin: origin, sourceDeviceID: sourceDeviceID)
        for attempt in 0..<20 {
            let data = try await send(endpoint: endpoint, method: "GET", body: nil, bearerToken: bearerToken)
            if let result = try BrowserOpenStatusDecoder.decode(data, requestID: queued.requestID, targetDeviceID: queued.targetDeviceID) {
                if result.phase == .running {
                    await progress(.running)
                } else {
                    return result
                }
            }
            if attempt < 19 { try await Task.sleep(for: .milliseconds(500)) }
        }
        throw BrowserDelegationError.timedOut
    }

    private func statusEndpoint(origin: URL, sourceDeviceID: String) throws -> URL {
        let base = try GatewayOrigin.endpoint(origin: origin, path: ["v1", "tool", "requests"])
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw BrowserDelegationError.invalidResponse
        }
        components.queryItems = [
            URLQueryItem(name: "source_device_id", value: sourceDeviceID),
            URLQueryItem(name: "limit", value: "25"),
        ]
        guard let endpoint = components.url else { throw BrowserDelegationError.invalidResponse }
        return endpoint
    }

    private func send(endpoint: URL, method: String, body: Data?, bearerToken: String) async throws -> Data {
        guard !bearerToken.isEmpty else { throw MoaMacError.missingToken }
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 30
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
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
        return buffer.value
    }
}

public struct URLSessionGatewayChatSender: GatewayChatSending {
    public init() {}
    public func send(_ chat: GatewayChatRequest, bearerToken: String) async throws -> GatewayChatReply {
        guard !bearerToken.isEmpty else { throw MoaMacError.missingToken }
        var request = URLRequest(url: chat.endpoint)
        request.httpMethod = "POST"
        request.httpBody = chat.body
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
    public enum ConnectionState: Equatable, Sendable {
        case disconnected
        case openingBrowser
        case waitingForApproval(code: String)
        case connected
        case failed(String)
    }

    public enum VoiceActivity: Equatable, Sendable {
        case assistant
        case dictation
    }

    @Published public var origin: String
    @Published public var token: String
    @Published public var prompt = ""
    @Published public private(set) var lastSubmittedPrompt = ""
    @Published public private(set) var reply = ""
    @Published public private(set) var status = "Ready"
    @Published public private(set) var isSending = false
    @Published public private(set) var voiceState = VoiceTranscriptState()
    @Published public private(set) var voiceActivity: VoiceActivity = .assistant
    @Published public private(set) var voiceLevels = Array(repeating: 0.08, count: 18)
    @Published public private(set) var historyEntries: [GatewayHistoryEntry] = []
    @Published public private(set) var isShowingHistory = false
    @Published public private(set) var historyStatus = ""
    @Published public var browserURL = ""
    @Published public var selectedBrowserID = ""
    @Published public private(set) var browserDevices: [BrowserDevice] = []
    @Published public private(set) var isDelegatingBrowser = false
    @Published public private(set) var browserHandoffPhase: BrowserHandoffPhase = .idle
    @Published public private(set) var interactionPulse: UInt64 = 0
    @Published public private(set) var connectionState: ConnectionState = .disconnected
    @Published public private(set) var microphonePermission = SystemMicrophonePermission.currentState

    private let store: any GatewayConnectionStore
    private let sender: any GatewayChatSending
    private let voiceController: any VoiceCaptureControlling
    private let historyLoader: any GatewayHistoryLoading
    private let browserSender: any BrowserDelegationSending
    private let deviceAuthorizer: any DeviceAuthorizing
    private let deviceSessionStore: any DeviceSessionStoring
    private let deviceVerificationOpener: any DeviceVerificationOpening
    private let sessionID: String
    private var voiceGeneration: UInt64 = 0
    private var voiceReleaseRequested = false

    public convenience init() {
        self.init(
            store: SystemGatewayConnectionStore(),
            sender: URLSessionGatewayChatSender(),
            voiceController: VoiceCaptureController(),
            historyLoader: URLSessionGatewayHistoryLoader(),
            browserSender: URLSessionBrowserDelegationSender()
            , deviceAuthorizer: URLSessionDeviceAuthorizer(), deviceSessionStore: FileDeviceSessionStore(),
            deviceVerificationOpener: SystemDeviceVerificationOpener()
        )
    }

    public init(
        store: any GatewayConnectionStore,
        sender: any GatewayChatSending,
        voiceController: (any VoiceCaptureControlling)? = nil,
        historyLoader: (any GatewayHistoryLoading)? = nil,
        browserSender: (any BrowserDelegationSending)? = nil,
        deviceAuthorizer: (any DeviceAuthorizing)? = nil,
        deviceSessionStore: (any DeviceSessionStoring)? = nil,
        deviceVerificationOpener: (any DeviceVerificationOpening)? = nil
    ) {
        self.store = store
        self.sender = sender
        self.voiceController = voiceController ?? VoiceCaptureController()
        self.historyLoader = historyLoader ?? URLSessionGatewayHistoryLoader()
        self.browserSender = browserSender ?? URLSessionBrowserDelegationSender()
        self.deviceAuthorizer = deviceAuthorizer ?? URLSessionDeviceAuthorizer()
        self.deviceSessionStore = deviceSessionStore ?? FileDeviceSessionStore()
        self.deviceVerificationOpener = deviceVerificationOpener ?? SystemDeviceVerificationOpener()
        let savedOrigin = store.loadOrigin()
        origin = savedOrigin.isEmpty ? "https://api.agee.app" : savedOrigin
        let savedToken = self.deviceSessionStore.load()
        token = savedToken
        sessionID = store.loadSessionID()
        connectionState = savedToken.isEmpty ? .disconnected : .connected
    }

    public var isConfigured: Bool { !origin.isEmpty && !token.isEmpty }
    public var isSigningIn: Bool {
        if case .openingBrowser = connectionState { return true }
        if case .waitingForApproval = connectionState { return true }
        return false
    }

    public func signIn() async {
        guard !isSigningIn else { return }
        do {
            guard let url = URL(string: origin) else { throw MoaMacError.invalidDestination }
            try store.saveOrigin(origin)
            connectionState = .openingBrowser
            status = "Opening Ag sign in…"
            let authorization = try await deviceAuthorizer.begin(origin: url)
            connectionState = .waitingForApproval(code: authorization.userCode)
            guard deviceVerificationOpener.open(authorization.verificationURL) else {
                throw DeviceAuthorizationError.invalidResponse
            }
            status = "Waiting for browser approval — code \(authorization.userCode)"
            let deviceToken = try await deviceAuthorizer.poll(origin: url, authorization: authorization)
            try deviceSessionStore.save(deviceToken)
            token = deviceToken
            connectionState = .connected
            status = "Connected to Ag"
        } catch DeviceAuthorizationError.denied {
            connectionState = .failed("The browser denied this connection.")
            status = "Connection denied"
        } catch DeviceAuthorizationError.expired {
            connectionState = .failed("The browser code expired. Try again.")
            status = "Connection expired"
        } catch {
            connectionState = .failed("Ag could not finish connecting. Try again.")
            status = "Could not connect to Ag"
        }
    }

    @discardableResult public func useConnectionForSession() -> Bool {
        do {
            guard !token.isEmpty else { throw MoaMacError.missingToken }
            try store.saveOrigin(origin)
            status = "Connected for this app session"
            return true
        } catch {
            status = "Enter a canonical HTTPS gateway origin and session token"
            return false
        }
    }

    public func disconnect() async {
        voiceGeneration &+= 1
        voiceReleaseRequested = false
        await voiceController.cancel()
        token = ""
        try? deviceSessionStore.clear()
        connectionState = .disconnected
        resetPresentation()
        status = "Disconnected — session credential cleared"
    }

    public func refreshBrowserDevices() async {
        guard let url = URL(string: origin), isConfigured else {
            browserDevices = []
            selectedBrowserID = ""
            status = "Connect to your gateway first"
            return
        }
        do {
            browserDevices = try await browserSender.onlineBrowsers(origin: url, bearerToken: token)
            if !browserDevices.contains(where: { $0.id == selectedBrowserID }) {
                selectedBrowserID = browserDevices.first?.id ?? ""
            }
            status = browserDevices.isEmpty ? "No online browser extension can open tabs" : "Browser extension ready"
        } catch GatewayChatTransportError.unauthorized {
            status = "Your Ag session expired — sign in again"
        } catch {
            status = "Could not load browser devices"
        }
    }

    public func openInBrowser() async {
        guard !isDelegatingBrowser else { return }
        isDelegatingBrowser = true
        defer { isDelegatingBrowser = false }
        do {
            guard let url = URL(string: origin) else { throw MoaMacError.invalidDestination }
            guard !selectedBrowserID.isEmpty,
                  browserDevices.contains(where: { $0.id == selectedBrowserID && $0.canOpenTab }) else {
                throw BrowserDelegationError.noOnlineBrowser
            }
            let request = try BrowserOpenRequest(origin: url, deviceID: selectedBrowserID, sessionID: sessionID, urlText: browserURL)
            let queued = try await browserSender.open(request, bearerToken: token)
            guard queued.targetDeviceID == selectedBrowserID else { throw BrowserDelegationError.invalidResponse }
            browserURL = ""
            browserHandoffPhase = .queued
            status = "Queued for browser extension"
            let terminal = try await browserSender.waitForTerminal(
                origin: url, queued: queued, sourceDeviceID: request.sourceDeviceID, bearerToken: token
            ) { [weak self] phase in
                self?.browserHandoffPhase = phase
                self?.status = phase == .running ? "Browser extension is opening the URL" : self?.status ?? ""
            }
            guard terminal.requestID == queued.requestID, terminal.targetDeviceID == selectedBrowserID else {
                throw BrowserDelegationError.invalidResponse
            }
            browserHandoffPhase = terminal.phase
            if terminal.phase == .completed {
                status = terminal.summary.isEmpty ? "Browser extension opened the URL" : terminal.summary
            } else {
                throw BrowserDelegationError.failed(terminal.summary)
            }
        } catch BrowserDelegationError.invalidURL, BrowserDelegationError.unsupportedURL {
            status = "Enter a complete HTTP or HTTPS URL"
            browserHandoffPhase = .failed
        } catch BrowserDelegationError.noOnlineBrowser {
            status = "Choose an online browser extension"
            browserHandoffPhase = .failed
        } catch BrowserDelegationError.timedOut {
            status = "Browser extension did not finish in time"
            browserHandoffPhase = .failed
        } catch BrowserDelegationError.failed(let message) {
            status = message.isEmpty ? "Browser extension could not open the URL" : message
            browserHandoffPhase = .failed
        } catch GatewayChatTransportError.unauthorized {
            status = "Your Ag session expired — sign in again"
            browserHandoffPhase = .failed
        } catch {
            status = "Could not send work to the browser"
            browserHandoffPhase = .failed
        }
    }

    public func submit() async {
        guard !isSending else { return }
        let submittedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        isSending = true
        status = "Thinking…"
        defer { isSending = false }
        do {
            guard let url = URL(string: origin) else { throw MoaMacError.invalidDestination }
            let request = try GatewayChatRequest(origin: url, sessionID: sessionID, prompt: submittedPrompt)
            lastSubmittedPrompt = submittedPrompt
            let result = try await sender.send(request, bearerToken: token)
            reply = result.text
            prompt = ""
            status = "Reply received"
        } catch GatewayChatTransportError.unauthorized {
            status = "Gateway rejected the token"
        } catch GatewayChatError.emptyPrompt {
            status = "Type something first"
        } catch GatewayChatError.promptTooLarge {
            status = "That message is too large"
        } catch MoaMacError.missingToken {
            status = "Sign in to Ag first"
        } catch MoaMacError.invalidDestination {
            status = "Use a canonical HTTPS gateway origin"
        } catch {
            status = "Could not reach the gateway"
        }
    }

    public func resetPresentation() {
        prompt = ""
        lastSubmittedPrompt = ""
        reply = ""
        status = "Ready"
        voiceState.apply(.reset)
        voiceActivity = .assistant
        voiceLevels = Array(repeating: 0.08, count: 18)
        historyEntries = []
        isShowingHistory = false
        historyStatus = ""
        browserURL = ""
        browserDevices = []
        selectedBrowserID = ""
        browserHandoffPhase = .idle
    }

    public func toggleHistory() async {
        if isShowingHistory {
            isShowingHistory = false
            return
        }
        guard let url = URL(string: origin), isConfigured else {
            historyStatus = "Connect to your gateway first"
            isShowingHistory = true
            return
        }
        isShowingHistory = true
        historyStatus = "Loading durable history…"
        do {
            historyEntries = try await historyLoader.load(origin: url, bearerToken: token, sessionID: sessionID)
            historyStatus = historyEntries.isEmpty ? "No turns in this session yet" : ""
        } catch {
            historyEntries = []
            historyStatus = "Could not load gateway history"
        }
    }

    /// One explicit summon starts a latched capture. The next summon commits
    /// that same turn, even when the microphone or socket is still starting.
    public func handleSummon() async {
        await handleVoice(.assistant)
    }

    public func handleDictation() async {
        await handleVoice(.dictation)
    }

    private func handleVoice(_ requestedActivity: VoiceActivity) async {
        interactionPulse &+= 1
        if voiceState.isActive {
            await finishVoice()
        } else {
            await startVoice(requestedActivity)
        }
    }

    public func startVoice() async {
        await startVoice(.assistant)
    }

    private func startVoice(_ activity: VoiceActivity) async {
        guard !voiceState.isActive else { return }
        voiceGeneration &+= 1
        let generation = voiceGeneration
        voiceReleaseRequested = false
        voiceActivity = activity
        reply = ""
        voiceState.apply(.begin)
        do {
            guard isConfigured else { throw MoaMacError.missingToken }
            guard let url = URL(string: origin) else { throw MoaMacError.invalidDestination }
            let turnID = "turn-\(UUID().uuidString.lowercased())"
            let levelHandler: @MainActor @Sendable (Double) -> Void = { [weak self] level in
                    guard let self, self.voiceGeneration == generation else { return }
                    self.voiceLevels.removeFirst()
                    self.voiceLevels.append(level)
                }
            let eventHandler: @MainActor @Sendable (GatewayVoiceServerEvent) -> Void = { [weak self] event in
                guard let self, self.voiceGeneration == generation else { return }
                switch event {
                case let .assistantText(text) where activity == .assistant: self.reply = text
                case let .assistantTextDelta(delta) where activity == .assistant: self.reply += delta
                default: break
                }
                self.voiceState.apply(.server(event))
            }
            if activity == .dictation {
                try await voiceController.startDictation(
                    origin: url, bearerToken: token, sessionID: sessionID, turnID: turnID,
                    levelHandler: levelHandler, eventHandler: eventHandler)
            } else {
                try await voiceController.start(
                    origin: url, bearerToken: token, sessionID: sessionID, turnID: turnID,
                    levelHandler: levelHandler, eventHandler: eventHandler)
            }
            guard voiceGeneration == generation else {
                await voiceController.cancel()
                return
            }
            microphonePermission = .granted
            voiceState.apply(.captureStarted)
            if voiceReleaseRequested {
                try await voiceController.stopAndCommit()
            }
        } catch VoiceCaptureError.microphoneDenied {
            microphonePermission = .denied
            voiceState.apply(.permissionDenied)
        } catch MoaMacError.missingToken {
            voiceState.apply(.failed("Sign in to Ag first"))
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
            voiceLevels = Array(repeating: 0.08, count: 18)
        } catch {
            voiceState.apply(.interrupted("Microphone capture was interrupted"))
            await voiceController.cancel()
        }
    }

    public func cancelVoice() async {
        interactionPulse &+= 1
        voiceGeneration &+= 1
        voiceReleaseRequested = false
        await voiceController.cancel()
        voiceLevels = Array(repeating: 0.08, count: 18)
        if voiceState.isActive {
            voiceState.apply(.interrupted("Transcription canceled"))
        }
    }

    public func copyDictation() {
        guard voiceActivity == .dictation, !voiceState.final.isEmpty else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        if pasteboard.setString(voiceState.final, forType: .string) {
            status = "Copied — clipboard replaced"
        } else {
            status = "Could not copy — transcript preserved"
        }
    }

    public func refreshMicrophonePermission() {
        microphonePermission = SystemMicrophonePermission.currentState
        if microphonePermission == .granted, voiceState.phase == .denied {
            voiceState.apply(.reset)
            status = "Microphone ready"
        }
    }

    public func openMicrophoneSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") else {
            status = "Could not open Microphone settings"
            return
        }
        if NSWorkspace.shared.open(url) {
            status = "Enable Ag under Microphone, then return here"
        } else {
            status = "Open Privacy & Security > Microphone and enable Ag"
        }
    }
}
#endif
