#if os(macOS)
import Foundation
import MoaMacCore
import MoaMacProgramRunnerCore
@testable import MoaMacShell
import Testing

private final class FakeMacProgramAuthority: MacAccessibilityProgramAuthority, @unchecked Sendable {
    var validated = 0
    var observations = 0
    var actions = 0
    var validationError: (any Error)?
    var observationError: (any Error)?
    var actionError: (any Error)?
    var observeHook: (@Sendable () -> Void)?
    var actionHook: (@Sendable () -> Void)?
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
              bindings.axSnapshotID == observation.binding.observationID
        else { throw LocalProgramError.staleTarget }
    }

    func observe(now: Date) throws -> MacAXProgramObservation {
        observations += 1
        observeHook?()
        if let observationError { throw observationError }
        return observation
    }

    func perform(_ request: MacAXActionRequest, executionID: String,
                 sequence: Int, now: Date) throws -> MacAXActionOutcome {
        actions += 1
        actionHook?()
        if let actionError { throw actionError }
        guard request.handle == "node-1", request.observationID == "obs-1",
              request.action == "press" else { throw LocalProgramError.unknownHandle }
        return .init(postStateSHA256: String(repeating: "c", count: 64), resourceID: "ax_fixture_target")
    }
}

private struct FixtureFailure: Error {}

private final class FakeSystemAXPlatform: MacSystemAccessibilityPlatform, @unchecked Sendable {
    var observations: [MacAXProgramObservation] = []
    var processError: (any Error)?
    var observeError: (any Error)?
    var performError: (any Error)?
    var requiredWindows: [String?] = []
    var performed = 0
    func validateProcess() throws { if let processError { throw processError } }
    func observe(requiredWindowID: String?, now: Date) throws -> MacAXProgramObservation {
        requiredWindows.append(requiredWindowID)
        if let observeError { throw observeError }
        guard !observations.isEmpty else { throw LocalProgramError.staleObservation }
        return observations.removeFirst()
    }
    func perform(_ request: MacAXActionRequest, executionID: String,
                 sequence: Int, now: Date) throws -> String? {
        performed += 1
        if let performError { throw performError }
        return "ax_fixture_resource"
    }
}
private struct FixtureApprover: MacProgramApprovalAuthorizing {
    func resolve(approvalID: String, effectClass: String, capabilityID: String,
                 executionID: String, expiresAt: Date) -> MacProgramApprovalDecision {
        .init(approvalID: approvalID, status: "approved")
    }
}

private let fixtureNow = Date(timeIntervalSince1970: 1_800_000_000)

private func makeJournal() -> AtomicFileMacProgramJournal {
    try! AtomicFileMacProgramJournal(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("moa-local-program-\(UUID().uuidString).json"))
}

private func declaredMain(_ body: String) -> String {
    if body.contains("function main") { return body }
    let asynchronousBody = body.replacingOccurrences(of: "tools.", with: "await tools.")
    return "async function main() {\n\(asynchronousBody)\n}"
}

private func makeRuntime(source: String,
                         capabilities: [String] = MacLocalProgramAdvertisement.capabilityIDs,
                         limits: MacProgramLimits = .init(sourceBytes: 65_536, wallMS: 5_000,
                            memoryBytes: nil, toolCalls: 20, parallelCalls: 1,
                            resultBytes: 65_536, logBytes: 0),
                         authority: FakeMacProgramAuthority? = nil,
                         journal: AtomicFileMacProgramJournal? = nil,
                         executionID: String = "exec-fixture",
                         idempotencyKey: String = "idem-fixture",
                         deviceID: String = "mac-fixture") -> (JavaScriptCoreMacProgramRuntime, MacLocalProgramEnvelope, FakeMacProgramAuthority) {
    let fake = authority ?? FakeMacProgramAuthority(now: fixtureNow)
    let runtime = JavaScriptCoreMacProgramRuntime(deviceID: deviceID, authority: fake,
        clientInstanceID: "client-fixture", journal: journal ?? makeJournal(),
        approvalAuthorizer: FixtureApprover(), now: { fixtureNow })
    let ad = runtime.advertisement
    let executableSource = declaredMain(source)
    let envelope = MacLocalProgramEnvelope(executionID: executionID, sessionID: "session-fixture",
        turnID: "turn-fixture", target: ad.target, runtime: ad.runtime,
        program: .init(source: executableSource,
            sha256: MacLocalProgramEnvelope.sourceDigest(executableSource)),
        catalog: .init(version: ad.catalog.version, sha256: ad.catalog.sha256,
            allowedCapabilityIDs: capabilities),
        bindings: .init(localGrantID: "grant-fixture", bundleID: "com.example.fixture", pid: 42,
            processGeneration: "generation-1", signingIdentity: "fixture-signing",
            windowID: "window-1", axSnapshotID: "obs-1", stateSHA256: String(repeating: "a", count: 64)),
        limits: limits, approvalPolicy: .init(program: "preauthorized",
            alwaysAsk: capabilities.contains(where: { capability in
                MacLocalProgramAdvertisement.descriptors.first(where: { $0.capabilityID == capability })?.effectClass != "read"
            }) ? ["external_side_effect", "local_mutation"].filter { effect in
                MacLocalProgramAdvertisement.descriptors.contains { capabilities.contains($0.capabilityID) && $0.effectClass == effect }
            } : []),
        idempotencyKey: idempotencyKey, issuedAt: fixtureNow.addingTimeInterval(-1),
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
    #expect(ad.limits.memoryBytes == nil)
    #expect(!ad.catalog.capabilityIDs.contains(where: { $0.contains("shell") || $0.contains("jxa") || $0.contains("applescript") }))
    #expect(ad.catalog.sha256.count == 64)
    let fake = FakeMacProgramAuthority(now: fixtureNow)
    #expect(JavaScriptCoreMacProgramRuntime(deviceID: "default-clock", authority: fake,
        clientInstanceID: "default-client", journal: makeJournal()).advertisement.target.deviceID == "default-clock")
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
    #expect(throws: LocalProgramError.invalidEnvelope) {
        try MacLocalProgramEnvelope.decodeStrict(Data(#"{"version":1,"version":1}"#.utf8))
    }
    var malformed = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    malformed["version"] = "wrong-type"
    #expect(throws: LocalProgramError.invalidEnvelope) {
        try MacLocalProgramEnvelope.decodeStrict(JSONSerialization.data(withJSONObject: malformed))
    }
}

