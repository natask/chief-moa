import Foundation

public enum GatewayVoiceError: Error, Equatable, Sendable {
    case invalidEvent
    case eventTooLarge
    case transcriptTooLarge
    case emptyAudioFrame
    case invalidAudioFrame
    case audioFrameTooLarge
}

public struct GatewayVoiceAudioFrame: Equatable, Sendable {
    // The gateway currently permits WebSocket payloads up to 2 MiB. Keep a
    // client-owned limit far below that transport ceiling so a capture adapter
    // cannot turn an unexpectedly large callback into one network frame.
    public static let maximumBytes = 64 * 1024

    public let data: Data

    public init(_ data: Data) throws {
        guard !data.isEmpty else { throw GatewayVoiceError.emptyAudioFrame }
        guard data.count.isMultiple(of: MemoryLayout<Int16>.size) else {
            throw GatewayVoiceError.invalidAudioFrame
        }
        guard data.count <= Self.maximumBytes else { throw GatewayVoiceError.audioFrameTooLarge }
        self.data = data
    }
}

public struct GatewayVoiceSessionStart: Sendable {
    public static let maximumEventBytes = 8 * 1024

    public let endpoint: URL
    public let body: Data

    public init(origin: URL, sessionID: String, turnID: String) throws {
        let httpEndpoint = try GatewayOrigin.endpoint(origin: origin, path: ["v1", "voice", "sessions"])
        guard var components = URLComponents(url: httpEndpoint, resolvingAgainstBaseURL: false) else {
            throw MoaMacError.invalidDestination
        }
        components.scheme = httpEndpoint.scheme == "https" ? "wss" : "ws"
        guard let endpoint = components.url else { throw MoaMacError.invalidDestination }
        self.endpoint = endpoint

        let event = Event(
            type: "session_start",
            source: "moa-macos",
            sessionID: sessionID,
            conversationID: sessionID,
            branchID: "default",
            turnID: turnID,
            deliveryIntent: "literal_text",
            client: .init(platform: "macos", source: "moa-macos", input: "voice"),
            playbackPolicy: .init(assistantOverlap: false),
            format: .init(encoding: "pcm16", sampleRate: 16_000, channels: 1)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        body = try encoder.encode(event)
        guard body.count <= Self.maximumEventBytes else { throw GatewayVoiceError.eventTooLarge }
    }

    private struct Event: Encodable {
        struct Client: Encodable { let platform: String; let source: String; let input: String }
        struct PlaybackPolicy: Encodable {
            let assistantOverlap: Bool
            enum CodingKeys: String, CodingKey { case assistantOverlap = "assistant_overlap" }
        }
        struct Format: Encodable {
            let encoding: String
            let sampleRate: Int
            let channels: Int
            enum CodingKeys: String, CodingKey { case encoding, channels; case sampleRate = "sample_rate" }
        }
        let type: String
        let source: String
        let sessionID: String
        let conversationID: String
        let branchID: String
        let turnID: String
        let deliveryIntent: String
        let client: Client
        let playbackPolicy: PlaybackPolicy
        let format: Format

        enum CodingKeys: String, CodingKey {
            case type, source, client, format
            case sessionID = "session_id"
            case conversationID = "conversation_id"
            case branchID = "branch_id"
            case turnID = "turn_id"
            case deliveryIntent = "delivery_intent"
            case playbackPolicy = "playback_policy"
        }
    }
}

public enum GatewayVoiceClientEvent {
    public static func commit(turnID: String) throws -> Data {
        try encode(type: "commit_turn", turnID: turnID)
    }

    public static func cancel(turnID: String) throws -> Data {
        try encode(type: "cancel_turn", turnID: turnID)
    }

    private static func encode(type: String, turnID: String) throws -> Data {
        let data = try JSONEncoder().encode(Event(type: type, turnID: turnID))
        guard data.count <= GatewayVoiceSessionStart.maximumEventBytes else { throw GatewayVoiceError.eventTooLarge }
        return data
    }

