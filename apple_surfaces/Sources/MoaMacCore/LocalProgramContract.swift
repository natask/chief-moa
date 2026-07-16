import CryptoKit
import Foundation

public enum LocalProgramLimits {
    public static let sourceBytes = 64 * 1024
    public static let outputBytes = 64 * 1024
    public static let logBytes = 32 * 1024
    public static let maxToolCalls = 100
    public static let maxDurationMilliseconds = 30_000
    public static let maxHandleLifetime: TimeInterval = 30
}

public enum LocalProgramError: Error, Equatable, Sendable {
    case invalidEnvelope, wrongDevice, expired, sourceTooLarge, outputTooLarge
    case toolBudgetExceeded, invalidInput, staleObservation, staleTarget
    case unknownHandle, unsupportedAction, approvalRequired, capabilityDenied
    case unsafeProgram, replayed
    case stopped, indeterminate
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
    public let sourceBytes: Int, wallMS: Int, toolCalls: Int
    public let memoryBytes: Int?
    public let parallelCalls: Int, resultBytes: Int, logBytes: Int
    public init(sourceBytes: Int, wallMS: Int, memoryBytes: Int?, toolCalls: Int,
                parallelCalls: Int, resultBytes: Int, logBytes: Int) {
        self.sourceBytes = sourceBytes; self.wallMS = wallMS; self.memoryBytes = memoryBytes
        self.toolCalls = toolCalls; self.parallelCalls = parallelCalls
        self.resultBytes = resultBytes; self.logBytes = logBytes
    }
    public static let localMaximum = Self(sourceBytes: LocalProgramLimits.sourceBytes,
        wallMS: LocalProgramLimits.maxDurationMilliseconds, memoryBytes: nil,
        toolCalls: LocalProgramLimits.maxToolCalls, parallelCalls: 1,
        resultBytes: LocalProgramLimits.outputBytes, logBytes: LocalProgramLimits.logBytes)
    enum CodingKeys: String, CodingKey {
        case sourceBytes = "source_bytes", wallMS = "wall_ms", memoryBytes = "memory_bytes"
        case toolCalls = "tool_calls", parallelCalls = "parallel_calls"
        case resultBytes = "result_bytes", logBytes = "log_bytes"
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(sourceBytes, forKey: .sourceBytes)
        try values.encode(wallMS, forKey: .wallMS)
        if let memoryBytes { try values.encode(memoryBytes, forKey: .memoryBytes) }
        else { try values.encodeNil(forKey: .memoryBytes) }
        try values.encode(toolCalls, forKey: .toolCalls)
        try values.encode(parallelCalls, forKey: .parallelCalls)
        try values.encode(resultBytes, forKey: .resultBytes)
        try values.encode(logBytes, forKey: .logBytes)
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

public struct MacCapabilitySchema: Codable, Equatable, Sendable {
    public let type: String
    public let required: [String]
    public let properties: [String: String]
    public let additionalProperties: Bool
    public init(type: String, required: [String], properties: [String: String], additionalProperties: Bool = false) {
        self.type = type; self.required = required; self.properties = properties
        self.additionalProperties = additionalProperties
    }
    enum CodingKeys: String, CodingKey {
        case type, required, properties; case additionalProperties = "additional_properties"
    }
}

public struct MacCapabilityDescriptor: Codable, Equatable, Sendable {
    public let capabilityID: String, description: String
    public let inputSchema: MacCapabilitySchema, outputSchema: MacCapabilitySchema
    public let effectClass: String, approvalClass: String, idempotency: String, concurrency: String
    public let restoreCapabilityID: String?
    public init(capabilityID: String, description: String, inputSchema: MacCapabilitySchema,
                outputSchema: MacCapabilitySchema, effectClass: String, approvalClass: String,
                idempotency: String, concurrency: String, restoreCapabilityID: String?) {
        self.capabilityID = capabilityID; self.description = description
        self.inputSchema = inputSchema; self.outputSchema = outputSchema
        self.effectClass = effectClass; self.approvalClass = approvalClass
        self.idempotency = idempotency; self.concurrency = concurrency
        self.restoreCapabilityID = restoreCapabilityID
    }
    enum CodingKeys: String, CodingKey {
        case description, idempotency, concurrency
        case capabilityID = "capability_id", inputSchema = "input_schema", outputSchema = "output_schema"
        case effectClass = "effect_class", approvalClass = "approval_class"
        case restoreCapabilityID = "restore_capability_id"
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(capabilityID, forKey: .capabilityID); try c.encode(description, forKey: .description)
        try c.encode(inputSchema, forKey: .inputSchema); try c.encode(outputSchema, forKey: .outputSchema)
        try c.encode(effectClass, forKey: .effectClass); try c.encode(approvalClass, forKey: .approvalClass)
        try c.encode(idempotency, forKey: .idempotency); try c.encode(concurrency, forKey: .concurrency)
        if let restoreCapabilityID { try c.encode(restoreCapabilityID, forKey: .restoreCapabilityID) }
        else { try c.encodeNil(forKey: .restoreCapabilityID) }
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