@Test func restrictedJCSMatchesIndependentFixturesAndRejectsAmbiguity() throws {
    let fixture = Data(#"{"a/b":"slash","arr":[null,true,false,0,42],"ctl":"\u000f","n":9007199254740991,"€":"euro","😀":"astral"}"#.utf8)
    let canonical = try MacCanonicalJSON.parse(fixture)
    #expect(MacLocalProgramDigest.data(canonical.canonicalData) ==
        "9af6189a09fc6952309cae21a8e858ac2b4860fb8d59500bdfb5cc9d66165e7c")
    let find = try MacCanonicalJSON.parse(Data(#"{"role":"AXButton","label":"Continue"}"#.utf8))
    #expect(MacLocalProgramDigest.data(find.canonicalData) ==
        "82b3e4a6b489561ad477090b36f30a5e6897d42c30411e53f9c3a763f96648a1")
    #expect(throws: LocalProgramError.invalidInput) { try MacCanonicalJSON.parse(Data(#"{"a":1,"a":1}"#.utf8)) }
    #expect(throws: LocalProgramError.invalidInput) { try MacCanonicalJSON.parse(Data("9007199254740992".utf8)) }
    #expect(throws: LocalProgramError.invalidInput) { try MacCanonicalJSON.parse(Data("1.0".utf8)) }
    #expect(throws: LocalProgramError.invalidInput) { try MacCanonicalJSON.parse(Data("01".utf8)) }
    let escaped = MacCanonicalJSON.string("\u{8}\t\n\u{c}\r\\\"").canonicalString
    #expect(escaped == #""\b\t\n\f\r\\\"""#)
    for malformed in ["", "?", "true false", "{", "{1:2}", #"{"a" 1}"#,
                      #"{"a":1 "b":2}"#, "[1 2]", #""unterminated"#,
                      #""\uZZZZ""#, "-", "-x", "tru"] {
        #expect(throws: LocalProgramError.invalidInput) {
            try MacCanonicalJSON.parse(Data(malformed.utf8))
        }
    }
}

@Test func runnerCoreStrictTranscriptCoversTerminalHostAndFailurePaths() {
    #expect(MacProgramRunnerSession.run(arguments: ["runner"], read: { nil }, write: { _ in }) == 64)
    var bad = [["kind": "start", "source": declaredMain("return 1;"), "extra": true] as [String: Any]]
    #expect(MacProgramRunnerSession.run(arguments: ["runner", "--stdio-v1"],
        read: { bad.isEmpty ? nil : bad.removeFirst() }, write: { _ in }) == 64)

    func transcript(source: String, replies: [[String: Any]] = []) -> [[String: Any]] {
        var input = [["kind": "start", "source": declaredMain(source),
            "result_bytes": 65_536, "log_bytes": 32_768] as [String: Any]] + replies
        var output: [[String: Any]] = []
        #expect(MacProgramRunnerSession.run(arguments: ["runner", "--stdio-v1"],
            read: { input.isEmpty ? nil : input.removeFirst() }, write: { output.append($0) }) == 0)
        return output
    }
    #expect(transcript(source: "return 1;").last?["output_json"] as? String == "1")
    #expect(transcript(source: "return undefined;").last?["output_json"] as? String == "null")
    #expect(transcript(source: "return );").last?["error"] as? String == "runtime_failed")
    let calls = transcript(source: "return tools.macos.app.current();", replies: [
        ["kind": "call_result", "id": 1, "output_json": #"{"name":"Fixture"}"#]
    ])
    #expect(calls.first?["capability_id"] as? String == "macos.app.current")
    #expect(calls.last?["output_json"] as? String == #"{"name":"Fixture"}"#)
    #expect(transcript(source: "return tools.macos.app.current();").last?["error"] as? String == "runtime_failed")
    let hugeSource = String(repeating: " ", count: 65_537)
    var huge = [["kind": "start", "source": hugeSource,
        "result_bytes": 65_536, "log_bytes": 32_768] as [String: Any]]
    #expect(MacProgramRunnerSession.run(arguments: ["runner", "--stdio-v1"],
        read: { huge.isEmpty ? nil : huge.removeFirst() }, write: { _ in }) == 64)
    #expect(transcript(source: #"return "x".repeat(65537);"#)
        .last?["error"] as? String == "limit_exceeded")
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
    #expect(result.receipts.allSatisfy { $0.hasValidDigest })
    #expect(result.receipts[0].previousReceiptSHA256 == nil)
    #expect(result.receipts[1].previousReceiptSHA256 == result.receipts[0].receiptSHA256)
    #expect(result.receipts[2].previousReceiptSHA256 == result.receipts[1].receiptSHA256)
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
    let (setRuntime, setEnvelope, _) = makeRuntime(source: source2)
    #expect(setRuntime.execute(setEnvelope, approvedProgramSHA256: setEnvelope.program.sha256).resultJSON == "7")
    let (checkRuntime, checkEnvelope, _) = makeRuntime(source: "return typeof marker;")
    #expect(checkRuntime.execute(checkEnvelope, approvedProgramSHA256: checkEnvelope.program.sha256).resultJSON == #""undefined""#)
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
    #expect(failed.error == "local program failed")

    let (syntaxRuntime, syntax, _) = makeRuntime(source: "return );")
    #expect(syntaxRuntime.execute(syntax, approvedProgramSHA256: syntax.program.sha256).error ==
        "local program failed")

    let continuationSource = #"try { tools.macos.accessibility.find({unexpected:true}); } catch (error) {} return tools.macos.accessibility.observe();"#
    let (continuationRuntime, continuation, _) = makeRuntime(source: continuationSource)
    let stopped = continuationRuntime.execute(continuation, approvedProgramSHA256: continuation.program.sha256)
    #expect(stopped.error == "invalidInput")
    #expect(stopped.receipts.count == 1)
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
        memoryBytes: nil, toolCalls: 1, parallelCalls: 1,
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
    func bridge(_ executionID: String) -> MacProgramBridge {
        let journal = makeJournal()
        let (_, envelope, _) = makeRuntime(source: "return 1;", authority: fake,
            journal: journal, executionID: executionID, idempotencyKey: "idem-\(executionID)")
        _ = try! journal.claim(envelope, claimantDeviceID: "mac-fixture",
            clientInstanceID: "client-fixture", at: fixtureNow)
        try! journal.markStarted(executionID: executionID, at: fixtureNow)
        return MacProgramBridge(authority: fake, executionID: executionID,
        allowed: allowed, maximumCalls: 20, deadline: fixtureNow.addingTimeInterval(10),
        preStateSHA256: String(repeating: "a", count: 64), journal: journal,
        claimant: .init(deviceID: "mac-fixture", clientInstanceID: "client-fixture"),
        programSHA256: envelope.program.sha256, catalogSHA256: envelope.catalog.sha256,
        bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings), now: { fixtureNow })
    }
    #expect(bridge("exec-direct").call("macos.accessibility.observe", #"{"extra":true}"#).contains("invalidInput"))

    let appBridge = bridge("exec-app")
    #expect(appBridge.call("macos.app.current", #"{"extra":true}"#).contains("invalidInput"))

    let windowBridge = bridge("exec-window")
    #expect(windowBridge.call("macos.window.current", #"{"extra":true}"#).contains("invalidInput"))

    let malformedBridge = bridge("exec-json")
    #expect(malformedBridge.call("macos.accessibility.observe", "not-json").contains("invalidInput"))

    let mismatchBridge = bridge("exec-mismatch")
    let mismatch = #"{"action":"cancel","handle":"node-1","observation_id":"obs-1"}"#
    #expect(mismatchBridge.call("macos.accessibility.press", mismatch).contains("invalidInput"))

    let expiredJournal = makeJournal()
    let (_, expiredEnvelope, _) = makeRuntime(source: "return 1;", authority: fake,
        journal: expiredJournal, executionID: "exec-expired", idempotencyKey: "idem-expired")
    _ = try! expiredJournal.claim(expiredEnvelope, claimantDeviceID: "mac-fixture",
        clientInstanceID: "client-fixture", at: fixtureNow)
    try! expiredJournal.markStarted(executionID: "exec-expired", at: fixtureNow)
    let expiredBridge = MacProgramBridge(authority: fake, executionID: "exec-expired",
        allowed: allowed, maximumCalls: 20, deadline: fixtureNow,
        preStateSHA256: String(repeating: "a", count: 64), journal: expiredJournal,
        claimant: .init(deviceID: "mac-fixture", clientInstanceID: "client-fixture"),
        programSHA256: expiredEnvelope.program.sha256, catalogSHA256: expiredEnvelope.catalog.sha256,
        bindingsSHA256: MacLocalProgramDigest.bindings(expiredEnvelope.bindings), now: { fixtureNow })
    #expect(expiredBridge.call("macos.accessibility.observe", "{}").contains("expired"))
    #expect(expiredBridge.receipts.first?.status == "timed_out")
    #expect(fake.observations == 0)
}

