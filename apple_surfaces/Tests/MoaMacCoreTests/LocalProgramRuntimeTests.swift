#if os(macOS)
import Foundation
import MoaMacCore
@testable import MoaMacShell
import Testing

private final class FakeMacProgramAuthority: MacAccessibilityProgramAuthority, @unchecked Sendable {
    var validated = 0
    var observations = 0
    var actions = 0
    var validationError: (any Error)?
    var observationError: (any Error)?
    var actionError: (any Error)?
    let observation: MacAXProgramObservation

    init(now: Date) {
        observation = .init(binding: .init(bundleID: "com.example.fixture", pid: 42,
            processGeneration: "generation-1", windowID: "window-1", observationID: "obs-1",
            observedAt: now, expiresAt: now.addingTimeInterval(30)),
            applicationName: "Fixture App", windowTitle: "Fixture Window",
            nodes: [.init(handle: "node-1", role: "AXButton", label: "Continue",
                enabled: true, focused: false, actions: ["press"])])
    }

    func validate(bindings: MacLocalProgramEnvelope.Bindings, now: Date) throws {
        validated += 1
        if let validationError { throw validationError }
        guard bindings.bundleID == observation.binding.bundleID,
              bindings.pid == observation.binding.pid,
              bindings.processGeneration == observation.binding.processGeneration,
              bindings.windowID == observation.binding.windowID,
              bindings.observationID == observation.binding.observationID
        else { throw LocalProgramError.staleTarget }
    }

    func observe(now: Date) throws -> MacAXProgramObservation {
        observations += 1
        if let observationError { throw observationError }
        return observation
    }

    func perform(_ request: MacAXActionRequest, executionID: String,
                 sequence: Int, now: Date) throws -> MacLocalActionReceipt {
        actions += 1
        if let actionError { throw actionError }
        guard request.handle == "node-1", request.observationID == "obs-1",
              request.action == "press" else { throw LocalProgramError.unknownHandle }
        let digest = MacLocalProgramDigest.data(Data("fixture-target".utf8))
        return .init(receiptID: "tool-fixture", executionID: executionID,
            capabilityID: "macos.accessibility.press", sequence: sequence,
            inputSHA256: MacLocalProgramDigest.data(Data("input".utf8)),
            preStateSHA256: String(repeating: "a", count: 64), postStateSHA256: nil,
            targetDigest: digest, status: "succeeded", summary: "fixture action executed",
            startedAt: now, finishedAt: now)
    }
}

private struct FixtureFailure: Error {}

private let fixtureNow = Date(timeIntervalSince1970: 1_800_000_000)

private func makeRuntime(source: String,
                         capabilities: [String] = MacLocalProgramAdvertisement.capabilityIDs,
                         limits: MacProgramLimits = .init(sourceBytes: 65_536, wallMS: 5_000,
                            memoryBytes: 16_777_216, toolCalls: 20, parallelCalls: 1,
                            resultBytes: 65_536, logBytes: 0),
                         authority: FakeMacProgramAuthority? = nil,
                         deviceID: String = "mac-fixture") -> (JavaScriptCoreMacProgramRuntime, MacLocalProgramEnvelope, FakeMacProgramAuthority) {
    let fake = authority ?? FakeMacProgramAuthority(now: fixtureNow)
    let runtime = JavaScriptCoreMacProgramRuntime(deviceID: deviceID, authority: fake, now: { fixtureNow })
    let ad = runtime.advertisement
    let envelope = MacLocalProgramEnvelope(executionID: "exec-fixture", sessionID: "session-fixture",
        turnID: "turn-fixture", target: ad.target, runtime: ad.runtime,
        program: .init(source: source, sha256: MacLocalProgramEnvelope.sourceDigest(source)),
        catalog: .init(version: ad.catalog.version, sha256: ad.catalog.sha256,
            allowedCapabilityIDs: capabilities),
        bindings: .init(grantID: "grant-fixture", bundleID: "com.example.fixture", pid: 42,
            processGeneration: "generation-1", signingIdentity: "fixture-signing",
            windowID: "window-1", observationID: "obs-1", stateSHA256: String(repeating: "a", count: 64)),
        limits: limits, approvalPolicy: .init(program: "exact_source",
            alwaysAsk: capabilities.filter { $0.hasPrefix("macos.accessibility.") && !$0.hasSuffix("observe") && !$0.hasSuffix("find") }),
        idempotencyKey: "idem-fixture", issuedAt: fixtureNow.addingTimeInterval(-1),
        expiresAt: fixtureNow.addingTimeInterval(30))
    return (runtime, envelope, fake)
}