    public static let descriptors: [MacCapabilityDescriptor] = {
        let empty = MacCapabilitySchema(type: "object", required: [], properties: [:])
        let observation = MacCapabilitySchema(type: "object", required: ["application_name", "binding", "nodes", "window_title"],
            properties: ["binding": "object", "nodes": "array", "application_name": "string", "window_title": "string"])
        let find = MacCapabilitySchema(type: "object", required: [], properties: ["role": "string", "label": "string"])
        let actionProperties = ["action": "string", "handle": "string", "observation_id": "string"]
        let receiptKeys = ["version", "type", "receipt_id", "execution_id", "claimant", "tool_call_id",
            "attempt", "capability_id", "program_sha256", "catalog_sha256", "bindings_sha256",
            "input_sha256", "pre_state_sha256", "approval_id", "started_at", "finished_at", "status",
            "result", "post_state_sha256", "previous_receipt_sha256", "receipt_sha256"]
        let receipt = MacCapabilitySchema(type: "object", required: receiptKeys,
            properties: Dictionary(uniqueKeysWithValues: receiptKeys.map { ($0,
                ["version", "attempt"].contains($0) ? "integer" :
                ["claimant", "result"].contains($0) ? "object" : "string_or_null") }))
        func descriptor(_ id: String, _ description: String, _ input: MacCapabilitySchema,
                        _ output: MacCapabilitySchema, effect: String = "read",
                        approval: String = "none", idempotency: String = "read_only") -> MacCapabilityDescriptor {
            .init(capabilityID: id, description: description, inputSchema: input, outputSchema: output,
                effectClass: effect, approvalClass: approval, idempotency: idempotency,
                concurrency: "serialized_resource", restoreCapabilityID: nil)
        }
        let reads = [
            descriptor("macos.accessibility.observe", "Observe bounded state for the bound macOS window.", empty, observation),
            descriptor("macos.accessibility.find", "Find bounded nodes in the bound Accessibility snapshot.", find,
                .init(type: "array", required: [], properties: [:])),
            descriptor("macos.app.current", "Read the application identity already bound by the local grant.", empty,
                .init(type: "object", required: ["bundle_id", "name", "pid"], properties: ["bundle_id": "string", "name": "string", "pid": "integer"])),
            descriptor("macos.window.current", "Read the exact window already bound by the local grant.", empty,
                .init(type: "object", required: ["observation_id", "title", "window_id"], properties: ["observation_id": "string", "title": "string", "window_id": "string"])),
        ]
        let actions = ["cancel", "confirm", "decrement", "increment", "press", "set_value", "show_menu"].map { action in
            let requiresValue = action == "set_value"
            let input = MacCapabilitySchema(type: "object",
                required: ["action", "handle", "observation_id"] + (requiresValue ? ["value"] : []),
                properties: actionProperties.merging(requiresValue ? ["value": "string"] : [:]) { first, _ in first })
            return descriptor("macos.accessibility.\(action)", "Perform the reviewed \(action) operation on a bound Accessibility handle.",
                input, receipt,
                effect: "external_side_effect", approval: "explicit_confirm", idempotency: "non_idempotent")
        }
        return (reads + actions).sorted { $0.capabilityID < $1.capabilityID }
    }()
    public static let capabilityIDs = descriptors.map(\.capabilityID)

