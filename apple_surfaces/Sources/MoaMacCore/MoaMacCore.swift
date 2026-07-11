import CryptoKit
import Foundation

public enum ReleaseMode: String, Codable, Sendable { case localOnly = "local_only", askEachTime = "ask_each_time", trustedServer15m = "trusted_server_15m" }
public enum MoaMacError: Error, Equatable, Sendable { case invalidDestination, invalidGrant, expired, scopeChanged, tooLarge, approvalMismatch, redirect, invalidResponse, missingToken, cancelled }

public struct ProcessIdentity: Codable, Equatable, Sendable {
    public let bundleID: String; public let pid: Int32; public let processStart: Date; public let signingIdentity: String
    public init(bundleID: String, pid: Int32, processStart: Date, signingIdentity: String) { self.bundleID = bundleID; self.pid = pid; self.processStart = processStart; self.signingIdentity = signingIdentity }
}

public struct ObservationGrant: Equatable, Sendable {
    public let id: UUID; public let process: ProcessIdentity; public let mode: ReleaseMode; public let includeScreenshot: Bool
    public let issuedAt: Date; public let expiresAt: Date; public let destinationOrigin: URL?
    public init(id: UUID = UUID(), process: ProcessIdentity, mode: ReleaseMode, includeScreenshot: Bool = false, issuedAt: Date, expiresAt: Date, destinationOrigin: URL? = nil) throws {
        guard expiresAt > issuedAt, expiresAt.timeIntervalSince(issuedAt) <= 900 else { throw MoaMacError.invalidGrant }
        if mode != .localOnly { guard destinationOrigin != nil else { throw MoaMacError.invalidDestination } }
        self.id = id; self.process = process; self.mode = mode; self.includeScreenshot = includeScreenshot
        self.issuedAt = issuedAt; self.expiresAt = expiresAt; self.destinationOrigin = destinationOrigin
    }
}

public actor GrantStore {
    private var grant: ObservationGrant?
    public init() {}
    public func start(_ value: ObservationGrant) { grant = value }
    public func stop() { grant = nil }
    public func peek() -> ObservationGrant? { grant }
    public func current(now: Date, process: ProcessIdentity) throws -> ObservationGrant {
        guard let grant else { throw MoaMacError.invalidGrant }
        guard now < grant.expiresAt else { self.grant = nil; throw MoaMacError.expired }
        guard grant.process == process else { self.grant = nil; throw MoaMacError.scopeChanged }
        return grant
    }
}

public enum DestinationPolicy {
    public static func endpoint(origin: URL) throws -> URL {
        guard origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
              origin.path.isEmpty || origin.path == "/" else { throw MoaMacError.invalidDestination }
        let host = origin.host?.lowercased() ?? ""
        let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard (origin.scheme == "https" || (origin.scheme == "http" && loopback)), !host.isEmpty else { throw MoaMacError.invalidDestination }
        return origin.appendingPathComponent("v1/proactive/macos")
    }
}