@Test func macAdvertisementMatchesNormativeProfileAndExcludesBroaderProfiles() {
    let (runtime, _, _) = makeRuntime(source: "return 1;")
    let ad = runtime.advertisement
    #expect(ad.type == "surface.runtime.advertised")
    #expect(ad.target.surfaceType == "macos")
    #expect(ad.runtime.runtimeID == "macos.javascriptcore-ax.v1")
    #expect(ad.runtime.bridgeVersion == 1)
    #expect(ad.runtime.entrypoint == "main")
    #expect(!ad.catalog.capabilityIDs.contains(where: { $0.contains("shell") || $0.contains("jxa") || $0.contains("applescript") }))
    #expect(ad.catalog.sha256.count == 64)
    let fake = FakeMacProgramAuthority(now: fixtureNow)
    #expect(JavaScriptCoreMacProgramRuntime(deviceID: "default-clock", authority: fake).advertisement.target.deviceID == "default-clock")
    #expect(MacAXActionRequest(action: "press", handle: "node", observationID: "obs").value == nil)
}

@Test func strictEnvelopeRoundTripsAndRejectsUnknownFields() throws {
    let (_, envelope, _) = makeRuntime(source: "return 1;")
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
    let data = try encoder.encode(envelope)
    #expect(try MacLocalProgramEnvelope.decodeStrict(data) == envelope)
    var json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    json["unknown"] = true
    #expect(throws: LocalProgramError.invalidEnvelope) {
        try MacLocalProgramEnvelope.decodeStrict(JSONSerialization.data(withJSONObject: json))
    }
    var target = try #require(json["target"] as? [String: Any]); json.removeValue(forKey: "unknown")
    target["extra"] = "denied"; json["target"] = target
    #expect(throws: LocalProgramError.invalidEnvelope) {
        try MacLocalProgramEnvelope.decodeStrict(JSONSerialization.data(withJSONObject: json))
    }
    #expect(throws: LocalProgramError.invalidEnvelope) {
        try MacLocalProgramEnvelope.decodeStrict(Data("[]".utf8))
    }
    #expect(throws: LocalProgramError.invalidEnvelope) {
        try MacLocalProgramEnvelope.decodeStrict(Data(#"{"version":1}"#.utf8))
    }
    var malformed = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    malformed["version"] = "wrong-type"
    #expect(throws: LocalProgramError.invalidEnvelope) {
        try MacLocalProgramEnvelope.decodeStrict(JSONSerialization.data(withJSONObject: malformed))
    }
}