    public init(deviceID: String, advertisementID: String = "sra_local",
                issuedAt: Date = Date(), expiresAt: Date? = nil) {
        version = 1; type = "surface.runtime.advertised"; self.advertisementID = advertisementID
        target = .init(surfaceType: "macos", deviceID: deviceID)
        runtime = .init(runtimeID: "macos.javascriptcore-ax.v1", language: "javascript",
            bridgeVersion: 1, entrypoint: "main")
        let digest = MacLocalProgramDigest.catalog(version: 1, descriptors: Self.descriptors)
        catalog = .init(version: 1, sha256: digest, capabilityIDs: Self.capabilityIDs)
        limits = .localMaximum; self.issuedAt = issuedAt
        self.expiresAt = expiresAt ?? issuedAt.addingTimeInterval(5 * 60)
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
        public let kind: String, localGrantID: String, bundleID: String, processGeneration: String
        public let pid: Int32
        public let signingIdentity: String, windowID: String, axSnapshotID: String, stateSHA256: String
        public init(kind: String = "macos_accessibility", localGrantID: String, bundleID: String,
                    pid: Int32, processGeneration: String, signingIdentity: String,
                    windowID: String, axSnapshotID: String, stateSHA256: String) {
            self.kind = kind; self.localGrantID = localGrantID; self.bundleID = bundleID; self.pid = pid
            self.processGeneration = processGeneration; self.signingIdentity = signingIdentity
            self.windowID = windowID; self.axSnapshotID = axSnapshotID; self.stateSHA256 = stateSHA256
        }
        enum CodingKeys: String, CodingKey {
            case kind, pid; case localGrantID = "local_grant_id", bundleID = "bundle_id"
            case processGeneration = "process_generation", signingIdentity = "signing_identity"
            case windowID = "window_id", axSnapshotID = "ax_snapshot_id", stateSHA256 = "state_sha256"
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
        guard let canonical = try? MacCanonicalJSON.parse(data), case .object = canonical
        else { throw LocalProgramError.invalidEnvelope }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw LocalProgramError.invalidEnvelope }
        try require(root, ["version", "type", "execution_id", "session_id", "turn_id", "target", "runtime", "program", "catalog", "bindings", "limits", "approval_policy", "idempotency_key", "issued_at", "expires_at"])
        try object(root, "target", ["surface_type", "device_id"])
        try object(root, "runtime", ["runtime_id", "language", "bridge_version", "entrypoint"])
        try object(root, "program", ["source", "sha256"])
        try object(root, "catalog", ["version", "sha256", "allowed_capability_ids"])
        try object(root, "bindings", ["kind", "local_grant_id", "bundle_id", "pid", "process_generation", "signing_identity", "window_id", "ax_snapshot_id", "state_sha256"])
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
              advertisement.catalog.capabilityIDs == MacLocalProgramAdvertisement.capabilityIDs,
              advertisement.catalog.sha256 == MacLocalProgramDigest.catalog(version: advertisement.catalog.version,
                descriptors: MacLocalProgramAdvertisement.descriptors),
              catalog.allowedCapabilityIDs == catalog.allowedCapabilityIDs.sorted(),
              Set(catalog.allowedCapabilityIDs).count == catalog.allowedCapabilityIDs.count,
              Set(catalog.allowedCapabilityIDs).isSubset(of: allowed),
              bindings.kind == "macos_accessibility", Self.validDigest(bindings.stateSHA256),
              bindings.pid >= 1,
              !bindings.localGrantID.isEmpty, !bindings.bundleID.isEmpty,
              !bindings.processGeneration.isEmpty, !bindings.signingIdentity.isEmpty,
              !bindings.windowID.isEmpty, !bindings.axSnapshotID.isEmpty,
              ["preauthorized", "local_policy", "approval_required"].contains(approvalPolicy.program),
              approvalPolicy.alwaysAsk == approvalPolicy.alwaysAsk.sorted(),
              Set(approvalPolicy.alwaysAsk).count == approvalPolicy.alwaysAsk.count,
              Set(approvalPolicy.alwaysAsk).isSubset(of: ["read", "navigation", "local_mutation",
                "external_side_effect", "destructive", "security_sensitive", "financial", "publishing", "sending"]),
              limits.sourceBytes > 0, limits.sourceBytes <= advertisement.limits.sourceBytes,
              limits.wallMS > 0, limits.wallMS <= advertisement.limits.wallMS,
              limits.memoryBytes == advertisement.limits.memoryBytes,
              limits.toolCalls > 0, limits.toolCalls <= advertisement.limits.toolCalls,
              limits.parallelCalls == 1, limits.resultBytes > 0,
              limits.resultBytes <= advertisement.limits.resultBytes,
              limits.logBytes >= 0, limits.logBytes <= advertisement.limits.logBytes,
              expiresAt > issuedAt, expiresAt.timeIntervalSince(issuedAt) <= 5 * 60,
              expiresAt <= advertisement.expiresAt,
              now >= issuedAt.addingTimeInterval(-30), now < expiresAt,
              advertisement.expiresAt > advertisement.issuedAt,
              advertisement.expiresAt.timeIntervalSince(advertisement.issuedAt) <= 5 * 60,
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

public struct MacReceiptClaimant: Codable, Equatable, Sendable {
    public let surfaceType: String, deviceID: String, clientInstanceID: String
    public init(surfaceType: String = "macos", deviceID: String, clientInstanceID: String) {
        self.surfaceType = surfaceType; self.deviceID = deviceID; self.clientInstanceID = clientInstanceID
    }
    enum CodingKeys: String, CodingKey {
        case surfaceType = "surface_type", deviceID = "device_id", clientInstanceID = "client_instance_id"
    }
}

public struct MacToolReceiptResult: Codable, Equatable, Sendable {
    public let summary: String
    public let dataSHA256: String?
    public let resourceID: String?
    public init(summary: String, dataSHA256: String? = nil, resourceID: String? = nil) {
        self.summary = summary; self.dataSHA256 = dataSHA256; self.resourceID = resourceID
    }
    enum CodingKeys: String, CodingKey {
        case summary; case dataSHA256 = "data_sha256", resourceID = "resource_id"
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(summary, forKey: .summary)
        if let dataSHA256 { try c.encode(dataSHA256, forKey: .dataSHA256) } else { try c.encodeNil(forKey: .dataSHA256) }
        if let resourceID { try c.encode(resourceID, forKey: .resourceID) } else { try c.encodeNil(forKey: .resourceID) }
    }
}

public struct MacLocalActionReceipt: Codable, Equatable, Sendable {
    public let version: Int, type: String, receiptID: String, executionID: String
    public let claimant: MacReceiptClaimant
    public let toolCallID: String, attempt: Int, capabilityID: String
    public let programSHA256: String, catalogSHA256: String, bindingsSHA256: String
    public let inputSHA256: String, preStateSHA256: String, approvalID: String?
    public let startedAt: Date, finishedAt: Date, status: String
    public let result: MacToolReceiptResult
    public let postStateSHA256: String?, previousReceiptSHA256: String?, receiptSHA256: String

    enum CodingKeys: String, CodingKey {
        case version, type, claimant, attempt, status, result
        case receiptID = "receipt_id", executionID = "execution_id", toolCallID = "tool_call_id"
        case capabilityID = "capability_id", programSHA256 = "program_sha256"
        case catalogSHA256 = "catalog_sha256", bindingsSHA256 = "bindings_sha256"
        case inputSHA256 = "input_sha256", preStateSHA256 = "pre_state_sha256"
        case approvalID = "approval_id", startedAt = "started_at", finishedAt = "finished_at"
        case postStateSHA256 = "post_state_sha256", previousReceiptSHA256 = "previous_receipt_sha256"
        case receiptSHA256 = "receipt_sha256"
    }

    public static func make(receiptID: String, executionID: String, claimant: MacReceiptClaimant,
                            toolCallID: String, attempt: Int, capabilityID: String,
                            programSHA256: String, catalogSHA256: String, bindingsSHA256: String,
                            inputSHA256: String, preStateSHA256: String, approvalID: String? = nil,
                            startedAt: Date, finishedAt: Date, status: String,
                            result: MacToolReceiptResult, postStateSHA256: String? = nil,
                            previousReceiptSHA256: String?) -> Self {
        let material = HashMaterial(version: 1, type: "surface.execution.tool_receipt",
            receiptID: receiptID, executionID: executionID, claimant: claimant,
            toolCallID: toolCallID, attempt: attempt, capabilityID: capabilityID,
            programSHA256: programSHA256, catalogSHA256: catalogSHA256,
            bindingsSHA256: bindingsSHA256, inputSHA256: inputSHA256,
            preStateSHA256: preStateSHA256, approvalID: approvalID,
            startedAt: startedAt, finishedAt: finishedAt, status: status,
            result: result, postStateSHA256: postStateSHA256,
            previousReceiptSHA256: previousReceiptSHA256)
        return Self(material: material, receiptSHA256: MacLocalProgramDigest.canonical(material))
    }

    public var hasValidDigest: Bool {
        receiptSHA256 == MacLocalProgramDigest.canonical(HashMaterial(self))
    }

    private init(material: HashMaterial, receiptSHA256: String) {
        version = material.version; type = material.type; receiptID = material.receiptID
        executionID = material.executionID; claimant = material.claimant; toolCallID = material.toolCallID
        attempt = material.attempt; capabilityID = material.capabilityID
        programSHA256 = material.programSHA256; catalogSHA256 = material.catalogSHA256
        bindingsSHA256 = material.bindingsSHA256; inputSHA256 = material.inputSHA256
        preStateSHA256 = material.preStateSHA256; approvalID = material.approvalID
        startedAt = material.startedAt; finishedAt = material.finishedAt; status = material.status
        result = material.result; postStateSHA256 = material.postStateSHA256
        previousReceiptSHA256 = material.previousReceiptSHA256; self.receiptSHA256 = receiptSHA256
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version); try c.encode(type, forKey: .type)
        try c.encode(receiptID, forKey: .receiptID); try c.encode(executionID, forKey: .executionID)
        try c.encode(claimant, forKey: .claimant); try c.encode(toolCallID, forKey: .toolCallID)
        try c.encode(attempt, forKey: .attempt); try c.encode(capabilityID, forKey: .capabilityID)
        try c.encode(programSHA256, forKey: .programSHA256); try c.encode(catalogSHA256, forKey: .catalogSHA256)
        try c.encode(bindingsSHA256, forKey: .bindingsSHA256); try c.encode(inputSHA256, forKey: .inputSHA256)
        try c.encode(preStateSHA256, forKey: .preStateSHA256)
        if let approvalID { try c.encode(approvalID, forKey: .approvalID) } else { try c.encodeNil(forKey: .approvalID) }
        try c.encode(startedAt, forKey: .startedAt); try c.encode(finishedAt, forKey: .finishedAt)
        try c.encode(status, forKey: .status); try c.encode(result, forKey: .result)
        if let postStateSHA256 { try c.encode(postStateSHA256, forKey: .postStateSHA256) } else { try c.encodeNil(forKey: .postStateSHA256) }
        if let previousReceiptSHA256 { try c.encode(previousReceiptSHA256, forKey: .previousReceiptSHA256) } else { try c.encodeNil(forKey: .previousReceiptSHA256) }
        try c.encode(receiptSHA256, forKey: .receiptSHA256)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version); type = try c.decode(String.self, forKey: .type)
        receiptID = try c.decode(String.self, forKey: .receiptID); executionID = try c.decode(String.self, forKey: .executionID)
        claimant = try c.decode(MacReceiptClaimant.self, forKey: .claimant); toolCallID = try c.decode(String.self, forKey: .toolCallID)
        attempt = try c.decode(Int.self, forKey: .attempt); capabilityID = try c.decode(String.self, forKey: .capabilityID)
        programSHA256 = try c.decode(String.self, forKey: .programSHA256); catalogSHA256 = try c.decode(String.self, forKey: .catalogSHA256)
        bindingsSHA256 = try c.decode(String.self, forKey: .bindingsSHA256); inputSHA256 = try c.decode(String.self, forKey: .inputSHA256)
        preStateSHA256 = try c.decode(String.self, forKey: .preStateSHA256); approvalID = try c.decodeIfPresent(String.self, forKey: .approvalID)
        startedAt = try c.decode(Date.self, forKey: .startedAt); finishedAt = try c.decode(Date.self, forKey: .finishedAt)
        status = try c.decode(String.self, forKey: .status); result = try c.decode(MacToolReceiptResult.self, forKey: .result)
        postStateSHA256 = try c.decodeIfPresent(String.self, forKey: .postStateSHA256)
        previousReceiptSHA256 = try c.decodeIfPresent(String.self, forKey: .previousReceiptSHA256)
        receiptSHA256 = try c.decode(String.self, forKey: .receiptSHA256)
    }

