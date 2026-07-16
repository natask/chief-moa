import Foundation

public enum GatewayChatError: Error, Equatable, Sendable {
    case emptyPrompt
    case promptTooLarge
    case responseTooLarge
    case invalidResponse
}

public struct GatewayChatRequest: Sendable {
    public static let maximumPromptBytes = 16 * 1024
    public static let maximumBodyBytes = 24 * 1024

    public let endpoint: URL
    public let body: Data

    public init(origin: URL, sessionID: String, prompt: String) throws {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw GatewayChatError.emptyPrompt }
        guard trimmed.utf8.count <= Self.maximumPromptBytes else { throw GatewayChatError.promptTooLarge }

        endpoint = try GatewayOrigin.endpoint(origin: origin, path: ["v1", "chat"])
        let value = Body(
            sessionID: sessionID,
            conversationID: sessionID,
            source: "moa-macos",
            messages: [.init(role: "user", content: trimmed)]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        body = try encoder.encode(value)
        guard body.count <= Self.maximumBodyBytes else { throw GatewayChatError.promptTooLarge }
    }

    private struct Body: Encodable {
        struct Message: Encodable { let role: String; let content: String }
        let sessionID: String
        let conversationID: String
        let source: String
        let messages: [Message]

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case conversationID = "conversation_id"
            case source, messages
        }
    }
}

public struct GatewayChatReply: Equatable, Sendable {
    public let text: String
    public init(text: String) { self.text = text }
}

public enum GatewayChatReplyDecoder {
    public static let maximumResponseBytes = 64 * 1024
    public static let maximumTextBytes = 32 * 1024

    public static func decode(_ data: Data) throws -> GatewayChatReply {
        guard data.count <= maximumResponseBytes else { throw GatewayChatError.responseTooLarge }
        guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              !containsAuthorityShapedField(raw),
              let text = raw["text"] as? String else { throw GatewayChatError.invalidResponse }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= maximumTextBytes else { throw GatewayChatError.invalidResponse }
        return GatewayChatReply(text: trimmed)
    }

    private static func containsAuthorityShapedField(_ value: Any) -> Bool {
        if let object = value as? [String: Any] {
            let blocked = Set(["action", "actions", "command", "commands", "executable", "script", "tool", "tool_calls"])
            return object.contains { key, child in blocked.contains(key.lowercased()) || containsAuthorityShapedField(child) }
        }
        if let array = value as? [Any] { return array.contains(where: containsAuthorityShapedField) }
        return false
    }
}
