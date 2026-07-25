#if os(macOS)
import Foundation
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
    @Published public var origin: String
    @Published public var token: String
    @Published public var prompt = ""
    @Published public private(set) var reply = ""
    @Published public private(set) var status = "Ready"
    @Published public private(set) var isSending = false
    @Published public private(set) var voiceState = VoiceTranscriptState()

    private let store: any GatewayConnectionStore
    private let sender: any GatewayChatSending
    private let voiceController: any VoiceCaptureControlling
    private let sessionID: String
    private var voiceGeneration: UInt64 = 0
    private var voiceReleaseRequested = false

    public convenience init() {
        self.init(
            store: SystemGatewayConnectionStore(),
            sender: URLSessionGatewayChatSender(),
            voiceController: VoiceCaptureController()
        )
    }

    public init(
        store: any GatewayConnectionStore,
        sender: any GatewayChatSending,
        voiceController: (any VoiceCaptureControlling)? = nil
    ) {
        self.store = store
        self.sender = sender
        self.voiceController = voiceController ?? VoiceCaptureController()
        origin = store.loadOrigin()
        token = ""
        sessionID = store.loadSessionID()
    }

    public var isConfigured: Bool { !origin.isEmpty && !token.isEmpty }

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
        resetPresentation()
        status = "Disconnected — session credential cleared"
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

    public func resetPresentation() {
        prompt = ""
        reply = ""
        status = "Ready"
        voiceState.apply(.reset)
    }

    /// One explicit summon starts a latched capture. The next summon commits
    /// that same turn, even when the microphone or socket is still starting.
    public func handleSummon() async {
        if voiceState.isActive {
            await finishVoice()
        } else {
            await startVoice()
        }
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
