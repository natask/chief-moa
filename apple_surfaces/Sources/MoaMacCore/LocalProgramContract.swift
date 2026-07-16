import CryptoKit
import Foundation

public enum LocalProgramLimits {
    public static let sourceBytes = 64 * 1024
    public static let outputBytes = 64 * 1024
    public static let logBytes = 32 * 1024
    public static let memoryBytes = 32 * 1024 * 1024
    public static let maxToolCalls = 100
    public static let maxDurationMilliseconds = 30_000
    public static let maxHandleLifetime: TimeInterval = 30
}

public enum LocalProgramError: Error, Equatable, Sendable {
    case invalidEnvelope, wrongDevice, expired, sourceTooLarge, outputTooLarge
    case toolBudgetExceeded, invalidInput, staleObservation, staleTarget
    case unknownHandle, unsupportedAction, approvalRequired, capabilityDenied
    case unsafeProgram, replayed
    case executionFailed(String)
}

public struct MacProgramTarget: Codable, Equatable, Sendable {
    public let surfaceType: String
    public let deviceID: String
    public init(surfaceType: String, deviceID: String) { self.surfaceType = surfaceType; self.deviceID = deviceID }
    enum CodingKeys: String, CodingKey { case surfaceType = "surface_type", deviceID = "device_id" }
}

public struct MacProgramRuntimeProfile: Codable, Equatable, Sendable {
    public let runtimeID: String
    public let language: String
    public let bridgeVersion: Int
    public let entrypoint: String
    public init(runtimeID: String, language: String, bridgeVersion: Int, entrypoint: String) {
        self.runtimeID = runtimeID; self.language = language
        self.bridgeVersion = bridgeVersion; self.entrypoint = entrypoint
    }
    enum CodingKeys: String, CodingKey {
        case language, entrypoint
        case runtimeID = "runtime_id", bridgeVersion = "bridge_version"
    }
}

public struct MacProgramLimits: Codable, Equatable, Sendable {
    public let sourceBytes: Int, wallMS: Int, memoryBytes: Int, toolCalls: Int
    public let parallelCalls: Int, resultBytes: Int, logBytes: Int
    public init(sourceBytes: Int, wallMS: Int, memoryBytes: Int, toolCalls: Int,
                parallelCalls: Int, resultBytes: Int, logBytes: Int) {
        self.sourceBytes = sourceBytes; self.wallMS = wallMS; self.memoryBytes = memoryBytes
        self.toolCalls = toolCalls; self.parallelCalls = parallelCalls
        self.resultBytes = resultBytes; self.logBytes = logBytes
    }
    public static let localMaximum = Self(sourceBytes: LocalProgramLimits.sourceBytes,
        wallMS: LocalProgramLimits.maxDurationMilliseconds, memoryBytes: LocalProgramLimits.memoryBytes,
        toolCalls: LocalProgramLimits.maxToolCalls, parallelCalls: 1,
        resultBytes: LocalProgramLimits.outputBytes, logBytes: LocalProgramLimits.logBytes)
    enum CodingKeys: String, CodingKey {
        case sourceBytes = "source_bytes", wallMS = "wall_ms", memoryBytes = "memory_bytes"
        case toolCalls = "tool_calls", parallelCalls = "parallel_calls"
        case resultBytes = "result_bytes", logBytes = "log_bytes"
    }
}

public struct MacProgramCatalog: Codable, Equatable, Sendable {
    public let version: Int
    public let sha256: String
    public let allowedCapabilityIDs: [String]
    public init(version: Int, sha256: String, allowedCapabilityIDs: [String]) {
        self.version = version; self.sha256 = sha256; self.allowedCapabilityIDs = allowedCapabilityIDs
    }
    enum CodingKeys: String, CodingKey {
        case version, sha256; case allowedCapabilityIDs = "allowed_capability_ids"
    }
}

