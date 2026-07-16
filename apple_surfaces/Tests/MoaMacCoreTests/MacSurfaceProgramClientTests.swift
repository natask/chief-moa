#if os(macOS)
import Foundation
import MoaMacCore
@testable import MoaMacShell
import Testing

private let clientFixtureNow = Date(timeIntervalSince1970: 1_800_100_000)

private actor FakeSurfaceProgramTransport: MacSurfaceProgramTransporting {
    private var claimValue: MacClaimedSurfaceProgram?
    private var calls: [String] = []

    func setClaim(_ claim: MacClaimedSurfaceProgram?) { claimValue = claim }
    func recordedCalls() -> [String] { calls }

    func heartbeat(body: Data) async throws {
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(object["device_id"] as? String == "mac-client-fixture")
        #expect(object["client_instance_id"] as? String == "client-instance-fixture")
        #expect((object["execution_runtimes"] as? [[String: Any]])?.count == 1)
        #expect((object["local_tool_manifest"] as? [[String: Any]])?.count ==
            MacLocalProgramAdvertisement.descriptors.count)
        calls.append("heartbeat")
    }

    func claim(body: Data) async throws -> MacClaimedSurfaceProgram? {
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(object.keys) == ["client_instance_id", "device_id"])
        calls.append("claim")
        return claimValue
    }

    func upload(_ destination: MacSurfaceProgramUpload, body: Data) async throws {
        switch destination {
        case .event:
            let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            calls.append("event:\(try #require(object["kind"] as? String))")
        case .toolReceipt:
            _ = try MacCanonicalJSON.parse(body)
            calls.append("tool_receipt")
        case .terminalReceipt:
            _ = try MacCanonicalJSON.parse(body)
            calls.append("terminal_receipt")
        }
    }
}

private final class ClientRuntimeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: JavaScriptCoreMacProgramRuntime?
    func set(_ runtime: JavaScriptCoreMacProgramRuntime) { lock.withLock { value = runtime } }
    func get() -> JavaScriptCoreMacProgramRuntime? { lock.withLock { value } }
}

private final class ClientFakeAuthority: MacAccessibilityProgramAuthority, @unchecked Sendable {
    let observation = MacAXProgramObservation(binding: .init(bundleID: "com.example.client-fixture",
        pid: 77, processGeneration: "generation-client", windowID: "window-client",
        observationID: "observation-client", observedAt: clientFixtureNow,
        expiresAt: clientFixtureNow.addingTimeInterval(30)),
        applicationName: "Client Fixture", windowTitle: "Client Window",
        nodes: [.init(handle: "node-client", role: "AXButton", label: "Run",
            enabled: true, focused: true, actions: ["press"])])

    func validate(bindings: MacLocalProgramEnvelope.Bindings, now: Date) throws {
        guard bindings.bundleID == observation.binding.bundleID,
              bindings.pid == observation.binding.pid,
              bindings.processGeneration == observation.binding.processGeneration,
              bindings.windowID == observation.binding.windowID,
              bindings.axSnapshotID == observation.binding.observationID else {
            throw LocalProgramError.staleTarget
        }
    }
    func observe(now: Date) throws -> MacAXProgramObservation { observation }
    func perform(_ request: MacAXActionRequest, executionID: String,
                 sequence: Int, now: Date) throws -> MacAXActionOutcome {
        guard request.action == "press", request.handle == "node-client",
              request.observationID == "observation-client" else {
            throw LocalProgramError.unknownHandle
        }
        return .init(postStateSHA256: String(repeating: "c", count: 64),
            resourceID: "ax_client_fixture")
    }
}

private struct ClientApprover: MacProgramApprovalAuthorizing {
    func resolve(approvalID: String, effectClass: String, capabilityID: String,
                 executionID: String, expiresAt: Date) -> MacProgramApprovalDecision {
        .init(approvalID: approvalID, status: "approved")
    }
}