@Test func approvalSchemaAndStaleAuthorityAreRejected() {
    let (runtime, envelope, fake) = makeRuntime(source: "return 1;")
    let rejected = runtime.execute(envelope, approvedProgramSHA256: String(repeating: "0", count: 64))
    #expect(rejected.status == "rejected")
    #expect(rejected.error == "proposal_rejected")
    #expect((try? runtime.lifecycleEvents(executionID: envelope.executionID).map(\.kind)) == ["terminal"])
    #expect(fake.validated == 0)

    let (invalidRuntime, invalid, _) = makeRuntime(
        source: "return tools.macos.accessibility.find({unexpected:true});",
        executionID: "exec-invalid-schema", idempotencyKey: "idem-invalid-schema")
    let invalidResult = invalidRuntime.execute(invalid, approvedProgramSHA256: invalid.program.sha256)
    #expect(invalidResult.error == "invalidInput")

    let staleFake = FakeMacProgramAuthority(now: fixtureNow); staleFake.validationError = LocalProgramError.staleTarget
    let (staleRuntime, stale, _) = makeRuntime(source: "return 1;", authority: staleFake)
    #expect(staleRuntime.execute(stale, approvedProgramSHA256: stale.program.sha256).error == "staleTarget")
}

@Test func infiniteLoopIsIndependentlyKilledAtWallDeadline() {
    let limits = MacProgramLimits(sourceBytes: 65_536, wallMS: 100, memoryBytes: nil,
        toolCalls: 20, parallelCalls: 1, resultBytes: 65_536, logBytes: 0)
    let (runtime, envelope, fake) = makeRuntime(source: "while (true) {}", limits: limits,
        executionID: "exec-infinite", idempotencyKey: "idem-infinite")
    let started = Date()
    let result = runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(result.status == "timed_out")
    #expect(result.error == "expired")
    #expect(Date().timeIntervalSince(started) < 2)
    #expect(fake.observations == 0)
    #expect(fake.actions == 0)
}

@Test func runnerHandleAndLaunchFailureFailClosedWithoutAuthority() {
    let handle = MacProgramRunnerHandle()
    handle.stop()
    #expect(!handle.admitCall())
    let process = Process()
    handle.attach(process)
    handle.stop()

    let missing = URL(fileURLWithPath: "/definitely/missing/MoaMacProgramRunner")
    let fake = FakeMacProgramAuthority(now: fixtureNow)
    let journal = makeJournal()
    let runtime = JavaScriptCoreMacProgramRuntime(deviceID: "mac-fixture", authority: fake,
        clientInstanceID: "client-fixture", journal: journal, runnerURL: missing,
        now: { fixtureNow })
    let (_, template, _) = makeRuntime(source: "return 1;", authority: fake,
        executionID: "exec-missing-runner", idempotencyKey: "idem-missing-runner")
    let envelope = MacLocalProgramEnvelope(executionID: template.executionID,
        sessionID: template.sessionID, turnID: template.turnID, target: runtime.advertisement.target,
        runtime: runtime.advertisement.runtime, program: template.program,
        catalog: .init(version: runtime.advertisement.catalog.version,
            sha256: runtime.advertisement.catalog.sha256,
            allowedCapabilityIDs: template.catalog.allowedCapabilityIDs), bindings: template.bindings,
        limits: template.limits, approvalPolicy: template.approvalPolicy,
        idempotencyKey: template.idempotencyKey, issuedAt: template.issuedAt,
        expiresAt: template.expiresAt)
    let result = runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(result.status == "failed")
    #expect(result.error == "local program failed")
    #expect(fake.observations == 0)
    #expect(fake.actions == 0)
}