public struct AXNode: Codable, Equatable, Sendable {
    public let id: String; public let parentID: String?; public let role: String; public let subrole: String?
    public let label: String?; public let enabled: Bool; public let focused: Bool; public let actions: [String]
    enum CodingKeys: String, CodingKey { case id, role, subrole, label, enabled, focused, actions; case parentID = "parent_id" }
    public init(id: String, parentID: String?, role: String, subrole: String?, label: String?, enabled: Bool, focused: Bool, actions: [String]) {
        self.id=id; self.parentID=parentID; self.role=role; self.subrole=subrole; self.label=label; self.enabled=enabled; self.focused=focused; self.actions=actions
    }
}
public struct AXSnapshot: Codable, Equatable, Sendable {
    public let nodes: [AXNode]; public let truncated: Bool; public let dropped: Int
    public init(nodes: [AXNode], truncated: Bool, dropped: Int) { self.nodes=nodes; self.truncated=truncated; self.dropped=dropped }
}
public struct ScreenshotEvidence: Codable, Equatable, Sendable {
    public let mimeType: String; public let dataBase64: String; public let sha256: String; public let width: Int; public let height: Int
    enum CodingKeys: String, CodingKey { case mimeType = "mime_type", dataBase64 = "data_base64", sha256, width, height }
    public init(mimeType: String = "image/jpeg", dataBase64: String, sha256: String, width: Int, height: Int) { self.mimeType=mimeType; self.dataBase64=dataBase64; self.sha256=sha256; self.width=width; self.height=height }
}
public struct Observation: Codable, Equatable, Sendable {
    public struct App: Codable, Equatable, Sendable { public let bundleID: String; public let name: String; enum CodingKeys: String, CodingKey { case bundleID = "bundle_id", name }; public init(bundleID: String, name: String) { self.bundleID = bundleID; self.name = name } }
    public struct Window: Codable, Equatable, Sendable { public let title: String; public init(title: String) { self.title = title } }
    public let observationID: String; public let capturedAt: Date; public let app: App; public let window: Window; public let ax: AXSnapshot; public let screenshot: ScreenshotEvidence?
    enum CodingKeys: String, CodingKey { case observationID = "observation_id", capturedAt = "captured_at", app, window, ax, screenshot }
    public init(observationID: String, capturedAt: Date, app: App, window: Window, ax: AXSnapshot, screenshot: ScreenshotEvidence?) {
        self.observationID=observationID; self.capturedAt=capturedAt
        self.app = App(bundleID: app.bundleID, name: ObservationBounds.text(app.name))
        self.window = Window(title: ObservationBounds.text(window.title))
        self.ax = ObservationBounds.snapshot(ax.nodes, dropped: ax.dropped); self.screenshot=screenshot
    }
    public func encode(to encoder: Encoder) throws { var container = encoder.container(keyedBy: CodingKeys.self); try container.encode(observationID, forKey: .observationID); try container.encode(capturedAt, forKey: .capturedAt); try container.encode(app, forKey: .app); try container.encode(window, forKey: .window); try container.encode(ax, forKey: .ax); if let screenshot { try container.encode(screenshot, forKey: .screenshot) } else { try container.encodeNil(forKey: .screenshot) } }
}

public enum ObservationBounds {
    public static let maxNodes = 128, maxDepth = 8, maxLabelBytes = 256, maxAXBytes = 16 * 1024, maxScreenshotBytes = 1024 * 1024
    public static func text(_ value: String) -> String { label(value) ?? "[redacted]" }
    public static func label(_ value: String?) -> String? {
        guard let value else { return nil }
        if let url = URL(string: value), let scheme = url.scheme, let host = url.host { return "\(scheme)://\(host)" }
        let sensitive = ["password", "passcode", "credit card", "security code", "api key", "token"]
        guard !sensitive.contains(where: { value.localizedCaseInsensitiveContains($0) }) else { return nil }
        let patterns = [#"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, #"(?:\+?\d[\d .()-]{7,}\d)"#, #"(?:\d[ -]*?){13,19}"#, #"/Users/[^/\s]+"#]
        guard !patterns.contains(where: { value.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }) else { return nil }
        var bytes = Array(value.utf8.prefix(maxLabelBytes)); while String(bytes: bytes, encoding: .utf8) == nil { bytes.removeLast() }
        return String(bytes: bytes, encoding: .utf8)
    }
    public static func snapshot(_ nodes: [AXNode], dropped: Int = 0) -> AXSnapshot {
        let bounded = nodes.prefix(maxNodes).map { AXNode(id: $0.id, parentID: $0.parentID, role: $0.role, subrole: $0.subrole, label: label($0.label), enabled: $0.enabled, focused: $0.focused, actions: Array($0.actions.prefix(8))) }
        var result = AXSnapshot(nodes: Array(bounded), truncated: nodes.count > maxNodes, dropped: dropped + max(0, nodes.count - maxNodes))
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        while (try? encoder.encode(result).count) ?? Int.max > maxAXBytes, !result.nodes.isEmpty {
            result = AXSnapshot(nodes: Array(result.nodes.dropLast()), truncated: true, dropped: result.dropped + 1)
        }
        return result
    }
}

private struct RequestBody: Codable { struct Client: Codable { let surface: String; let releaseMode: String; enum CodingKeys: String, CodingKey { case surface; case releaseMode = "release_mode" } }; let version: Int; let client: Client; let observation: Observation }
public struct RequestPreview: Sendable {
    public let url: URL; public let method: String; public let contentType: String; public let redirectPolicy: String; public let body: Data; public let bodySHA256: String
    public init(origin: URL, mode: ReleaseMode, observation: Observation) throws {
        url = try DestinationPolicy.endpoint(origin: origin); method = "POST"; contentType = "application/json"; redirectPolicy = "error"
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]; encoder.dateEncodingStrategy = .iso8601
        body = try encoder.encode(RequestBody(version: 1, client: .init(surface: "macos", releaseMode: mode.rawValue), observation: observation))
        guard body.count <= 1_572_864 else { throw MoaMacError.tooLarge }
        bodySHA256 = Self.digest(body)
    }
    public func validateApproval(digest: String) throws { guard digest == bodySHA256 else { throw MoaMacError.approvalMismatch } }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}