public struct MacLocalProgramAdvertisement: Codable, Equatable, Sendable {
    public struct Catalog: Codable, Equatable, Sendable {
        public let version: Int, sha256: String
        public let capabilityIDs: [String]
        enum CodingKeys: String, CodingKey {
            case version, sha256; case capabilityIDs = "capability_ids"
        }
    }
    public let version: Int
    public let type: String
    public let advertisementID: String
    public let target: MacProgramTarget
    public let runtime: MacProgramRuntimeProfile
    public let catalog: Catalog
    public let limits: MacProgramLimits
    public let issuedAt: Date
    public let expiresAt: Date

    public static let capabilityIDs = [
        "macos.accessibility.observe", "macos.accessibility.find",
        "macos.accessibility.press", "macos.accessibility.confirm",
        "macos.accessibility.cancel", "macos.accessibility.increment",
        "macos.accessibility.decrement", "macos.accessibility.show_menu",
        "macos.accessibility.set_value", "macos.app.current", "macos.window.current",
    ]

    public init(deviceID: String, advertisementID: String = "sra_local",
                issuedAt: Date = Date(), expiresAt: Date? = nil) {
        version = 1; type = "surface.runtime.advertised"; self.advertisementID = advertisementID
        target = .init(surfaceType: "macos", deviceID: deviceID)
        runtime = .init(runtimeID: "macos.javascriptcore-ax.v1", language: "javascript",
            bridgeVersion: 1, entrypoint: "main")
        let digest = MacLocalProgramDigest.catalog(version: 1, capabilityIDs: Self.capabilityIDs)
        catalog = .init(version: 1, sha256: digest, capabilityIDs: Self.capabilityIDs)
        limits = .localMaximum; self.issuedAt = issuedAt
        self.expiresAt = expiresAt ?? issuedAt.addingTimeInterval(60)
    }
    enum CodingKeys: String, CodingKey {
        case version, type, target, runtime, catalog, limits
        case advertisementID = "advertisement_id", issuedAt = "issued_at", expiresAt = "expires_at"
    }
}

public struct MacLocalProgramEnvelope: Codable, Equatable, Sendable {
    public struct Program: Codable, Equatable, Sendable {
        public let source: String, sha256: String
        public init(source: String, sha256: String) { self.source = source; self.sha256 = sha256 }
    }
    public struct Bindings: Codable, Equatable, Sendable {
        public let kind: String, grantID: String, bundleID: String, processGeneration: String
        public let pid: Int32
        public let signingIdentity: String, windowID: String, observationID: String, stateSHA256: String
        public init(kind: String = "macos_accessibility", grantID: String, bundleID: String,
                    pid: Int32, processGeneration: String, signingIdentity: String,
                    windowID: String, observationID: String, stateSHA256: String) {
            self.kind = kind; self.grantID = grantID; self.bundleID = bundleID; self.pid = pid
            self.processGeneration = processGeneration; self.signingIdentity = signingIdentity
            self.windowID = windowID; self.observationID = observationID; self.stateSHA256 = stateSHA256
        }
        enum CodingKeys: String, CodingKey {
            case kind, pid; case grantID = "grant_id", bundleID = "bundle_id"
            case processGeneration = "process_generation", signingIdentity = "signing_identity"
            case windowID = "window_id", observationID = "observation_id", stateSHA256 = "state_sha256"
        }
    }
    public struct ApprovalPolicy: Codable, Equatable, Sendable {
        public let program: String, alwaysAsk: [String]
        public init(program: String, alwaysAsk: [String]) { self.program = program; self.alwaysAsk = alwaysAsk }
        enum CodingKeys: String, CodingKey { case program; case alwaysAsk = "always_ask" }
    }

    public let version: Int, type: String, executionID: String, sessionID: String, turnID: String
    public let target: MacProgramTarget
    public let runtime: MacProgramRuntimeProfile
    public let program: Program
    public let catalog: MacProgramCatalog
    public let bindings: Bindings
    public let limits: MacProgramLimits
    public let approvalPolicy: ApprovalPolicy
    public let idempotencyKey: String
    public let issuedAt: Date, expiresAt: Date