@Test func runnerStreamRejectsMalformedAndOversizedFrames() {
    let handle = MacProgramRunnerHandle()
    let state = MacProgramProcessRunner.RunnerState(input: Pipe(), handle: handle,
        call: { _, _ in "{}" }, terminal: DispatchSemaphore(value: 0))
    state.consume(Data("not-json\n".utf8))
    #expect(state.outcome(timedOut: false).error == "program runner protocol violation")
    #expect(!handle.admitCall())

    let oversizedHandle = MacProgramRunnerHandle()
    let oversized = MacProgramProcessRunner.RunnerState(input: Pipe(), handle: oversizedHandle,
        call: { _, _ in "{}" }, terminal: DispatchSemaphore(value: 0))
    oversized.consume(Data(repeating: 0x78,
        count: LocalProgramLimits.outputBytes + 16 * 1024 + 1))
    #expect(oversized.outcome(timedOut: false).error == "program runner frame exceeded local limit")
    #expect(!oversizedHandle.admitCall())
}

@Test func undefinedResultIsNormalizedWithoutExpandingTheBridge() {
    let (runtime, envelope, _) = makeRuntime(source: "return undefined;",
        executionID: "exec-undefined", idempotencyKey: "idem-undefined")
    let result = runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(result.status == "completed")
    #expect(result.resultJSON == "null")
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
    #expect(runtime.execute(expired, approvedProgramSHA256: expired.program.sha256).error == "replayed")

    let driftCatalog = MacProgramCatalog(version: valid.catalog.version,
        sha256: String(repeating: "b", count: 64), allowedCapabilityIDs: valid.catalog.allowedCapabilityIDs)
    let drift = MacLocalProgramEnvelope(executionID: valid.executionID, sessionID: valid.sessionID,
        turnID: valid.turnID, target: valid.target, runtime: valid.runtime, program: valid.program,
        catalog: driftCatalog, bindings: valid.bindings, limits: valid.limits,
        approvalPolicy: valid.approvalPolicy, idempotencyKey: valid.idempotencyKey,
        issuedAt: valid.issuedAt, expiresAt: valid.expiresAt)
    #expect(runtime.execute(drift, approvedProgramSHA256: drift.program.sha256).error == "replayed")

    let tinyOutput = MacProgramLimits(sourceBytes: 65_536, wallMS: 5_000,
        memoryBytes: nil, toolCalls: 20, parallelCalls: 1, resultBytes: 2, logBytes: 0)
    let (outputRuntime, outputEnvelope, _) = makeRuntime(source: #"return "long";"#, limits: tinyOutput)
    #expect(outputRuntime.execute(outputEnvelope,
        approvedProgramSHA256: outputEnvelope.program.sha256).error == "local program failed")

    let largeSource = String(repeating: " ", count: LocalProgramLimits.sourceBytes + 1)
    let oversizedProgram = MacLocalProgramEnvelope.Program(source: largeSource,
        sha256: MacLocalProgramEnvelope.sourceDigest(largeSource))
    let oversized = MacLocalProgramEnvelope(executionID: valid.executionID, sessionID: valid.sessionID,
        turnID: valid.turnID, target: valid.target, runtime: valid.runtime, program: oversizedProgram,
        catalog: valid.catalog, bindings: valid.bindings, limits: valid.limits,
        approvalPolicy: valid.approvalPolicy, idempotencyKey: valid.idempotencyKey,
        issuedAt: valid.issuedAt, expiresAt: valid.expiresAt)
    #expect(runtime.execute(oversized, approvedProgramSHA256: oversized.program.sha256).error == "replayed")

    let defaultAdvertisement = MacLocalProgramAdvertisement(deviceID: "default-fixture", issuedAt: fixtureNow)
    #expect(defaultAdvertisement.expiresAt == fixtureNow.addingTimeInterval(5 * 60))

    let widenedLimits = MacProgramLimits(sourceBytes: valid.limits.sourceBytes,
        wallMS: valid.limits.wallMS, memoryBytes: 1, toolCalls: valid.limits.toolCalls,
        parallelCalls: valid.limits.parallelCalls, resultBytes: valid.limits.resultBytes,
        logBytes: valid.limits.logBytes)
    let widened = MacLocalProgramEnvelope(executionID: valid.executionID,
        sessionID: valid.sessionID, turnID: valid.turnID, target: valid.target,
        runtime: valid.runtime, program: valid.program, catalog: valid.catalog,
        bindings: valid.bindings, limits: widenedLimits, approvalPolicy: valid.approvalPolicy,
        idempotencyKey: valid.idempotencyKey, issuedAt: valid.issuedAt, expiresAt: valid.expiresAt)
    #expect(runtime.execute(widened,
        approvedProgramSHA256: widened.program.sha256).error == "replayed")
}

