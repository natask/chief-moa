import Foundation

public enum BrowserDelegationError: Error, Equatable, Sendable {
    case invalidURL
    case unsupportedURL
    case invalidResponse
    case noOnlineBrowser
    case timedOut
    case failed(String)
}

public struct BrowserDevice: Codable, Equatable, Identifiable, Sendable {
    public struct Tool: Codable, Equatable, Sendable {
        public let tool: String
        public init(tool: String) { self.tool = tool }
    }

    public let id: String
    public let surfaceType: String
    public let online: Bool
    public let localToolManifest: [Tool]

    public init(id: String, surfaceType: String, online: Bool, localToolManifest: [Tool]) {
        self.id = id
        self.surfaceType = surfaceType
        self.online = online
        self.localToolManifest = localToolManifest
    }

    public var canOpenTab: Bool {
        surfaceType == "browser_extension" && online && localToolManifest.contains { $0.tool == "browser.tab.open" }
    }

    enum CodingKeys: String, CodingKey {
        case id = "device_id"
        case surfaceType = "surface_type"
        case online
        case localToolManifest = "local_tool_manifest"
    }
}

public struct BrowserDeviceList: Decodable, Equatable, Sendable {
    public let devices: [BrowserDevice]
}

public struct BrowserOpenRequest: Sendable {
    public let endpoint: URL
    public let body: Data
    public let sourceDeviceID: String

    public init(origin: URL, deviceID: String, sessionID: String, urlText: String) throws {
        let trimmed = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              components.host?.isEmpty == false else { throw BrowserDelegationError.invalidURL }
        guard components.user == nil, components.password == nil else { throw BrowserDelegationError.unsupportedURL }
        components.fragment = nil
        guard let safeURL = components.url else { throw BrowserDelegationError.invalidURL }
        endpoint = try GatewayOrigin.endpoint(origin: origin, path: ["v1", "tool", "requests"])
        sourceDeviceID = sessionID
        body = try JSONEncoder.gateway.encode(Body(
            source: "moa-macos",
            sourceDeviceID: sessionID,
            sourceSurfaceType: "macos",
            targetSurfaceType: "browser_extension",
            targetDeviceID: deviceID,
            tool: "browser.tab.open",
            input: .init(url: safeURL.absoluteString, background: true),
            sessionID: sessionID,
            branchID: "mac_to_browser"
        ))
    }

    private struct Body: Encodable {
        struct Input: Encodable { let url: String; let background: Bool }
        let source: String
        let sourceDeviceID: String
        let sourceSurfaceType: String
        let targetSurfaceType: String
        let targetDeviceID: String
        let tool: String
        let input: Input
        let sessionID: String
        let branchID: String

        enum CodingKeys: String, CodingKey {
            case source, tool, input
            case sourceDeviceID = "source_device_id"
            case sourceSurfaceType = "source_surface_type"
            case targetSurfaceType = "target_surface_type"
            case targetDeviceID = "target_device_id"
            case sessionID = "session_id"
            case branchID = "branch_id"
        }
    }
}

public struct BrowserOpenQueueResult: Equatable, Sendable {
    public let requestID: String
    public let targetDeviceID: String
}

public enum BrowserOpenResponseDecoder {
    public static func decode(_ data: Data) throws -> BrowserOpenQueueResult {
        struct Response: Decodable {
            struct Request: Decodable {
                let id: String
                let targetDeviceID: String
                enum CodingKeys: String, CodingKey {
                    case id
                    case targetDeviceID = "target_device_id"
                }
            }
            let request: Request
        }
        guard let value = try? JSONDecoder().decode(Response.self, from: data),
              !value.request.id.isEmpty, !value.request.targetDeviceID.isEmpty else {
            throw BrowserDelegationError.invalidResponse
        }
        return BrowserOpenQueueResult(requestID: value.request.id, targetDeviceID: value.request.targetDeviceID)
    }
}

public enum BrowserHandoffPhase: String, Equatable, Sendable {
    case idle
    case queued
    case running
    case completed
    case failed
}

public struct BrowserOpenTerminalResult: Equatable, Sendable {
    public let requestID: String
    public let targetDeviceID: String
    public let phase: BrowserHandoffPhase
    public let summary: String
}

public enum BrowserOpenStatusDecoder {
    public static func decode(_ data: Data, requestID: String, targetDeviceID: String) throws -> BrowserOpenTerminalResult? {
        struct Response: Decodable { let requests: [Request] }
        struct Request: Decodable {
            struct Receipt: Decodable {
                let ok: Bool
                let summary: String?
                let error: String?
                let deviceID: String
                enum CodingKeys: String, CodingKey {
                    case ok, summary, error
                    case deviceID = "device_id"
                }
            }
            let id: String
            let status: String
            let targetDeviceID: String
            let latestReceipt: Receipt?
            enum CodingKeys: String, CodingKey {
                case id, status
                case targetDeviceID = "target_device_id"
                case latestReceipt = "latest_receipt"
            }
        }
        guard let response = try? JSONDecoder().decode(Response.self, from: data) else {
            throw BrowserDelegationError.invalidResponse
        }
        guard let record = response.requests.first(where: { $0.id == requestID }) else { return nil }
        guard record.targetDeviceID == targetDeviceID else { throw BrowserDelegationError.invalidResponse }
        switch record.status {
        case "pending": return nil
        case "claimed":
            return BrowserOpenTerminalResult(requestID: requestID, targetDeviceID: targetDeviceID, phase: .running, summary: "")
        case "completed", "failed":
            guard let receipt = record.latestReceipt, receipt.deviceID == targetDeviceID else {
                throw BrowserDelegationError.invalidResponse
            }
            let completed = record.status == "completed" && receipt.ok
            guard completed || (record.status == "failed" && !receipt.ok) else {
                throw BrowserDelegationError.invalidResponse
            }
            return BrowserOpenTerminalResult(
                requestID: requestID,
                targetDeviceID: targetDeviceID,
                phase: completed ? .completed : .failed,
                summary: completed ? (receipt.summary ?? "") : (receipt.error ?? receipt.summary ?? "Browser extension reported failure")
            )
        default: throw BrowserDelegationError.invalidResponse
        }
    }
}

private extension JSONEncoder {
    static var gateway: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