@Test func localProgramBranchesAcrossMultipleLocalCallsAndReceiptsEveryAttempt() {
    let source = #"""
    const app = tools.macos.app.current();
    const matches = tools.macos.accessibility.find({role:"AXButton", label:"Continue"});
    if (matches.length === 1) {
      const receipt = tools.macos.accessibility.press({handle:matches[0].handle, observation_id:"obs-1"});
      return {app:app.name, status:receipt.status};
    }
    return {app:app.name, status:"not_found"};
    """#
    let (runtime, envelope, fake) = makeRuntime(source: source)
    let result = runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(result.status == "completed")
    #expect(result.resultJSON == #"{"app":"Fixture App","status":"succeeded"}"#)
    #expect(result.toolCalls == 3)
    #expect(result.receipts.count == 3)
    #expect(fake.observations == 2)
    #expect(fake.actions == 1)
    #expect(result.programSHA256 == envelope.program.sha256)
    #expect(result.catalogSHA256 == envelope.catalog.sha256)
    #expect(result.bindingsSHA256 == MacLocalProgramDigest.bindings(envelope.bindings))
}

@Test func freshContextHasOnlyBoundedBridgeAndDoesNotPersistGlobals() {
    let source = #"return {fetch:typeof fetch, process:typeof process, fn:typeof Function, promise:typeof Promise, shell:typeof tools.macos.shell, marker:typeof marker};"#
    let (runtime, envelope, _) = makeRuntime(source: source)
    let first = runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(first.resultJSON?.contains(#""fetch":"undefined""#) == true)
    #expect(first.resultJSON?.contains(#""shell":"undefined""#) == true)

    let source2 = "globalThis.marker = 7; return marker;"
    let (_, setEnvelope, _) = makeRuntime(source: source2)
    #expect(runtime.execute(setEnvelope, approvedProgramSHA256: setEnvelope.program.sha256).resultJSON == "7")
    let (_, checkEnvelope, _) = makeRuntime(source: "return typeof marker;")
    #expect(runtime.execute(checkEnvelope, approvedProgramSHA256: checkEnvelope.program.sha256).resultJSON == #""undefined""#)
}

@Test func windowReadAndEverySemanticAdapterRemainInsideTheClosedBridge() {
    let source = #"return tools.macos.window.current();"#
    let (runtime, envelope, fake) = makeRuntime(source: source,
        capabilities: ["macos.window.current"])
    let result = runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(result.status == "completed")
    #expect(result.resultJSON?.contains(#""window_id":"window-1""#) == true)
    #expect(fake.observations == 1)
    #expect(result.receipts.first?.capabilityID == "macos.window.current")
}

@Test func hostFailuresJavaScriptExceptionsAndFailureContinuationAreTerminal() {
    let fake = FakeMacProgramAuthority(now: fixtureNow)
    fake.actionError = LocalProgramError.staleObservation
    let source = #"return tools.macos.accessibility.press({handle:"node-1", observation_id:"obs-1"});"#
    let (runtime, envelope, _) = makeRuntime(source: source, authority: fake)
    let stale = runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(stale.error == "staleObservation")
    #expect(stale.receipts.first?.status == "stale_state")

    let nonLocal = FakeMacProgramAuthority(now: fixtureNow)
    nonLocal.observationError = FixtureFailure()
    let (failedRuntime, failedEnvelope, _) = makeRuntime(
        source: "return tools.macos.accessibility.observe();", authority: nonLocal)
    let failed = failedRuntime.execute(failedEnvelope, approvedProgramSHA256: failedEnvelope.program.sha256)
    #expect(failed.error == #"executionFailed("host operation failed")"#)

    let (_, syntax, _) = makeRuntime(source: "return );")
    #expect(runtime.execute(syntax, approvedProgramSHA256: syntax.program.sha256).error?.contains("SyntaxError") == true)

    let continuationSource = #"try { tools.macos.accessibility.find({unexpected:true}); } catch (error) {} return tools.macos.accessibility.observe();"#
    let (_, continuation, _) = makeRuntime(source: continuationSource)
    let stopped = runtime.execute(continuation, approvedProgramSHA256: continuation.program.sha256)
    #expect(stopped.error == "invalidInput")
    #expect(stopped.receipts.count == 2)
}

@Test func deniedCapabilityAndToolBudgetFailClosedWithAttemptReceipts() {
    let (runtime, envelope, fake) = makeRuntime(source: "return tools.macos.app.current();",
        capabilities: ["macos.accessibility.observe"])
    let denied = runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(denied.status == "failed")
    #expect(denied.error == "capabilityDenied")
    #expect(denied.receipts.count == 1)
    #expect(denied.receipts[0].status == "rejected")
    #expect(fake.observations == 0)

    let tiny = MacProgramLimits(sourceBytes: 65_536, wallMS: 5_000,
        memoryBytes: 16_777_216, toolCalls: 1, parallelCalls: 1,
        resultBytes: 65_536, logBytes: 0)
    let (budgetRuntime, budgetEnvelope, _) = makeRuntime(
        source: "tools.macos.accessibility.observe(); return tools.macos.accessibility.observe();",
        capabilities: ["macos.accessibility.observe"], limits: tiny)
    let exhausted = budgetRuntime.execute(budgetEnvelope, approvedProgramSHA256: budgetEnvelope.program.sha256)
    #expect(exhausted.error == "toolBudgetExceeded")
    #expect(exhausted.toolCalls == 2)
    #expect(exhausted.receipts.count == 2)
}

@Test func bridgeRejectsMalformedDirectCallsWithoutTouchingAccessibility() {
    let fake = FakeMacProgramAuthority(now: fixtureNow)
    let allowed = Set(MacLocalProgramAdvertisement.capabilityIDs)
    let bridge = MacProgramBridge(authority: fake, executionID: "exec-direct",
        allowed: allowed, maximumCalls: 20, deadline: fixtureNow.addingTimeInterval(10),
        preStateSHA256: String(repeating: "a", count: 64), now: { fixtureNow })
    #expect(bridge.call("macos.accessibility.observe", #"{"extra":true}"#).contains("invalidInput"))

    let appBridge = MacProgramBridge(authority: fake, executionID: "exec-app",
        allowed: allowed, maximumCalls: 20, deadline: fixtureNow.addingTimeInterval(10),
        preStateSHA256: String(repeating: "a", count: 64), now: { fixtureNow })
    #expect(appBridge.call("macos.app.current", #"{"extra":true}"#).contains("invalidInput"))

    let windowBridge = MacProgramBridge(authority: fake, executionID: "exec-window",
        allowed: allowed, maximumCalls: 20, deadline: fixtureNow.addingTimeInterval(10),
        preStateSHA256: String(repeating: "a", count: 64), now: { fixtureNow })
    #expect(windowBridge.call("macos.window.current", #"{"extra":true}"#).contains("invalidInput"))

    let malformedBridge = MacProgramBridge(authority: fake, executionID: "exec-json",
        allowed: allowed, maximumCalls: 20, deadline: fixtureNow.addingTimeInterval(10),
        preStateSHA256: String(repeating: "a", count: 64), now: { fixtureNow })
    #expect(malformedBridge.call("macos.accessibility.observe", "not-json").contains("invalidInput"))

    let mismatchBridge = MacProgramBridge(authority: fake, executionID: "exec-mismatch",
        allowed: allowed, maximumCalls: 20, deadline: fixtureNow.addingTimeInterval(10),
        preStateSHA256: String(repeating: "a", count: 64), now: { fixtureNow })
    let mismatch = #"{"action":"cancel","handle":"node-1","observation_id":"obs-1"}"#
    #expect(mismatchBridge.call("macos.accessibility.press", mismatch).contains("invalidInput"))

    let expiredBridge = MacProgramBridge(authority: fake, executionID: "exec-expired",
        allowed: allowed, maximumCalls: 20, deadline: fixtureNow,
        preStateSHA256: String(repeating: "a", count: 64), now: { fixtureNow })
    #expect(expiredBridge.call("macos.accessibility.observe", "{}").contains("expired"))
    #expect(expiredBridge.receipts.first?.status == "timed_out")
    #expect(fake.observations == 0)
}

@Test func approvalUnsafeSourceSchemaAndStaleAuthorityAreRejected() {
    let (runtime, envelope, fake) = makeRuntime(source: "return 1;")
    #expect(runtime.execute(envelope, approvedProgramSHA256: String(repeating: "0", count: 64)).error == "approvalRequired")
    #expect(fake.validated == 0)

    let (_, unsafe, _) = makeRuntime(source: "while (true) {}")
    #expect(runtime.execute(unsafe, approvedProgramSHA256: unsafe.program.sha256).error == "unsafeProgram")

    let (_, invalid, _) = makeRuntime(source: "return tools.macos.accessibility.find({unexpected:true});")
    let invalidResult = runtime.execute(invalid, approvedProgramSHA256: invalid.program.sha256)
    #expect(invalidResult.error == "invalidInput")

    let staleFake = FakeMacProgramAuthority(now: fixtureNow); staleFake.validationError = LocalProgramError.staleTarget
    let (staleRuntime, stale, _) = makeRuntime(source: "return 1;", authority: staleFake)
    #expect(staleRuntime.execute(stale, approvedProgramSHA256: stale.program.sha256).error == "staleTarget")
}

@Test func envelopeRejectsWrongTargetExpiryCatalogDriftAndOversizedOutput() {
    let (runtime, valid, _) = makeRuntime(source: "return 1;")
    let wrong = MacLocalProgramEnvelope(executionID: valid.executionID, sessionID: valid.sessionID,
        turnID: valid.turnID, target: .init(surfaceType: "macos", deviceID: "other"),
        runtime: valid.runtime, program: valid.program, catalog: valid.catalog,
        bindings: valid.bindings, limits: valid.limits, approvalPolicy: valid.approvalPolicy,
        idempotencyKey: valid.idempotencyKey, issuedAt: valid.issuedAt, expiresAt: valid.expiresAt)
    #expect(runtime.execute(wrong, approvedProgramSHA256: wrong.program.sha256).error == "wrongDevice")

    let expired = MacLocalProgramEnvelope(executionID: valid.executionID, sessionID: valid.sessionID,
        turnID: valid.turnID, target: valid.target, runtime: valid.runtime, program: valid.program,
        catalog: valid.catalog, bindings: valid.bindings, limits: valid.limits,
        approvalPolicy: valid.approvalPolicy, idempotencyKey: valid.idempotencyKey,
        issuedAt: fixtureNow.addingTimeInterval(-61), expiresAt: fixtureNow)
    #expect(runtime.execute(expired, approvedProgramSHA256: expired.program.sha256).error == "expired")

    let driftCatalog = MacProgramCatalog(version: valid.catalog.version,
        sha256: String(repeating: "b", count: 64), allowedCapabilityIDs: valid.catalog.allowedCapabilityIDs)
    let drift = MacLocalProgramEnvelope(executionID: valid.executionID, sessionID: valid.sessionID,
        turnID: valid.turnID, target: valid.target, runtime: valid.runtime, program: valid.program,
        catalog: driftCatalog, bindings: valid.bindings, limits: valid.limits,
        approvalPolicy: valid.approvalPolicy, idempotencyKey: valid.idempotencyKey,
        issuedAt: valid.issuedAt, expiresAt: valid.expiresAt)
    #expect(runtime.execute(drift, approvedProgramSHA256: drift.program.sha256).error == "invalidEnvelope")

    let tinyOutput = MacProgramLimits(sourceBytes: 65_536, wallMS: 5_000,
        memoryBytes: 16_777_216, toolCalls: 20, parallelCalls: 1, resultBytes: 2, logBytes: 0)
    let (outputRuntime, outputEnvelope, _) = makeRuntime(source: #"return "long";"#, limits: tinyOutput)
    #expect(outputRuntime.execute(outputEnvelope, approvedProgramSHA256: outputEnvelope.program.sha256).error == "outputTooLarge")

    let largeSource = String(repeating: " ", count: LocalProgramLimits.sourceBytes + 1)
    let oversizedProgram = MacLocalProgramEnvelope.Program(source: largeSource,
        sha256: MacLocalProgramEnvelope.sourceDigest(largeSource))
    let oversized = MacLocalProgramEnvelope(executionID: valid.executionID, sessionID: valid.sessionID,
        turnID: valid.turnID, target: valid.target, runtime: valid.runtime, program: oversizedProgram,
        catalog: valid.catalog, bindings: valid.bindings, limits: valid.limits,
        approvalPolicy: valid.approvalPolicy, idempotencyKey: valid.idempotencyKey,
        issuedAt: valid.issuedAt, expiresAt: valid.expiresAt)
    #expect(runtime.execute(oversized, approvedProgramSHA256: oversized.program.sha256).error == "sourceTooLarge")

    let defaultAdvertisement = MacLocalProgramAdvertisement(deviceID: "default-fixture", issuedAt: fixtureNow)
    #expect(defaultAdvertisement.expiresAt == fixtureNow.addingTimeInterval(60))
}
#endif