@Test func fsyncJournalReplaysTerminalAcrossInstancesAndOmitsRawProgramData() throws {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("moa-journal-replay-\(UUID().uuidString).json")
    let firstJournal = try AtomicFileMacProgramJournal(fileURL: url)
    let source = "return (await tools.macos.accessibility.observe()).nodes.length;"
    let (firstRuntime, envelope, fake) = makeRuntime(source: source,
        capabilities: ["macos.accessibility.observe"], journal: firstJournal,
        executionID: "exec-durable", idempotencyKey: "idem-durable")
    let first = firstRuntime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(first.status == "completed")
    #expect(first.resultJSON == "1")
    #expect(fake.observations == 1)
    #expect(first.receipts.allSatisfy { $0.hasValidDigest })
    #expect(first.receipts.first?.previousReceiptSHA256 == nil)

    let secondJournal = try AtomicFileMacProgramJournal(fileURL: url)
    let (secondRuntime, replayEnvelope, _) = makeRuntime(source: source,
        capabilities: ["macos.accessibility.observe"], authority: fake,
        journal: secondJournal, executionID: "exec-durable", idempotencyKey: "idem-durable")
    let replay = secondRuntime.execute(replayEnvelope, approvedProgramSHA256: replayEnvelope.program.sha256)
    #expect(replay.status == "completed")
    #expect(replay.resultJSON == nil)
    #expect(fake.observations == 1)
    let events = try secondRuntime.lifecycleEvents(executionID: envelope.executionID)
    #expect(events.map(\.kind) == ["accepted", "started", "tool_started", "tool_finished", "terminal"])
    #expect(events.map(\.sequence) == [1, 2, 3, 4, 5])
    let eventEncoder = JSONEncoder(); eventEncoder.dateEncodingStrategy = .iso8601
    let eventDecoder = JSONDecoder(); eventDecoder.dateDecodingStrategy = .iso8601
    for event in events {
        let encoded = try eventEncoder.encode(event)
        #expect(try MacProgramLifecycleEvent.decodeStrict(encoded) == event)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(Set(object.keys) == ["version", "type", "event_id", "execution_id", "sequence", "kind", "occurred_at", "claimant", "payload"])
    }
    let maybeTerminalReceipt = try secondRuntime.terminalReceipt(executionID: envelope.executionID)
    let terminalReceipt = try #require(maybeTerminalReceipt)
    #expect(terminalReceipt.hasValidDigest)
    #expect(terminalReceipt.toolAttempts.count == first.receipts.count)
    #expect(terminalReceipt.toolAttempts.firstReceiptSHA256 == first.receipts.first?.receiptSHA256)
    #expect(terminalReceipt.toolAttempts.lastReceiptSHA256 == first.receipts.last?.receiptSHA256)
    #expect(terminalReceipt.previousReceiptSHA256 == first.receipts.last?.receiptSHA256)

    let receiptEncoder = JSONEncoder(); receiptEncoder.dateEncodingStrategy = .iso8601
    let firstReceipt = try #require(first.receipts.first)
    let receiptObject = try #require(JSONSerialization.jsonObject(
        with: receiptEncoder.encode(firstReceipt)) as? [String: Any])
    #expect(Set(receiptObject.keys) == ["version", "type", "receipt_id", "execution_id",
        "claimant", "tool_call_id", "attempt", "capability_id", "program_sha256",
        "catalog_sha256", "bindings_sha256", "input_sha256", "pre_state_sha256",
        "approval_id", "started_at", "finished_at", "status", "result",
        "post_state_sha256", "previous_receipt_sha256", "receipt_sha256"])
    #expect(receiptObject["approval_id"] is NSNull)
    #expect(receiptObject["post_state_sha256"] is NSNull)
    #expect(receiptObject["previous_receipt_sha256"] is NSNull)
    let terminalObject = try #require(JSONSerialization.jsonObject(
        with: receiptEncoder.encode(terminalReceipt)) as? [String: Any])
    #expect(Set(terminalObject.keys) == ["version", "type", "receipt_id", "execution_id",
        "session_id", "turn_id", "claimant", "runtime_id", "program_sha256",
        "catalog_sha256", "bindings_sha256", "started_at", "finished_at", "status",
        "tool_attempts", "result", "final_state_sha256", "error",
        "previous_receipt_sha256", "receipt_sha256"])

    let bytes = try String(contentsOf: url, encoding: .utf8)
    #expect(!bytes.contains(source))
    #expect(!bytes.contains("Fixture App"))
    #expect(!bytes.contains("Continue"))

    let (_, conflicting, _) = makeRuntime(source: "return 2;", journal: secondJournal,
        executionID: "exec-durable", idempotencyKey: "idem-durable")
    #expect(secondRuntime.execute(conflicting,
        approvedProgramSHA256: conflicting.program.sha256).error == "replayed")
    let (_, reusedKey, _) = makeRuntime(source: "return 3;", journal: secondJournal,
        executionID: "exec-other", idempotencyKey: "idem-durable")
    #expect(secondRuntime.execute(reusedKey,
        approvedProgramSHA256: reusedKey.program.sha256).error == "replayed")
}


@Test func mutationUsesPerCallApprovalAndLinksTrustworthyPostState() throws {
    let source = #"return tools.macos.accessibility.press({handle:"node-1", observation_id:"obs-1"});"#
    let (runtime, envelope, _) = makeRuntime(source: source,
        executionID: "exec-approval", idempotencyKey: "idem-approval")
    let result = runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256)
    #expect(result.status == "completed")
    let receipt = try #require(result.receipts.first)
    #expect(receipt.approvalID?.hasPrefix("approval_") == true)
    #expect(receipt.postStateSHA256 == String(repeating: "c", count: 64))
    let events = try runtime.lifecycleEvents(executionID: envelope.executionID)
    #expect(events.map(\.kind) == ["accepted", "started", "tool_started", "approval_required",
        "approval_resolved", "tool_finished", "terminal"])
}