    public init(version: Int = 1, type: String = "surface.execution.proposed", executionID: String,
                sessionID: String, turnID: String, target: MacProgramTarget,
                runtime: MacProgramRuntimeProfile, program: Program, catalog: MacProgramCatalog,
                bindings: Bindings, limits: MacProgramLimits, approvalPolicy: ApprovalPolicy,
                idempotencyKey: String, issuedAt: Date, expiresAt: Date) {
        self.version = version; self.type = type; self.executionID = executionID
        self.sessionID = sessionID; self.turnID = turnID; self.target = target; self.runtime = runtime
        self.program = program; self.catalog = catalog; self.bindings = bindings; self.limits = limits
        self.approvalPolicy = approvalPolicy; self.idempotencyKey = idempotencyKey
        self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }
    enum CodingKeys: String, CodingKey {
        case version, type, target, runtime, program, catalog, bindings, limits
        case executionID = "execution_id", sessionID = "session_id", turnID = "turn_id"
        case approvalPolicy = "approval_policy", idempotencyKey = "idempotency_key"
        case issuedAt = "issued_at", expiresAt = "expires_at"
    }

    public static func sourceDigest(_ source: String) -> String { MacLocalProgramDigest.data(Data(source.utf8)) }

    public static func decodeStrict(_ data: Data) throws -> Self {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw LocalProgramError.invalidEnvelope }
        try require(root, ["version", "type", "execution_id", "session_id", "turn_id", "target", "runtime", "program", "catalog", "bindings", "limits", "approval_policy", "idempotency_key", "issued_at", "expires_at"])
        try object(root, "target", ["surface_type", "device_id"])
        try object(root, "runtime", ["runtime_id", "language", "bridge_version", "entrypoint"])
        try object(root, "program", ["source", "sha256"])
        try object(root, "catalog", ["version", "sha256", "allowed_capability_ids"])
        try object(root, "bindings", ["kind", "grant_id", "bundle_id", "pid", "process_generation", "signing_identity", "window_id", "observation_id", "state_sha256"])
        try object(root, "limits", ["source_bytes", "wall_ms", "memory_bytes", "tool_calls", "parallel_calls", "result_bytes", "log_bytes"])
        try object(root, "approval_policy", ["program", "always_ask"])
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        do { return try decoder.decode(Self.self, from: data) } catch { throw LocalProgramError.invalidEnvelope }
    }

    public func validate(advertisement: MacLocalProgramAdvertisement, now: Date) throws {
        let allowed = Set(advertisement.catalog.capabilityIDs)
        guard version == 1, type == "surface.execution.proposed",
              target == advertisement.target, runtime == advertisement.runtime,
              !executionID.isEmpty, !sessionID.isEmpty, !turnID.isEmpty, !idempotencyKey.isEmpty,
              executionID.utf8.count <= 160, sessionID.utf8.count <= 160,
              turnID.utf8.count <= 160, idempotencyKey.utf8.count <= 160,
              program.source.utf8.count <= limits.sourceBytes,
              program.source.utf8.count <= LocalProgramLimits.sourceBytes,
              Self.validDigest(program.sha256), program.sha256 == Self.sourceDigest(program.source),
              catalog.version == advertisement.catalog.version,
              catalog.sha256 == advertisement.catalog.sha256, Self.validDigest(catalog.sha256),
              !catalog.allowedCapabilityIDs.isEmpty,
              Set(catalog.allowedCapabilityIDs).count == catalog.allowedCapabilityIDs.count,
              Set(catalog.allowedCapabilityIDs).isSubset(of: allowed),
              bindings.kind == "macos_accessibility", Self.validDigest(bindings.stateSHA256),
              approvalPolicy.program == "exact_source",
              Set(approvalPolicy.alwaysAsk).isSubset(of: Set(catalog.allowedCapabilityIDs)),
              Set(catalog.allowedCapabilityIDs.filter {
                  $0.hasPrefix("macos.accessibility.") &&
                  $0 != "macos.accessibility.observe" && $0 != "macos.accessibility.find"
              }).isSubset(of: Set(approvalPolicy.alwaysAsk)),
              limits.sourceBytes > 0, limits.sourceBytes <= advertisement.limits.sourceBytes,
              limits.wallMS > 0, limits.wallMS <= advertisement.limits.wallMS,
              limits.memoryBytes > 0, limits.memoryBytes <= advertisement.limits.memoryBytes,
              limits.toolCalls > 0, limits.toolCalls <= advertisement.limits.toolCalls,
              limits.parallelCalls == 1, limits.resultBytes > 0,
              limits.resultBytes <= advertisement.limits.resultBytes,
              limits.logBytes >= 0, limits.logBytes <= advertisement.limits.logBytes,
              expiresAt > issuedAt, expiresAt.timeIntervalSince(issuedAt) <= 60,
              now >= issuedAt.addingTimeInterval(-30), now < expiresAt,
              now >= advertisement.issuedAt.addingTimeInterval(-30), now < advertisement.expiresAt
        else {
            if target.deviceID != advertisement.target.deviceID { throw LocalProgramError.wrongDevice }
            if now >= expiresAt || now >= advertisement.expiresAt { throw LocalProgramError.expired }
            if program.source.utf8.count > LocalProgramLimits.sourceBytes { throw LocalProgramError.sourceTooLarge }
            throw LocalProgramError.invalidEnvelope
        }
    }

    private static func object(_ root: [String: Any], _ key: String, _ keys: Set<String>) throws {
        guard let value = root[key] as? [String: Any] else { throw LocalProgramError.invalidEnvelope }
        try require(value, keys)
    }
    private static func require(_ value: [String: Any], _ keys: Set<String>) throws {
        guard Set(value.keys) == keys else { throw LocalProgramError.invalidEnvelope }
    }
    private static func validDigest(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }
}

