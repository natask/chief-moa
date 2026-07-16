#if os(macOS)
import Foundation
import MoaMacCore

public struct MacSurfaceProgramGrant: Equatable, Sendable {
    public let grantID: String
    public let deviceID: String
    public let clientInstanceID: String

    public init(grantID: String, deviceID: String, clientInstanceID: String) {
        self.grantID = grantID
        self.deviceID = deviceID
        self.clientInstanceID = clientInstanceID
    }
}

public struct MacClaimedSurfaceProgram: Equatable, Sendable {
    public let requestID: String
    public let envelopeData: Data

    public init(requestID: String, envelopeData: Data) {
        self.requestID = requestID
        self.envelopeData = envelopeData
    }
}

public enum MacSurfaceProgramUpload: Equatable, Sendable {
    case event(requestID: String)
    case toolReceipt(requestID: String)
    case terminalReceipt(requestID: String)
}

/// The transport owns gateway authentication and HTTP response validation. The
/// client supplies and consumes immutable JSON bytes so proposal validation and
/// idempotent upload replay never depend on an untyped dictionary bridge.
public protocol MacSurfaceProgramTransporting: Sendable {
    func heartbeat(body: Data) async throws
    func claim(body: Data) async throws -> MacClaimedSurfaceProgram?
    func upload(_ destination: MacSurfaceProgramUpload, body: Data) async throws
}