@Test func systemAuthorityPolicyIsCoveredWithSyntheticPlatformOnly() throws {
    let process = ProcessIdentity(bundleID: "com.example.fixture", pid: 42,
        processStart: fixtureNow.addingTimeInterval(-10), signingIdentity: "fixture-signing")
    // Construction of the production adapter performs no AX/TCC work. Keep its
    // public wiring covered without invoking any live system API.
    _ = SystemMacAccessibilityAuthority(process: process,
        applicationName: "Fixture", grantID: "grant-production-wiring")
    let generation = String(format: "%.6f", process.processStart.timeIntervalSince1970)
    func observation(_ id: String, window: String = "window-1",
                     expiry: Date = fixtureNow.addingTimeInterval(30), label: String = "Continue") -> MacAXProgramObservation {
        .init(binding: .init(bundleID: process.bundleID, pid: process.pid,
            processGeneration: generation, windowID: window, observationID: id,
            observedAt: fixtureNow, expiresAt: expiry), applicationName: "Fixture",
            windowTitle: "Window", nodes: [.init(handle: "node-1", role: "AXButton",
                label: label, enabled: true, focused: false, actions: ["press"])])
    }
    let initial = observation("obs-1")
    let platform = FakeSystemAXPlatform(); platform.observations = [initial]
    let authority = SystemMacAccessibilityAuthority(process: process, grantID: "grant-1", platform: platform)
    let bindings = MacLocalProgramEnvelope.Bindings(localGrantID: "grant-1",
        bundleID: process.bundleID, pid: process.pid, processGeneration: generation,
        signingIdentity: process.signingIdentity, windowID: "window-1", axSnapshotID: "obs-1",
        stateSHA256: MacLocalProgramDigest.axState(initial))
    #expect(throws: LocalProgramError.staleObservation) {
        try authority.validate(bindings: bindings, now: fixtureNow)
    }
    #expect(try authority.observe(now: fixtureNow) == initial)
    try authority.validate(bindings: bindings, now: fixtureNow)
    try authority.validate(bindings: bindings, now: fixtureNow)
    #expect(throws: LocalProgramError.staleObservation) {
        try authority.validate(bindings: .init(localGrantID: "grant-1", bundleID: process.bundleID,
            pid: process.pid, processGeneration: generation, signingIdentity: process.signingIdentity,
            windowID: "window-1", axSnapshotID: "obs-1", stateSHA256: String(repeating: "d", count: 64)),
            now: fixtureNow)
    }

    let refreshed = observation("obs-2")
    platform.observations = [refreshed]
    #expect(try authority.observe(now: fixtureNow) == refreshed)
    let post = observation("obs-3", label: "Done")
    platform.observations = [post]
    let outcome = try authority.perform(.init(action: "press", handle: "node-1",
        observationID: "obs-2"), executionID: "exec", sequence: 1, now: fixtureNow)
    #expect(outcome.postStateSHA256 == MacLocalProgramDigest.axState(post))
    #expect(outcome.resourceID == "ax_fixture_resource")
    #expect(platform.performed == 1)
    #expect(platform.requiredWindows == [nil, "window-1", "window-1"])
    #expect(throws: LocalProgramError.staleObservation) {
        try authority.perform(.init(action: "press", handle: "node-1", observationID: "wrong"),
            executionID: "exec", sequence: 9, now: fixtureNow)
    }

    platform.observations = [observation("obs-4")]
    _ = try authority.observe(now: fixtureNow)
    platform.observeError = FixtureFailure()
    let uncertain = try authority.perform(.init(action: "press", handle: "node-1",
        observationID: "obs-4"), executionID: "exec", sequence: 2, now: fixtureNow)
    #expect(uncertain.postStateSHA256 == nil)

    let driftPlatform = FakeSystemAXPlatform()
    driftPlatform.observations = [initial, observation("drift", window: "window-other")]
    let driftAuthority = SystemMacAccessibilityAuthority(process: process,
        grantID: "grant-1", platform: driftPlatform)
    _ = try driftAuthority.observe(now: fixtureNow)
    try driftAuthority.validate(bindings: bindings, now: fixtureNow)
    #expect(throws: LocalProgramError.staleTarget) { try driftAuthority.observe(now: fixtureNow) }

    let expiredPlatform = FakeSystemAXPlatform()
    expiredPlatform.observations = [observation("expired", expiry: fixtureNow)]
    let expiredAuthority = SystemMacAccessibilityAuthority(process: process,
        grantID: "grant-1", platform: expiredPlatform)
    #expect(throws: LocalProgramError.staleTarget) { try expiredAuthority.observe(now: fixtureNow) }

    let badStatePlatform = FakeSystemAXPlatform(); badStatePlatform.observations = [initial]
    let badStateAuthority = SystemMacAccessibilityAuthority(process: process,
        grantID: "grant-1", platform: badStatePlatform)
    _ = try badStateAuthority.observe(now: fixtureNow)
    #expect(throws: LocalProgramError.staleObservation) {
        try badStateAuthority.validate(bindings: .init(localGrantID: "grant-1", bundleID: process.bundleID,
            pid: process.pid, processGeneration: generation, signingIdentity: process.signingIdentity,
            windowID: "window-1", axSnapshotID: "obs-1", stateSHA256: String(repeating: "e", count: 64)),
            now: fixtureNow)
    }

    platform.processError = LocalProgramError.staleTarget
    #expect(throws: LocalProgramError.staleTarget) { try authority.observe(now: fixtureNow) }
    #expect(throws: LocalProgramError.staleTarget) {
        try authority.validate(bindings: .init(localGrantID: "wrong", bundleID: process.bundleID,
            pid: process.pid, processGeneration: generation, signingIdentity: process.signingIdentity,
            windowID: "window-1", axSnapshotID: "obs", stateSHA256: String(repeating: "a", count: 64)),
            now: fixtureNow)
    }
}

@Test func accessibilityPolicyAndRawSystemCallsRemainSeparatedBySource() throws {
    let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let shell = packageRoot.appendingPathComponent("Sources/MoaMacShell")
    let coordinator = try String(contentsOf:
        shell.appendingPathComponent("SystemMacAccessibilityAuthority.swift"), encoding: .utf8)
    let adapter = try String(contentsOf:
        shell.appendingPathComponent("ApplicationServicesMacAccessibilityPlatform.swift"), encoding: .utf8)

    #expect(coordinator.contains("MacSystemAccessibilityPlatform"))
    for forbidden in ["import ApplicationServices", "import AppKit", "AXUIElement",
                      "NSRunningApplication", "AXUIElementCopyAttributeValue"] {
        #expect(!coordinator.contains(forbidden))
    }
    #expect(adapter.contains("import ApplicationServices"))
    #expect(adapter.contains("AXUIElement"))
    for forbidden in ["MacProgramJournaling", "MacLocalActionReceipt",
                      "MacProgramApprovalAuthorizing", "MacLocalProgramEnvelope.Program"] {
        #expect(!adapter.contains(forbidden))
    }
}

@Test func stopReturnsBeforeInFlightEffectAndReceiptsIndeterminate() async throws {
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    let fake = FakeMacProgramAuthority(now: fixtureNow)
    fake.actionHook = { entered.signal(); release.wait() }
    let source = #"return tools.macos.accessibility.press({handle:"node-1", observation_id:"obs-1"});"#
    let (runtime, envelope, _) = makeRuntime(source: source, authority: fake,
        executionID: "exec-indeterminate", idempotencyKey: "idem-indeterminate")
    let task = Task.detached { runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256) }
    let enteredResult = await withCheckedContinuation { continuation in
        DispatchQueue.global().async { continuation.resume(returning: entered.wait(timeout: .now() + 2)) }
    }
    #expect(enteredResult == .success)
    let before = Date()
    try runtime.requestStop(executionID: envelope.executionID)
    #expect(Date().timeIntervalSince(before) < 0.25)
    release.signal()
    let result = await task.value
    #expect(result.status == "indeterminate")
    #expect(result.receipts.last?.status == "indeterminate")
    #expect(result.receipts.last?.postStateSHA256 == nil)
}