public struct MacAXTargetBinding: Codable, Equatable, Sendable {
    public let bundleID: String, processGeneration: String, windowID: String, observationID: String
    public let pid: Int32
    public let observedAt: Date, expiresAt: Date
    public init(bundleID: String, pid: Int32, processGeneration: String, windowID: String,
                observationID: String, observedAt: Date, expiresAt: Date) {
        self.bundleID = bundleID; self.pid = pid; self.processGeneration = processGeneration
        self.windowID = windowID; self.observationID = observationID
        self.observedAt = observedAt; self.expiresAt = expiresAt
    }
    enum CodingKeys: String, CodingKey {
        case pid; case bundleID = "bundle_id", processGeneration = "process_generation"
        case windowID = "window_id", observationID = "observation_id"
        case observedAt = "observed_at", expiresAt = "expires_at"
    }
}

public struct MacAXProgramNode: Codable, Equatable, Sendable {
    public let handle: String, role: String, label: String?
    public let enabled: Bool, focused: Bool
    public let actions: [String]
    public init(handle: String, role: String, label: String?, enabled: Bool, focused: Bool, actions: [String]) {
        self.handle = handle; self.role = role; self.label = label
        self.enabled = enabled; self.focused = focused; self.actions = actions
    }
}

public struct MacAXProgramObservation: Codable, Equatable, Sendable {
    public let binding: MacAXTargetBinding
    public let applicationName: String, windowTitle: String
    public let nodes: [MacAXProgramNode]
    public init(binding: MacAXTargetBinding, applicationName: String, windowTitle: String, nodes: [MacAXProgramNode]) {
        self.binding = binding; self.applicationName = applicationName; self.windowTitle = windowTitle; self.nodes = nodes
    }
    enum CodingKeys: String, CodingKey {
        case binding, nodes; case applicationName = "application_name", windowTitle = "window_title"
    }
}

public struct MacAXActionRequest: Codable, Equatable, Sendable {
    public let action: String, handle: String, observationID: String, value: String?
    public init(action: String, handle: String, observationID: String, value: String? = nil) {
        self.action = action; self.handle = handle; self.observationID = observationID; self.value = value
    }
    enum CodingKeys: String, CodingKey { case action, handle, value; case observationID = "observation_id" }
}

