#if os(macOS)
import Foundation
import MoaMacCore

public struct GatewayAgentRun: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let status: String
    public let harness: String
    public let source: String
    public let conversationID: String
    public let branchID: String
    public let projectID: String
    public let promptPreview: String
    public let outputPreview: String
    public let createdAt: String
    public let updatedAt: String
    public let finishedAt: String
    public let active: Bool

    public init(
        id: String,
        status: String,
        harness: String = "",
        source: String = "",
        conversationID: String = "",
        branchID: String = "default",
        projectID: String = "",
        promptPreview: String = "",
        outputPreview: String = "",
        createdAt: String = "",
        updatedAt: String = "",
        finishedAt: String = "",
        active: Bool = false
    ) {
        self.id = id
        self.status = status
        self.harness = harness
        self.source = source
        self.conversationID = conversationID
        self.branchID = branchID
        self.projectID = projectID
        self.promptPreview = promptPreview
        self.outputPreview = outputPreview
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.finishedAt = finishedAt
        self.active = active
    }

    enum CodingKeys: String, CodingKey {
        case id, status, harness, source, active
        case conversationID = "conversation_id"
        case branchID = "branch_id"
        case projectID = "project_id"
        case promptPreview = "prompt_preview"
        case outputPreview = "output_preview"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case finishedAt = "finished_at"
    }

    public var isRunning: Bool {
        active || ["pending", "queued", "claimed", "running"].contains(status.lowercased())
    }

    public var title: String {
        let value = promptPreview.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { return value }
        let runtime = harness.trimmingCharacters(in: .whitespacesAndNewlines)
        return runtime.isEmpty ? "Agent \(id.prefix(8))" : "\(runtime) agent"
    }
}

public protocol GatewayAgentRunLoading: Sendable {
    func load(origin: URL, bearerToken: String, limit: Int) async throws -> [GatewayAgentRun]
    func cancel(origin: URL, bearerToken: String, runID: String) async throws
}

public struct URLSessionGatewayAgentRunLoader: GatewayAgentRunLoading {
    public init() {}

    public func load(origin: URL, bearerToken: String, limit: Int = 25) async throws -> [GatewayAgentRun] {
        let endpoint = try GatewayOrigin.endpoint(origin: origin, path: ["v1", "agent", "runs"])
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw MoaMacError.invalidDestination
        }
        components.queryItems = [URLQueryItem(name: "limit", value: String(max(1, min(limit, 100))))]
        guard let url = components.url else { throw MoaMacError.invalidDestination }
        let data = try await send(url: url, method: "GET", bearerToken: bearerToken)
        return try JSONDecoder().decode(Response.self, from: data).runs
    }

    public func cancel(origin: URL, bearerToken: String, runID: String) async throws {
        guard isSafeRunID(runID) else { throw MoaMacError.invalidDestination }
        let endpoint = try GatewayOrigin.endpoint(origin: origin, path: ["v1", "agent", "runs", runID, "cancel"])
        _ = try await send(url: endpoint, method: "POST", bearerToken: bearerToken)
    }

    private func send(url: URL, method: String, bearerToken: String) async throws -> Data {
        guard !bearerToken.isEmpty else { throw MoaMacError.missingToken }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
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
        return buffer.value
    }

    private func isSafeRunID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 160 && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-"
        }
    }

    private struct Response: Decodable { let runs: [GatewayAgentRun] }
}
#endif