    private struct HashMaterial: Encodable {
        let version: Int, type: String, receiptID: String, executionID: String
        let claimant: MacReceiptClaimant
        let toolCallID: String, attempt: Int, capabilityID: String
        let programSHA256: String, catalogSHA256: String, bindingsSHA256: String
        let inputSHA256: String, preStateSHA256: String, approvalID: String?
        let startedAt: Date, finishedAt: Date, status: String
        let result: MacToolReceiptResult
        let postStateSHA256: String?, previousReceiptSHA256: String?
        init(version: Int, type: String, receiptID: String, executionID: String,
             claimant: MacReceiptClaimant, toolCallID: String, attempt: Int,
             capabilityID: String, programSHA256: String, catalogSHA256: String,
             bindingsSHA256: String, inputSHA256: String, preStateSHA256: String,
             approvalID: String?, startedAt: Date, finishedAt: Date, status: String,
             result: MacToolReceiptResult, postStateSHA256: String?,
             previousReceiptSHA256: String?) {
            self.version = version; self.type = type; self.receiptID = receiptID
            self.executionID = executionID; self.claimant = claimant; self.toolCallID = toolCallID
            self.attempt = attempt; self.capabilityID = capabilityID
            self.programSHA256 = programSHA256; self.catalogSHA256 = catalogSHA256
            self.bindingsSHA256 = bindingsSHA256; self.inputSHA256 = inputSHA256
            self.preStateSHA256 = preStateSHA256; self.approvalID = approvalID
            self.startedAt = startedAt; self.finishedAt = finishedAt; self.status = status
            self.result = result; self.postStateSHA256 = postStateSHA256
            self.previousReceiptSHA256 = previousReceiptSHA256
        }
        init(_ receipt: MacLocalActionReceipt) {
            version = receipt.version; type = receipt.type; receiptID = receipt.receiptID
            executionID = receipt.executionID; claimant = receipt.claimant; toolCallID = receipt.toolCallID
            attempt = receipt.attempt; capabilityID = receipt.capabilityID
            programSHA256 = receipt.programSHA256; catalogSHA256 = receipt.catalogSHA256
            bindingsSHA256 = receipt.bindingsSHA256; inputSHA256 = receipt.inputSHA256
            preStateSHA256 = receipt.preStateSHA256; approvalID = receipt.approvalID
            startedAt = receipt.startedAt; finishedAt = receipt.finishedAt; status = receipt.status
            result = receipt.result; postStateSHA256 = receipt.postStateSHA256
            previousReceiptSHA256 = receipt.previousReceiptSHA256
        }
        enum CodingKeys: String, CodingKey {
            case version, type, claimant, attempt, status, result
            case receiptID = "receipt_id", executionID = "execution_id", toolCallID = "tool_call_id"
            case capabilityID = "capability_id", programSHA256 = "program_sha256"
            case catalogSHA256 = "catalog_sha256", bindingsSHA256 = "bindings_sha256"
            case inputSHA256 = "input_sha256", preStateSHA256 = "pre_state_sha256"
            case approvalID = "approval_id", startedAt = "started_at", finishedAt = "finished_at"
            case postStateSHA256 = "post_state_sha256", previousReceiptSHA256 = "previous_receipt_sha256"
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(version, forKey: .version); try c.encode(type, forKey: .type)
            try c.encode(receiptID, forKey: .receiptID); try c.encode(executionID, forKey: .executionID)
            try c.encode(claimant, forKey: .claimant); try c.encode(toolCallID, forKey: .toolCallID)
            try c.encode(attempt, forKey: .attempt); try c.encode(capabilityID, forKey: .capabilityID)
            try c.encode(programSHA256, forKey: .programSHA256); try c.encode(catalogSHA256, forKey: .catalogSHA256)
            try c.encode(bindingsSHA256, forKey: .bindingsSHA256); try c.encode(inputSHA256, forKey: .inputSHA256)
            try c.encode(preStateSHA256, forKey: .preStateSHA256)
            if let approvalID { try c.encode(approvalID, forKey: .approvalID) } else { try c.encodeNil(forKey: .approvalID) }
            try c.encode(startedAt, forKey: .startedAt); try c.encode(finishedAt, forKey: .finishedAt)
            try c.encode(status, forKey: .status); try c.encode(result, forKey: .result)
            if let postStateSHA256 { try c.encode(postStateSHA256, forKey: .postStateSHA256) } else { try c.encodeNil(forKey: .postStateSHA256) }
            if let previousReceiptSHA256 { try c.encode(previousReceiptSHA256, forKey: .previousReceiptSHA256) } else { try c.encodeNil(forKey: .previousReceiptSHA256) }
        }
    }
}

public struct MacAXActionOutcome: Equatable, Sendable {
    public let postStateSHA256: String?, resourceID: String?
    public init(postStateSHA256: String?, resourceID: String?) {
        self.postStateSHA256 = postStateSHA256; self.resourceID = resourceID
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
        canonical(value)
    }
    public static func axState(_ value: MacAXProgramObservation) -> String {
        struct Node: Encodable {
            let role: String, label: String?, enabled: Bool, focused: Bool, actions: [String]
        }
        struct State: Encodable {
            let bundleID: String, pid: Int32, processGeneration: String, windowID: String
            let nodes: [Node]
            enum CodingKeys: String, CodingKey {
                case pid, nodes; case bundleID = "bundle_id", processGeneration = "process_generation"
                case windowID = "window_id"
            }
        }
        return canonical(State(bundleID: value.binding.bundleID, pid: value.binding.pid,
            processGeneration: value.binding.processGeneration, windowID: value.binding.windowID,
            nodes: value.nodes.map { Node(role: $0.role, label: $0.label, enabled: $0.enabled,
                focused: $0.focused, actions: $0.actions) }))
    }
    public static func catalog(version: Int, descriptors: [MacCapabilityDescriptor]) -> String {
        struct Snapshot: Encodable { let version: Int; let capabilities: [MacCapabilityDescriptor] }
        return canonical(Snapshot(version: version,
            capabilities: descriptors.sorted { $0.capabilityID < $1.capabilityID }))
    }
    public static func canonical<T: Encodable>(_ value: T) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        let encoded = try! encoder.encode(value)
        return data(try! MacCanonicalJSON.parse(encoded).canonicalData)
    }
}

public protocol MacAccessibilityProgramAuthority: AnyObject, Sendable {
    func validate(bindings: MacLocalProgramEnvelope.Bindings, now: Date) throws
    func observe(now: Date) throws -> MacAXProgramObservation
    func perform(_ request: MacAXActionRequest, executionID: String, sequence: Int,
                 now: Date) throws -> MacAXActionOutcome
}