public struct MacLocalActionReceipt: Codable, Equatable, Sendable {
    public let receiptID: String, executionID: String, capabilityID: String
    public let sequence: Int
    public let inputSHA256: String, preStateSHA256: String, postStateSHA256: String?, targetDigest: String
    public let status: String, summary: String
    public let startedAt: Date, finishedAt: Date
    public init(receiptID: String, executionID: String, capabilityID: String, sequence: Int,
                inputSHA256: String, preStateSHA256: String, postStateSHA256: String?,
                targetDigest: String, status: String, summary: String,
                startedAt: Date, finishedAt: Date) {
        self.receiptID = receiptID; self.executionID = executionID; self.capabilityID = capabilityID
        self.sequence = sequence; self.inputSHA256 = inputSHA256; self.preStateSHA256 = preStateSHA256
        self.postStateSHA256 = postStateSHA256; self.targetDigest = targetDigest
        self.status = status; self.summary = summary; self.startedAt = startedAt; self.finishedAt = finishedAt
    }
    enum CodingKeys: String, CodingKey {
        case sequence, status, summary; case receiptID = "receipt_id", executionID = "execution_id"
        case capabilityID = "capability_id", inputSHA256 = "input_sha256"
        case preStateSHA256 = "pre_state_sha256", postStateSHA256 = "post_state_sha256"
        case targetDigest = "target_digest", startedAt = "started_at", finishedAt = "finished_at"
    }
}

public struct MacLocalProgramResult: Codable, Equatable, Sendable {
    public let executionID: String, sessionID: String, turnID: String
    public let claimantSurfaceType: String, claimantDeviceID: String, runtimeID: String
    public let status: String, resultJSON: String?, error: String?
    public let toolCalls: Int
    public let receipts: [MacLocalActionReceipt]
    public let programSHA256: String, catalogSHA256: String, bindingsSHA256: String
    public let startedAt: Date?, finishedAt: Date
    public init(executionID: String, sessionID: String, turnID: String,
                claimantSurfaceType: String = "macos", claimantDeviceID: String, runtimeID: String,
                status: String, resultJSON: String?, error: String?, toolCalls: Int,
                receipts: [MacLocalActionReceipt], programSHA256: String, catalogSHA256: String,
                bindingsSHA256: String, startedAt: Date?, finishedAt: Date) {
        self.executionID = executionID; self.sessionID = sessionID; self.turnID = turnID
        self.claimantSurfaceType = claimantSurfaceType; self.claimantDeviceID = claimantDeviceID
        self.runtimeID = runtimeID; self.status = status; self.resultJSON = resultJSON; self.error = error
        self.toolCalls = toolCalls; self.receipts = receipts; self.programSHA256 = programSHA256
        self.catalogSHA256 = catalogSHA256; self.bindingsSHA256 = bindingsSHA256
        self.startedAt = startedAt; self.finishedAt = finishedAt
    }
    enum CodingKeys: String, CodingKey {
        case status, error, receipts; case executionID = "execution_id", sessionID = "session_id", turnID = "turn_id"
        case claimantSurfaceType = "claimant_surface_type", claimantDeviceID = "claimant_device_id"
        case runtimeID = "runtime_id", resultJSON = "result_json", toolCalls = "tool_calls"
        case programSHA256 = "program_sha256", catalogSHA256 = "catalog_sha256"
        case bindingsSHA256 = "bindings_sha256", startedAt = "started_at", finishedAt = "finished_at"
    }
}

public enum MacLocalProgramDigest {
    public static func data(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    public static func bindings(_ value: MacLocalProgramEnvelope.Bindings) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        // Bindings contain only finite Codable primitives, so encoding failure
        // is not representable after construction.
        return data(try! encoder.encode(value))
    }
    public static func catalog(version: Int, capabilityIDs: [String]) -> String {
        let value: [String: Any] = ["version": version, "capability_ids": capabilityIDs.sorted()]
        return data(try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    }
}

public protocol MacAccessibilityProgramAuthority: AnyObject, Sendable {
    func validate(bindings: MacLocalProgramEnvelope.Bindings, now: Date) throws
    func observe(now: Date) throws -> MacAXProgramObservation
    func perform(_ request: MacAXActionRequest, executionID: String, sequence: Int,
                 now: Date) throws -> MacLocalActionReceipt
}