/// Ephemeral, redirect-denying gateway transport. Claim responses carry the
/// proposal as an exact canonical JSON string so the client hashes the bytes it
/// received instead of reconstructing them through Foundation date values.
public final class URLSessionMacSurfaceProgramTransport: MacSurfaceProgramTransporting,
    @unchecked Sendable {
    private struct ClaimResponse: Decodable {
        let requestID: String
        let envelopeJCS: String
        enum CodingKeys: String, CodingKey {
            case requestID = "request_id", envelopeJCS = "envelope_jcs"
        }
    }
    private let origin: URL
    private let bearerToken: String
    private let session: URLSession

    public init(origin: URL, bearerToken: String) throws {
        guard origin.scheme == "https", origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil, !bearerToken.isEmpty else {
            throw MacSurfaceProgramClientError.invalidGrant
        }
        self.origin = origin
        self.bearerToken = bearerToken
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpShouldSetCookies = false
        self.session = URLSession(configuration: configuration,
            delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    public func heartbeat(body: Data) async throws {
        _ = try await send(path: "/v1/device-clients/heartbeat", body: body,
            accepted: 200..<300)
    }

    public func claim(body: Data) async throws -> MacClaimedSurfaceProgram? {
        let response = try await send(path: "/v1/tool/requests/claim", body: body,
            accepted: 200..<300)
        if response.statusCode == 204 || response.body.isEmpty { return nil }
        let decoder = JSONDecoder()
        guard let value = try? decoder.decode(ClaimResponse.self, from: response.body),
              !value.requestID.isEmpty,
              let envelope = value.envelopeJCS.data(using: .utf8),
              (try? MacCanonicalJSON.parse(envelope).canonicalData) == envelope else {
            throw MacSurfaceProgramClientError.invalidClaim
        }
        return .init(requestID: value.requestID, envelopeData: envelope)
    }

    public func upload(_ destination: MacSurfaceProgramUpload, body: Data) async throws {
        let requestID: String, suffix: String
        switch destination {
        case .event(let id): requestID = id; suffix = "events"
        case .toolReceipt(let id): requestID = id; suffix = "tool-receipts"
        case .terminalReceipt(let id): requestID = id; suffix = "receipts"
        }
        guard requestID.range(of: "^[A-Za-z0-9_-]{1,160}$",
            options: .regularExpression) != nil else {
            throw MacSurfaceProgramClientError.invalidClaim
        }
        _ = try await send(path: "/v1/tool/requests/\(requestID)/\(suffix)",
            body: body, accepted: 200..<300)
    }

    private func send(path: String, body: Data, accepted: Range<Int>) async throws
        -> (statusCode: Int, body: Data) {
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.scheme == origin.scheme, url.host == origin.host,
              url.port == origin.port else { throw MacSurfaceProgramClientError.invalidGrant }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        let (responseBody, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              accepted.contains(http.statusCode), responseBody.count <= 256 * 1024 else {
            throw MacSurfaceProgramClientError.invalidClaim
        }
        return (http.statusCode, responseBody)
    }
}

public protocol MacSurfaceProgramRunning: AnyObject, Sendable {
    var advertisement: MacLocalProgramAdvertisement { get }
    func execute(_ envelope: MacLocalProgramEnvelope,
                 approvedProgramSHA256: String) -> MacLocalProgramResult
    func requestStop(executionID: String) throws
    func lifecycleEvents(executionID: String) throws -> [MacProgramLifecycleEvent]
    func toolReceipts(executionID: String) throws -> [MacLocalActionReceipt]
    func terminalReceipt(executionID: String) throws -> MacProgramTerminalReceipt?
}

extension JavaScriptCoreMacProgramRuntime: MacSurfaceProgramRunning {}

public enum MacSurfaceProgramClientResult: Equatable, Sendable {
    case noGrant
    case noClaim
    case executed(executionID: String, status: String)
}

public enum MacSurfaceProgramClientError: Error, Equatable {
    case invalidGrant
    case invalidClaim
    case missingTerminalReceipt
}

/// One-grant, one-at-a-time receive/execute/drain coordinator. Starting it has
/// no network effect; the owner explicitly invokes receiveAndRunOne while the
/// product grant remains visible and valid.
public actor MacSurfaceProgramClient {
    public typealias RuntimeFactory = @Sendable (MacSurfaceProgramGrant) throws -> any MacSurfaceProgramRunning
    public typealias ProposalAuthorizer = @Sendable (MacLocalProgramEnvelope) -> String?

    private struct Active {
        let generation: UUID
        let grant: MacSurfaceProgramGrant
        let runtime: any MacSurfaceProgramRunning
        var executionID: String?
    }

    private let transport: any MacSurfaceProgramTransporting
    private let runtimeFactory: RuntimeFactory
    private let proposalAuthorizer: ProposalAuthorizer
    private var active: Active?

    public init(transport: any MacSurfaceProgramTransporting,
                runtimeFactory: @escaping RuntimeFactory,
                proposalAuthorizer: @escaping ProposalAuthorizer) {
        self.transport = transport
        self.runtimeFactory = runtimeFactory
        self.proposalAuthorizer = proposalAuthorizer
    }

    public func start(grant: MacSurfaceProgramGrant) throws {
        guard !grant.grantID.isEmpty, !grant.deviceID.isEmpty,
              !grant.clientInstanceID.isEmpty else {
            throw MacSurfaceProgramClientError.invalidGrant
        }
        let runtime = try runtimeFactory(grant)
        guard runtime.advertisement.target.surfaceType == "macos",
              runtime.advertisement.target.deviceID == grant.deviceID else {
            throw MacSurfaceProgramClientError.invalidGrant
        }
        active = Active(generation: UUID(), grant: grant, runtime: runtime,
            executionID: nil)
    }

    public func stop() {
        guard let current = active else { return }
        active = nil
        if let executionID = current.executionID {
            try? current.runtime.requestStop(executionID: executionID)
        }
    }

    public func receiveAndRunOne() async throws -> MacSurfaceProgramClientResult {
        guard let current = active else { return .noGrant }
        let generation = current.generation
        try await transport.heartbeat(body: try Self.heartbeatData(current))
        guard active?.generation == generation else { return .noGrant }
        guard let claim = try await transport.claim(body: try Self.claimData(current.grant)) else {
            return .noClaim
        }
        guard !claim.requestID.isEmpty else { throw MacSurfaceProgramClientError.invalidClaim }
        let envelope: MacLocalProgramEnvelope
        do { envelope = try MacLocalProgramEnvelope.decodeStrict(claim.envelopeData) }
        catch { throw MacSurfaceProgramClientError.invalidClaim }
        guard envelope.target.deviceID == current.grant.deviceID,
              let approvedDigest = proposalAuthorizer(envelope),
              approvedDigest == envelope.program.sha256,
              active?.generation == generation else {
            throw MacSurfaceProgramClientError.invalidClaim
        }
        active?.executionID = envelope.executionID
        let runtime = current.runtime
        let result = await Task.detached {
            runtime.execute(envelope, approvedProgramSHA256: approvedDigest)
        }.value
        guard active?.generation == generation else { return .noGrant }
        try await drain(requestID: claim.requestID, executionID: envelope.executionID,
            runtime: runtime, generation: generation)
        if active?.generation == generation { active?.executionID = nil }
        return .executed(executionID: result.executionID, status: result.status)
    }

    private func drain(requestID: String, executionID: String,
                       runtime: any MacSurfaceProgramRunning,
                       generation: UUID) async throws {
        let events = try runtime.lifecycleEvents(executionID: executionID)
        let receipts = try runtime.toolReceipts(executionID: executionID)
        let receiptsByID = Dictionary(uniqueKeysWithValues: receipts.map { ($0.receiptID, $0) })
        let terminal = try runtime.terminalReceipt(executionID: executionID)
        for event in events {
            guard active?.generation == generation else { return }
            switch event.payload {
            case .toolFinished(_, _, _, _, let receiptID, _):
                guard let receipt = receiptsByID[receiptID] else {
                    throw MacSurfaceProgramClientError.invalidClaim
                }
                try await transport.upload(.toolReceipt(requestID: requestID),
                    body: try Self.encode(receipt))
                try await transport.upload(.event(requestID: requestID),
                    body: try Self.encode(event))
            case .terminal:
                guard let terminal else {
                    throw MacSurfaceProgramClientError.missingTerminalReceipt
                }
                try await transport.upload(.terminalReceipt(requestID: requestID),
                    body: try Self.encode(terminal))
                try await transport.upload(.event(requestID: requestID),
                    body: try Self.encode(event))
            default:
                try await transport.upload(.event(requestID: requestID),
                    body: try Self.encode(event))
            }
        }
    }

    private static func heartbeatData(_ active: Active) throws -> Data {
        struct Heartbeat: Encodable {
            let deviceID: String
            let surfaceType = "macos"
            let clientInstanceID: String
            let status = "online"
            let online = true
            let localToolManifest: [MacCapabilityDescriptor]
            let executionRuntimes: [MacLocalProgramAdvertisement]
            enum CodingKeys: String, CodingKey {
                case status, online
                case deviceID = "device_id", surfaceType = "surface_type"
                case clientInstanceID = "client_instance_id"
                case localToolManifest = "local_tool_manifest"
                case executionRuntimes = "execution_runtimes"
            }
        }
        return try encode(Heartbeat(deviceID: active.grant.deviceID,
            clientInstanceID: active.grant.clientInstanceID,
            localToolManifest: MacLocalProgramAdvertisement.descriptors,
            executionRuntimes: [active.runtime.advertisement]))
    }

    private static func claimData(_ grant: MacSurfaceProgramGrant) throws -> Data {
        struct Claim: Encodable {
            let deviceID: String, clientInstanceID: String
            enum CodingKeys: String, CodingKey {
                case deviceID = "device_id", clientInstanceID = "client_instance_id"
            }
        }
        return try encode(Claim(deviceID: grant.deviceID,
            clientInstanceID: grant.clientInstanceID))
    }

    private static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = MacProtocolTimestamp.encodingStrategy
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }
}
#endif
