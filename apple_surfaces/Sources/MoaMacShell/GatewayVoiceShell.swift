#if os(macOS)
@preconcurrency import AVFoundation
import Foundation
import MoaMacCore

public enum VoiceCaptureError: Error, Equatable, Sendable {
    case microphoneDenied
    case alreadyActive
    case notActive
    case invalidAudioFormat
    case connectionClosed
}

public protocol MicrophonePermissionRequesting: Sendable {
    func requestPermission() async -> Bool
}

public protocol PCM16MicrophoneCapturing: Sendable {
    func start(handler: @escaping @Sendable (Data) -> Void) throws
    func stop()
}

public protocol GatewayVoiceTransporting: Sendable {
    func connect(
        start: GatewayVoiceSessionStart,
        bearerToken: String,
        turnID: String,
        eventHandler: @escaping @MainActor @Sendable (GatewayVoiceServerEvent) -> Void
    ) async throws
    func sendAudio(_ data: Data) async throws
    func commit() async throws
    func cancel() async
}

public struct SystemMicrophonePermission: MicrophonePermissionRequesting {
    public init() {}

    public func requestPermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .audio)
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }
}

public final class AVAudioEnginePCM16Capture: PCM16MicrophoneCapturing, @unchecked Sendable {
    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?

    public init() {}

    public func start(handler: @escaping @Sendable (Data) -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        guard engine == nil else { throw VoiceCaptureError.alreadyActive }

        let nextEngine = AVAudioEngine()
        let input = nextEngine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let outputFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: 16_000,
                channels: 1,
                interleaved: true
              ),
              let nextConverter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw VoiceCaptureError.invalidAudioFormat
        }

        input.installTap(onBus: 0, bufferSize: 2_048, format: inputFormat) { buffer, _ in
            let ratio = outputFormat.sampleRate / inputFormat.sampleRate
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio)) + 1
            guard let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
            let supply = ConverterInputSupply(buffer: buffer)
            var conversionError: NSError?
            let status = nextConverter.convert(to: converted, error: &conversionError) { _, inputStatus in
                supply.next(inputStatus)
            }
            guard status != .error, conversionError == nil,
                  converted.frameLength > 0, let samples = converted.int16ChannelData?[0] else { return }
            handler(Data(bytes: samples, count: Int(converted.frameLength) * MemoryLayout<Int16>.size))
        }
        do {
            nextEngine.prepare()
            try nextEngine.start()
            engine = nextEngine
            converter = nextConverter
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
    }

    public func stop() {
        lock.lock()
        defer { lock.unlock() }
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        converter = nil
    }

    deinit { stop() }
}

private final class ConverterInputSupply: @unchecked Sendable {
    private let lock = NSLock()
    private let buffer: AVAudioPCMBuffer
    private var supplied = false

    init(buffer: AVAudioPCMBuffer) { self.buffer = buffer }