private func clientEnvelope(advertisement: MacLocalProgramAdvertisement) -> MacLocalProgramEnvelope {
    let source = #"async function main({tools}) { return await tools.macos.accessibility.press({handle:"node-client", observation_id:"observation-client"}); }"#
    return MacLocalProgramEnvelope(executionID: "execution-client", sessionID: "session-client",
        turnID: "turn-client", target: advertisement.target, runtime: advertisement.runtime,
        program: .init(source: source, sha256: MacLocalProgramEnvelope.sourceDigest(source)),
        catalog: .init(version: advertisement.catalog.version, sha256: advertisement.catalog.sha256,
            allowedCapabilityIDs: ["macos.accessibility.press"]),
        bindings: .init(localGrantID: "grant-client", bundleID: "com.example.client-fixture",
            pid: 77, processGeneration: "generation-client", signingIdentity: "fixture-signing",
            windowID: "window-client", axSnapshotID: "observation-client",
            stateSHA256: String(repeating: "a", count: 64)),
        limits: .init(sourceBytes: 65_536, wallMS: 5_000, memoryBytes: nil,
            toolCalls: 20, parallelCalls: 1, resultBytes: 65_536, logBytes: 0),
        approvalPolicy: .init(program: "preauthorized", alwaysAsk: ["external_side_effect"]),
        idempotencyKey: "idempotency-client", issuedAt: clientFixtureNow.addingTimeInterval(-1),
        expiresAt: clientFixtureNow.addingTimeInterval(30))
}

private func makeClient(transport: FakeSurfaceProgramTransport,
                        box: ClientRuntimeBox) -> MacSurfaceProgramClient {
    MacSurfaceProgramClient(transport: transport, runtimeFactory: { grant in
        let journal = try AtomicFileMacProgramJournal(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("moa-surface-client-\(UUID().uuidString).json"))
        let runtime = JavaScriptCoreMacProgramRuntime(deviceID: grant.deviceID,
            authority: ClientFakeAuthority(), clientInstanceID: grant.clientInstanceID,
            journal: journal, approvalAuthorizer: ClientApprover(), now: { clientFixtureNow })
        box.set(runtime)
        return runtime
    }, proposalAuthorizer: { $0.program.sha256 })
}

@Test func surfaceProgramClientMakesNoTransportCallsWithoutExplicitGrant() async throws {
    let transport = FakeSurfaceProgramTransport()
    let client = makeClient(transport: transport, box: ClientRuntimeBox())
    #expect(try await client.receiveAndRunOne() == .noGrant)
    #expect(await transport.recordedCalls().isEmpty)
}

@Test func surfaceProgramClientAdvertisesClaimsExecutesAndDrainsInGatewayOrder() async throws {
    let transport = FakeSurfaceProgramTransport(), box = ClientRuntimeBox()
    let client = makeClient(transport: transport, box: box)
    try await client.start(grant: .init(grantID: "grant-client",
        deviceID: "mac-client-fixture", clientInstanceID: "client-instance-fixture"))
    let runtime = try #require(box.get())
    let envelope = clientEnvelope(advertisement: runtime.advertisement)
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = MacProtocolTimestamp.encodingStrategy
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    await transport.setClaim(.init(requestID: "request-client",
        envelopeData: try encoder.encode(envelope)))

    #expect(try await client.receiveAndRunOne() ==
        .executed(executionID: "execution-client", status: "completed"))
    let calls = await transport.recordedCalls()
    #expect(calls == [
        "heartbeat", "claim", "event:accepted", "event:started", "event:tool_started",
        "event:approval_required", "event:approval_resolved", "tool_receipt",
        "event:tool_finished", "terminal_receipt", "event:terminal",
    ])
    #expect(try runtime.toolReceipts(executionID: envelope.executionID).count == 1)
    #expect(try runtime.terminalReceipt(executionID: envelope.executionID)?.status == "completed")
}
#endif
