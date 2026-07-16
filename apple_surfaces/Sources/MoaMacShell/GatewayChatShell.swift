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

    private let store: any GatewayConnectionStore
    private let sender: any GatewayChatSending
    private let sessionID: String

    public convenience init() {
        self.init(store: SystemGatewayConnectionStore(), sender: URLSessionGatewayChatSender())
    }

    public init(store: any GatewayConnectionStore, sender: any GatewayChatSending) {
        self.store = store
        self.sender = sender
        origin = store.loadOrigin()
        token = store.loadToken()
        sessionID = store.loadSessionID()
    }

    public var isConfigured: Bool { !origin.isEmpty && !token.isEmpty }

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
    }
}
#endif