    private struct Event: Encodable {
        let type: String
        let turnID: String
        enum CodingKeys: String, CodingKey { case type; case turnID = "turn_id" }
    }
}

public enum GatewayVoiceServerEvent: Equatable, Sendable {
    case sessionReady
    case transcriptPartial(String)
    case transcriptFinal(String)
    case turnDone(status: String, reason: String?)
    case failure(String)
    case ignored
}

public enum GatewayVoiceServerEventDecoder {
    public static let maximumEventBytes = 64 * 1024
    public static let maximumTranscriptBytes = 32 * 1024

    public static func decode(_ data: Data) throws -> GatewayVoiceServerEvent {
        guard data.count <= maximumEventBytes else { throw GatewayVoiceError.eventTooLarge }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { throw GatewayVoiceError.invalidEvent }
        switch type {
        case "session_ready":
            return .sessionReady
        case "transcript_partial":
            return .transcriptPartial(try transcript(object))
        case "transcript_final":
            return .transcriptFinal(try transcript(object))
        case "turn_done":
            guard let status = object["status"] as? String, !status.isEmpty else {
                throw GatewayVoiceError.invalidEvent
            }
            return .turnDone(status: status, reason: object["reason"] as? String)
        case "error":
            let message = (object["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !message.isEmpty, message.utf8.count <= maximumTranscriptBytes else {
                throw GatewayVoiceError.invalidEvent
            }
            return .failure(message)
        default:
            return .ignored
        }
    }

    private static func transcript(_ object: [String: Any]) throws -> String {
        let text = (object["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { throw GatewayVoiceError.invalidEvent }
        guard text.utf8.count <= maximumTranscriptBytes else { throw GatewayVoiceError.transcriptTooLarge }
        return text
    }
}

public enum VoiceTranscriptPhase: Equatable, Sendable {
    case idle
    case requestingPermission
    case connecting
    case listening
    case finalizing
    case completed
    case denied
    case interrupted
    case failed
}

public enum VoiceTranscriptAction: Equatable, Sendable {
    case begin
    case permissionGranted
    case permissionDenied
    case captureStarted
    case release
    case server(GatewayVoiceServerEvent)
    case interrupted(String)
    case failed(String)
    case reset
}

public struct VoiceTranscriptState: Equatable, Sendable {
    public private(set) var phase: VoiceTranscriptPhase = .idle
    public private(set) var partial = ""
    public private(set) var final = ""
    public private(set) var message = "Hold to transcribe"

    public init() {}

    public var isActive: Bool {
        [.requestingPermission, .connecting, .listening, .finalizing].contains(phase)
    }

    public mutating func apply(_ action: VoiceTranscriptAction) {
        switch action {
        case .begin:
            phase = .requestingPermission
            partial = ""
            final = ""
            message = "Requesting microphone access…"
        case .permissionGranted:
            guard phase == .requestingPermission else { return }
            phase = .connecting
            message = "Connecting to your gateway…"
        case .permissionDenied:
            phase = .denied
            message = "Microphone access was denied"
        case .captureStarted:
            guard phase == .requestingPermission || phase == .connecting else { return }
            phase = .listening
            message = "Listening… release to transcribe"
        case .release:
            guard phase == .requestingPermission || phase == .connecting || phase == .listening else { return }
            phase = .finalizing
            message = "Finishing transcript…"
        case let .server(event):
            apply(event)
        case let .interrupted(reason):
            phase = .interrupted
            message = reason
        case let .failed(reason):
            phase = .failed
            message = reason
        case .reset:
            self = VoiceTranscriptState()
        }
    }

    private mutating func apply(_ event: GatewayVoiceServerEvent) {
        switch event {
        case .sessionReady:
            if phase == .connecting || phase == .requestingPermission {
                phase = .listening
                message = "Listening… release to transcribe"
            }
        case let .transcriptPartial(text):
            guard final.isEmpty else { return }
            partial = text
            message = "Transcribing…"
        case let .transcriptFinal(text):
            partial = ""
            final = text
            phase = .completed
            message = "Transcript ready"
        case let .turnDone(status, reason):
            if status == "completed", !final.isEmpty {
                phase = .completed
                message = "Transcript ready"
            } else if status == "no_speech" {
                phase = .interrupted
                message = "No speech detected"
            } else if status != "completed" {
                phase = .interrupted
                message = reason?.isEmpty == false ? reason! : "Transcription interrupted"
            }
        case let .failure(error):
            phase = .failed
            message = error
        case .ignored:
            break
        }
    }
}
