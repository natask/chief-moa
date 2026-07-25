#if os(macOS)
import Foundation
import MoaMacCore

public struct GatewayHistoryEntry: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let type: String
    public let source: String
    public let text: String
    public let assistantText: String
    public let createdAt: String

    public init(id: String, type: String, source: String, text: String, assistantText: String, createdAt: String) {
        self.id = id
        self.type = type
        self.source = source
        self.text = text
        self.assistantText = assistantText
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, type, source, text
        case assistantText = "assistant_text"
        case createdAt = "created_at"
    }
}

public protocol GatewayHistoryLoading: Sendable {
    func load(origin: URL, bearerToken: String, sessionID: String) async throws -> [GatewayHistoryEntry]
}

public struct URLSessionGatewayHistoryLoader: GatewayHistoryLoading {
    public init() {}

    public func load(origin: URL, bearerToken: String, sessionID: String) async throws -> [GatewayHistoryEntry] {
        guard !bearerToken.isEmpty else { throw MoaMacError.missingToken }
        let endpoint = try GatewayOrigin.endpoint(origin: origin, path: ["v1", "history", "messages"])
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw MoaMacError.invalidDestination
        }
        components.queryItems = [
            URLQueryItem(name: "conversation_id", value: sessionID),
            URLQueryItem(name: "limit", value: "20"),
        ]
        guard let url = components.url else { throw MoaMacError.invalidDestination }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw GatewayChatTransportError.invalidHTTPResponse
        }
        var buffer = BoundedResponseBuffer()
        for try await byte in bytes { try buffer.append(byte) }
        return try JSONDecoder().decode(Response.self, from: buffer.value).messages
    }

    private struct Response: Decodable {
        let messages: [GatewayHistoryEntry]
    }
}
#endif