public struct InertSuggestion: Codable, Equatable, Sendable {
    public let version: Int; public let suggestion: String; public let actions: [String]
    public init(version: Int = 1, suggestion: String, actions: [String] = []) { self.version=version; self.suggestion=suggestion; self.actions=actions }
}
public protocol SuggestionTransport: Sendable { func send(preview: RequestPreview, bearerToken: String) async throws -> Data }
public struct BoundedResponseBuffer: Sendable {
    public static let limit = 64 * 1024
    private var data = Data()
    public init() { data.reserveCapacity(4096) }
    public mutating func append(_ byte: UInt8) throws { guard data.count < Self.limit else { throw MoaMacError.tooLarge }; data.append(byte) }
    public var value: Data { data }
}
public protocol PreviewApprover: Sendable { func approve(_ preview: RequestPreview) async throws -> String }
public protocol ObservationScopeValidator: Sendable { func validate(process: ProcessIdentity, observation: Observation, focusedWindowID: UInt32?) async -> Bool }
public enum SuggestionDecoder {
    public static func decode(_ data: Data) throws -> InertSuggestion {
        guard data.count <= 64 * 1024, let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any], Set(raw.keys) == Set(["version","suggestion","actions"]) else { throw MoaMacError.invalidResponse }
        let value = try JSONDecoder().decode(InertSuggestion.self, from: data)
        guard value.version == 1, !value.suggestion.isEmpty, value.suggestion.utf8.count <= 2048, value.actions.isEmpty else { throw MoaMacError.invalidResponse }; return value
    }
}

public actor SuggestionCoordinator {
    private let grants: GrantStore
    private var generation: UInt64 = 0
    public init(grants: GrantStore) { self.grants = grants }
    public func cancel() { generation &+= 1 }

    public func suggest(observation: Observation, process: ProcessIdentity, origin: URL?, token: String?, now: @Sendable () -> Date,
                        approver: (any PreviewApprover)? = nil, transport: (any SuggestionTransport)? = nil,
                        scope: (any ObservationScopeValidator)? = nil, focusedWindowID: UInt32? = nil) async throws -> InertSuggestion {
        let started = generation
        guard await scope?.validate(process: process, observation: observation, focusedWindowID: focusedWindowID) ?? true else { throw MoaMacError.scopeChanged }
        let grant = try await grants.current(now: now(), process: process)
        if grant.mode == .localOnly {
            return InertSuggestion(suggestion: Self.localSuggestion(observation))
        }
        guard let origin, origin == grant.destinationOrigin, let token, !token.isEmpty, let transport else { throw MoaMacError.missingToken }
        let preview = try RequestPreview(origin: origin, mode: grant.mode, observation: observation)
        if grant.mode == .askEachTime {
            guard let approver else { throw MoaMacError.approvalMismatch }
            let digest = try await approver.approve(preview)
            guard await scope?.validate(process: process, observation: observation, focusedWindowID: focusedWindowID) ?? true else { throw MoaMacError.scopeChanged }
            try preview.validateApproval(digest: digest)
        }
        guard started == generation else { throw MoaMacError.cancelled }
        _ = try await grants.current(now: now(), process: process)
        guard await scope?.validate(process: process, observation: observation, focusedWindowID: focusedWindowID) ?? true else { throw MoaMacError.scopeChanged }
        let data = try await transport.send(preview: preview, bearerToken: token)
        guard await scope?.validate(process: process, observation: observation, focusedWindowID: focusedWindowID) ?? true else { throw MoaMacError.scopeChanged }
        guard started == generation else { throw MoaMacError.cancelled }
        _ = try await grants.current(now: now(), process: process)
        return try SuggestionDecoder.decode(data)
    }

    private static func localSuggestion(_ observation: Observation) -> String {
        let roles = Set(observation.ax.nodes.map(\.role))
        if roles.contains("AXTextField") || roles.contains("AXTextArea") { return "Would you like help drafting or reviewing what you are working on?" }
        if roles.contains("AXButton") { return "Would you like help deciding the next step in this window?" }
        return "Would you like help making progress in \(observation.app.name)?"
    }
}