@Test func cooperativeStopPreventsEveryLaterEffectAndPersistsOrderedTerminal() async throws {
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let fake = FakeMacProgramAuthority(now: fixtureNow)
    fake.observeHook = { entered.signal(); release.wait() }
    let source = #"""
    const observation = tools.macos.accessibility.observe();
    return tools.macos.accessibility.press({handle:observation.nodes[0].handle, observation_id:observation.binding.observation_id});
    """#
    let journal = makeJournal()
    let (runtime, envelope, _) = makeRuntime(source: source, authority: fake,
        journal: journal, executionID: "exec-stop", idempotencyKey: "idem-stop")
    let task = Task.detached { runtime.execute(envelope, approvedProgramSHA256: envelope.program.sha256) }
    let enteredResult = await withCheckedContinuation { continuation in
        DispatchQueue.global().async {
            continuation.resume(returning: entered.wait(timeout: .now() + 2))
        }
    }
    #expect(enteredResult == .success)
    let stopTask = Task.detached { try runtime.requestStop(executionID: envelope.executionID) }
    while try !runtime.lifecycleEvents(executionID: envelope.executionID).contains(where: { $0.kind == "stopping" }) {
        await Task.yield()
    }
    release.signal()
    try await stopTask.value
    let result = await task.value
    #expect(result.status == "stopped")
    #expect(result.error == "stopped")
    #expect(fake.observations == 1)
    #expect(fake.actions == 0)
    let events = try runtime.lifecycleEvents(executionID: envelope.executionID)
    #expect(events.map(\.kind) == ["accepted", "started", "tool_started", "stopping", "tool_finished", "terminal"])
    if case .terminal(let status, _, _) = events.last?.payload { #expect(status == "stopped") }
    else { Issue.record("expected terminal payload") }
    try runtime.requestStop(executionID: envelope.executionID)
}

@Test func journalRejectsMalformedLifecycleUnknownRecordsAndCorruption() throws {
    #expect(throws: LocalProgramError.invalidInput) {
        try MacProgramLifecycleEvent(executionID: "exec", sequence: 0, kind: "accepted",
            occurredAt: fixtureNow, claimant: .init(deviceID: "device", clientInstanceID: "client"),
            payload: .accepted(proposalSHA256: String(repeating: "a", count: 64)))
    }
    let claimant = MacReceiptClaimant(deviceID: "device", clientInstanceID: "client")
    let lifecycle: [MacProgramLifecycleEvent] = [
        try .init(executionID: "exec", sequence: 1, kind: "approval_required", occurredAt: fixtureNow,
            claimant: claimant, payload: .approvalRequired(approvalID: "approval_fixture",
                effectClass: "external_side_effect", capabilityID: "macos.accessibility.press",
                toolCallID: "call_fixture", attempt: 1, expiresAt: fixtureNow.addingTimeInterval(10))),
        try .init(executionID: "exec", sequence: 2, kind: "approval_resolved", occurredAt: fixtureNow,
            claimant: claimant, payload: .approvalResolved(approvalID: "approval_fixture", status: "approved")),
        try .init(executionID: "exec", sequence: 3, kind: "progress", occurredAt: fixtureNow,
            claimant: claimant, payload: .progress(message: "Processed local items.", completed: 1, total: 2)),
    ]
    let strictEncoder = JSONEncoder(); strictEncoder.dateEncodingStrategy = .iso8601
    for event in lifecycle {
        #expect(try MacProgramLifecycleEvent.decodeStrict(strictEncoder.encode(event)) == event)
    }
    #expect(throws: LocalProgramError.invalidInput) {
        try MacProgramLifecycleEvent(executionID: "exec", sequence: 1, kind: "progress",
            occurredAt: fixtureNow, claimant: claimant,
            payload: .progress(message: "", completed: 2, total: 1))
    }
    #expect(throws: LocalProgramError.invalidInput) {
        try MacProgramLifecycleEvent(executionID: "exec", sequence: 1, kind: "tool_started",
            occurredAt: fixtureNow, claimant: .init(deviceID: "device", clientInstanceID: "client"),
            payload: .started)
    }
    #expect(throws: LocalProgramError.invalidInput) {
        try AtomicFileMacProgramJournal(fileURL: URL(string: "https://example.invalid/journal")!)
    }

    let unknown = makeJournal()
    #expect(throws: LocalProgramError.invalidEnvelope) { try unknown.isStopRequested(executionID: "missing") }
    #expect(throws: LocalProgramError.invalidEnvelope) { try unknown.events(executionID: "missing") }
    #expect(throws: LocalProgramError.invalidEnvelope) { try unknown.terminalReceipt(executionID: "missing") }
    #expect(throws: LocalProgramError.invalidEnvelope) { try unknown.markStarted(executionID: "missing", at: fixtureNow) }

    let validEvent = try MacProgramLifecycleEvent(executionID: "exec", sequence: 1,
        kind: "started", occurredAt: fixtureNow,
        claimant: .init(deviceID: "device", clientInstanceID: "client"), payload: .started)
    let eventEncoder = JSONEncoder(); eventEncoder.dateEncodingStrategy = .iso8601
    let eventDecoder = JSONDecoder(); eventDecoder.dateDecodingStrategy = .iso8601
    var invalidKind = try #require(JSONSerialization.jsonObject(
        with: eventEncoder.encode(validEvent)) as? [String: Any])
    invalidKind["kind"] = "unknown"
    #expect(throws: LocalProgramError.invalidInput) {
        try eventDecoder.decode(MacProgramLifecycleEvent.self,
            from: JSONSerialization.data(withJSONObject: invalidKind))
    }
    var invalidVersion = invalidKind
    invalidVersion["kind"] = "started"
    invalidVersion["version"] = 2
    #expect(throws: LocalProgramError.invalidInput) {
        try eventDecoder.decode(MacProgramLifecycleEvent.self,
            from: JSONSerialization.data(withJSONObject: invalidVersion))
    }

    let corruptURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("moa-journal-corrupt-\(UUID().uuidString).json")
    try Data("not-json".utf8).write(to: corruptURL)
    let corrupt = try AtomicFileMacProgramJournal(fileURL: corruptURL)
    #expect(throws: LocalProgramError.executionFailed("journal is unreadable")) {
        try corrupt.events(executionID: "missing")
    }
}

@Test func journalRejectsDuplicateAndPostStopTransitionsAndMarksPendingTerminalInterrupted() throws {
    let journal = makeJournal()
    let (_, envelope, _) = makeRuntime(source: "return 1;", journal: journal,
        executionID: "exec-transitions", idempotencyKey: "idem-transitions")
    #expect(try journal.claim(envelope, claimantDeviceID: "mac-fixture",
        clientInstanceID: "client-fixture", at: fixtureNow) == .accepted)
    try journal.markStarted(executionID: envelope.executionID, at: fixtureNow)
    let pending = MacProgramPendingTool(toolCallID: "call-transition", capabilityID: "macos.accessibility.observe",
        inputSHA256: String(repeating: "b", count: 64), preStateSHA256: String(repeating: "a", count: 64),
        effectClass: "external_side_effect", sequence: 1, startedAt: fixtureNow)
    try journal.beginTool(executionID: envelope.executionID, pending: pending)
    try journal.requireApproval(executionID: envelope.executionID, approvalID: "approval-transition",
        effectClass: "external_side_effect", capabilityID: pending.capabilityID,
        toolCallID: pending.toolCallID, expiresAt: fixtureNow.addingTimeInterval(10), at: fixtureNow)
    try journal.resolveApproval(executionID: envelope.executionID,
        approvalID: "approval-transition", status: "approved", at: fixtureNow)
    #expect(throws: LocalProgramError.replayed) {
        try journal.resolveApproval(executionID: envelope.executionID,
            approvalID: "approval-transition", status: "approved", at: fixtureNow)
    }
    #expect(throws: LocalProgramError.replayed) {
        try journal.requireApproval(executionID: envelope.executionID, approvalID: "approval-late",
            effectClass: "external_side_effect", capabilityID: pending.capabilityID,
            toolCallID: pending.toolCallID, expiresAt: fixtureNow.addingTimeInterval(31), at: fixtureNow)
    }
    #expect(throws: LocalProgramError.replayed) {
        try journal.beginTool(executionID: envelope.executionID, pending: pending)
    }
    let validReceipt = MacLocalActionReceipt.make(receiptID: "tool-receipt-valid",
        executionID: envelope.executionID,
        claimant: .init(deviceID: "mac-fixture", clientInstanceID: "client-fixture"),
        toolCallID: pending.toolCallID, attempt: 1, capabilityID: pending.capabilityID,
        programSHA256: envelope.program.sha256, catalogSHA256: envelope.catalog.sha256,
        bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings),
        inputSHA256: pending.inputSHA256, preStateSHA256: pending.preStateSHA256,
        startedAt: fixtureNow, finishedAt: fixtureNow, status: "succeeded",
        result: .init(summary: "bounded_local_read_completed"), previousReceiptSHA256: nil)
    let receiptEncoder = JSONEncoder(); receiptEncoder.dateEncodingStrategy = .iso8601
    var forgedObject = try #require(JSONSerialization.jsonObject(with: receiptEncoder.encode(validReceipt)) as? [String: Any])
    forgedObject["receipt_sha256"] = String(repeating: "0", count: 64)
    let receiptDecoder = JSONDecoder(); receiptDecoder.dateDecodingStrategy = .iso8601
    let forged = try receiptDecoder.decode(MacLocalActionReceipt.self,
        from: JSONSerialization.data(withJSONObject: forgedObject))
    #expect(!forged.hasValidDigest)
    #expect(throws: LocalProgramError.replayed) {
        try journal.finishTool(executionID: envelope.executionID, receipt: forged, at: fixtureNow)
    }
    let wrongReceipt = MacLocalActionReceipt.make(receiptID: "tool-receipt-wrong",
        executionID: envelope.executionID,
        claimant: .init(deviceID: "mac-fixture", clientInstanceID: "client-fixture"),
        toolCallID: pending.toolCallID, attempt: 1, capabilityID: "macos.window.current",
        programSHA256: envelope.program.sha256, catalogSHA256: envelope.catalog.sha256,
        bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings),
        inputSHA256: pending.inputSHA256, preStateSHA256: pending.preStateSHA256,
        startedAt: fixtureNow, finishedAt: fixtureNow, status: "succeeded",
        result: .init(summary: "wrong_capability"), previousReceiptSHA256: nil)
    #expect(throws: LocalProgramError.replayed) {
        try journal.finishTool(executionID: envelope.executionID, receipt: wrongReceipt, at: fixtureNow)
    }
    let result = MacLocalProgramResult(executionID: envelope.executionID,
        sessionID: envelope.sessionID, turnID: envelope.turnID,
        claimantDeviceID: envelope.target.deviceID, runtimeID: envelope.runtime.runtimeID,
        status: "failed", resultJSON: nil, error: "fixture interruption", toolCalls: 1,
        receipts: [], programSHA256: envelope.program.sha256, catalogSHA256: envelope.catalog.sha256,
        bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings),
        startedAt: fixtureNow, finishedAt: fixtureNow)
    try journal.finish(executionID: envelope.executionID, result: result, at: fixtureNow)
    let terminal = try journal.claim(envelope, claimantDeviceID: "mac-fixture",
        clientInstanceID: "client-fixture", at: fixtureNow)
    guard case .replay(let replayed) = terminal else { Issue.record("expected replay"); return }
    #expect(replayed?.status == "interrupted")
    #expect(throws: LocalProgramError.replayed) {
        try journal.finishTool(executionID: envelope.executionID, receipt: wrongReceipt, at: fixtureNow)
    }
    try journal.requestStop(executionID: envelope.executionID, at: fixtureNow)

    let stoppedJournal = makeJournal()
    let (_, stoppedEnvelope, _) = makeRuntime(source: "return 1;", journal: stoppedJournal,
        executionID: "exec-prestopped", idempotencyKey: "idem-prestopped")
    _ = try stoppedJournal.claim(stoppedEnvelope, claimantDeviceID: "mac-fixture",
        clientInstanceID: "client-fixture", at: fixtureNow)
    try stoppedJournal.requestStop(executionID: stoppedEnvelope.executionID, at: fixtureNow)
    #expect(throws: LocalProgramError.stopped) {
        try stoppedJournal.markStarted(executionID: stoppedEnvelope.executionID, at: fixtureNow)
    }
    #expect(throws: LocalProgramError.stopped) {
        try stoppedJournal.beginTool(executionID: stoppedEnvelope.executionID, pending: pending)
    }
}
#endif