    func next(_ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        lock.withLock {
            guard !supplied else {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
    }
}

public actor URLSessionGatewayVoiceTransport: GatewayVoiceTransporting {
    private var webSocket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiver: Task<Void, Never>?
    private var turnID = ""
    private var eventHandler: (@MainActor @Sendable (GatewayVoiceServerEvent) -> Void)?

    public init() {}

    public func connect(
        start: GatewayVoiceSessionStart,
        bearerToken: String,
        turnID: String,
        eventHandler: @escaping @MainActor @Sendable (GatewayVoiceServerEvent) -> Void
    ) async throws {
        guard webSocket == nil else { throw VoiceCaptureError.alreadyActive }
        guard !bearerToken.isEmpty else { throw MoaMacError.missingToken }
        var request = URLRequest(url: start.endpoint)
        request.timeoutInterval = 30
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        let nextSession = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
        let task = nextSession.webSocketTask(with: request)
        self.session = nextSession
        webSocket = task
        self.turnID = turnID
        self.eventHandler = eventHandler
        task.resume()
        try await task.send(.string(String(decoding: start.body, as: UTF8.self)))
        receiver = Task { [weak self] in await self?.receiveEvents() }
    }

    public func sendAudio(_ data: Data) async throws {
        let frame = try GatewayVoiceAudioFrame(data)
        guard let webSocket else { throw VoiceCaptureError.notActive }
        try await webSocket.send(.data(frame.data))
    }

    public func commit() async throws {
        guard let webSocket else { throw VoiceCaptureError.notActive }
        let event = try GatewayVoiceClientEvent.commit(turnID: turnID)
        try await webSocket.send(.string(String(decoding: event, as: UTF8.self)))
    }

    public func cancel() async {
        if let webSocket, !turnID.isEmpty {
            if let event = try? GatewayVoiceClientEvent.cancel(turnID: turnID) {
                try? await webSocket.send(.string(String(decoding: event, as: UTF8.self)))
            }
        }
        close()
    }

    private func receiveEvents() async {
        guard let webSocket else { return }
        do {
            while !Task.isCancelled {
                let message = try await webSocket.receive()
                let data: Data
                switch message {
                case let .data(value): data = value
                case let .string(value): data = Data(value.utf8)
                @unknown default: continue
                }
                let event = try GatewayVoiceServerEventDecoder.decode(data)
                if event != .ignored, let eventHandler {
                    await eventHandler(event)
                }
                if case .turnDone = event { close(); return }
                if case .failure = event { close(); return }
            }
        } catch is CancellationError {
            close()
        } catch {
            if let eventHandler { await eventHandler(.failure("Voice connection was interrupted")) }
            close()
        }
    }

    private func close() {
        receiver?.cancel()
        receiver = nil
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
        session?.invalidateAndCancel()
        session = nil
        turnID = ""
        eventHandler = nil
    }
}

@MainActor public protocol VoiceCaptureControlling: AnyObject {
    func start(
        origin: URL,
        bearerToken: String,
        sessionID: String,
        turnID: String,
        levelHandler: @escaping @MainActor @Sendable (Double) -> Void,
        eventHandler: @escaping @MainActor @Sendable (GatewayVoiceServerEvent) -> Void
    ) async throws
    func stopAndCommit() async throws
    func cancel() async
}

@MainActor public final class VoiceCaptureController: VoiceCaptureControlling {
    private let permission: any MicrophonePermissionRequesting
    private let microphone: any PCM16MicrophoneCapturing
    private let transport: any GatewayVoiceTransporting
    private var active = false

    public convenience init() {
        self.init(
            permission: SystemMicrophonePermission(),
            microphone: AVAudioEnginePCM16Capture(),
            transport: URLSessionGatewayVoiceTransport()
        )
    }

    public init(
        permission: any MicrophonePermissionRequesting,
        microphone: any PCM16MicrophoneCapturing,
        transport: any GatewayVoiceTransporting
    ) {
        self.permission = permission
        self.microphone = microphone
        self.transport = transport
    }

    public func start(
        origin: URL,
        bearerToken: String,
        sessionID: String,
        turnID: String,
        levelHandler: @escaping @MainActor @Sendable (Double) -> Void,
        eventHandler: @escaping @MainActor @Sendable (GatewayVoiceServerEvent) -> Void
    ) async throws {
        guard !active else { throw VoiceCaptureError.alreadyActive }
        guard await permission.requestPermission() else { throw VoiceCaptureError.microphoneDenied }
        let start = try GatewayVoiceSessionStart(origin: origin, sessionID: sessionID, turnID: turnID)
        try await transport.connect(start: start, bearerToken: bearerToken, turnID: turnID, eventHandler: eventHandler)
        do {
            try microphone.start { [transport] data in
                let level = VoiceLevelMeter.normalizedLevel(forPCM16: data)
                Task { @MainActor in levelHandler(level) }
                Task { try? await transport.sendAudio(data) }
            }
            active = true
        } catch {
            await transport.cancel()
            throw error
        }
    }

    public func stopAndCommit() async throws {
        guard active else { throw VoiceCaptureError.notActive }
        microphone.stop()
        active = false
        try await transport.commit()
    }

    public func cancel() async {
        microphone.stop()
        active = false
        await transport.cancel()
    }
}
#endif
