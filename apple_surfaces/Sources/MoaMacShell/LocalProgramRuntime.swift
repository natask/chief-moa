#if os(macOS)
import Foundation
import JavaScriptCore
import MoaMacCore

@objc protocol MacProgramBridgeExport: JSExport {
    func call(_ capabilityID: String, _ inputJSON: String) -> String
}

/// The only native object placed into an agent-created JavaScript context.
/// It dispatches closed semantic capabilities; it does not expose AppKit,
/// Objective-C, filesystem, network, Apple Events, JXA, or shell authority.
final class MacProgramBridge: NSObject, MacProgramBridgeExport, @unchecked Sendable {
    private let authority: any MacAccessibilityProgramAuthority
    private let executionID: String
    private let allowed: Set<String>
    private let maximumCalls: Int
    private let deadline: Date
    private let preStateSHA256: String
    private let now: @Sendable () -> Date
    private(set) var calls = 0
    private(set) var receipts: [MacLocalActionReceipt] = []
    private(set) var failure: LocalProgramError?

    init(authority: any MacAccessibilityProgramAuthority, executionID: String,
         allowed: Set<String>, maximumCalls: Int, deadline: Date,
         preStateSHA256: String,
         now: @escaping @Sendable () -> Date) {
        self.authority = authority
        self.executionID = executionID
        self.allowed = allowed
        self.maximumCalls = maximumCalls
        self.deadline = deadline
        self.preStateSHA256 = preStateSHA256
        self.now = now
    }

    func call(_ capabilityID: String, _ inputJSON: String) -> String {
        let startedAt = now()
        let inputDigest = MacLocalProgramDigest.data(Data(inputJSON.utf8))
        do {
            if let failure { throw failure }
            guard allowed.contains(capabilityID) else { throw LocalProgramError.capabilityDenied }
            let calledAt = startedAt
            guard calledAt < deadline else { throw LocalProgramError.expired }
            calls += 1
            guard calls <= maximumCalls else { throw LocalProgramError.toolBudgetExceeded }
            guard let data = inputJSON.data(using: .utf8), data.count <= 8 * 1024 else {
                throw LocalProgramError.invalidInput
            }
            let decoded: Any
            do { decoded = try JSONSerialization.jsonObject(with: data) }
            catch { throw LocalProgramError.invalidInput }
            guard let input = decoded as? [String: Any] else { throw LocalProgramError.invalidInput }

            let output: String
            switch capabilityID {
            case "macos.accessibility.observe":
                guard input.isEmpty else { throw LocalProgramError.invalidInput }
                output = try Self.json(authority.observe(now: calledAt))
            case "macos.accessibility.find":
                guard Set(input.keys).isSubset(of: ["role", "label"]),
                      input.values.allSatisfy({ $0 is String })
                else { throw LocalProgramError.invalidInput }
                let observation = try authority.observe(now: calledAt)
                let role = input["role"] as? String
                let label = input["label"] as? String
                output = try Self.json(observation.nodes.filter {
                    (role == nil || $0.role == role) && (label == nil || $0.label == label)
                })
            case "macos.app.current":
                guard input.isEmpty else { throw LocalProgramError.invalidInput }
                let observation = try authority.observe(now: calledAt)
                output = try Self.json(CurrentApplication(name: observation.applicationName,
                    bundleID: observation.binding.bundleID, pid: observation.binding.pid))
            case "macos.window.current":
                guard input.isEmpty else { throw LocalProgramError.invalidInput }
                let observation = try authority.observe(now: calledAt)
                output = try Self.json(CurrentWindow(title: observation.windowTitle,
                    windowID: observation.binding.windowID,
                    observationID: observation.binding.observationID))
            default:
                let request = try JSONDecoder().decode(MacAXActionRequest.self, from: data)
                let expected = "macos.accessibility.\(request.action)"
                guard capabilityID == expected else { throw LocalProgramError.invalidInput }
                let receipt = try authority.perform(request, executionID: executionID,
                    sequence: calls, now: calledAt)
                receipts.append(receipt)
                return try Self.json(receipt)
            }
            receipts.append(Self.receipt(executionID: executionID, capabilityID: capabilityID,
                sequence: calls, inputSHA256: inputDigest, preStateSHA256: preStateSHA256,
                status: "succeeded", summary: "bounded local read completed",
                startedAt: startedAt, finishedAt: now()))
            return output
        }
        catch let error as LocalProgramError {
            failure = error
            receipts.append(Self.receipt(executionID: executionID, capabilityID: capabilityID,
                sequence: max(calls, 1), inputSHA256: inputDigest, preStateSHA256: preStateSHA256,
                status: Self.receiptStatus(error), summary: "local capability did not complete",
                startedAt: startedAt, finishedAt: now()))
            return Self.errorJSON(error)
        } catch {
            let wrapped = LocalProgramError.executionFailed("host operation failed")
            failure = wrapped
            receipts.append(Self.receipt(executionID: executionID, capabilityID: capabilityID,
                sequence: max(calls, 1), inputSHA256: inputDigest, preStateSHA256: preStateSHA256,
                status: "failed", summary: "local capability did not complete",
                startedAt: startedAt, finishedAt: now()))
            return Self.errorJSON(wrapped)
        }
    }

    private static func receipt(executionID: String, capabilityID: String, sequence: Int,
                                inputSHA256: String, preStateSHA256: String, status: String,
                                summary: String, startedAt: Date, finishedAt: Date) -> MacLocalActionReceipt {
        let target = MacLocalProgramDigest.data(Data("\(capabilityID)|\(preStateSHA256)".utf8))
        return MacLocalActionReceipt(receiptID: "tool_\(UUID().uuidString.lowercased())",
            executionID: executionID, capabilityID: capabilityID, sequence: sequence,
            inputSHA256: inputSHA256, preStateSHA256: preStateSHA256,
            postStateSHA256: nil, targetDigest: target, status: status,
            summary: summary, startedAt: startedAt, finishedAt: finishedAt)
    }

    private static func receiptStatus(_ error: LocalProgramError) -> String {
        switch error {
        case .staleObservation, .staleTarget, .unknownHandle: "stale_state"
        case .expired: "timed_out"
        case .capabilityDenied, .approvalRequired, .unsupportedAction, .invalidInput: "rejected"
        default: "failed"
        }
    }

    private static func json<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    private static func errorJSON(_ error: LocalProgramError) -> String {
        let message: String
        switch error {
        case .executionFailed(let detail): message = detail
        default: message = String(describing: error)
        }
        let data = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": message], options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    private struct CurrentApplication: Encodable {
        let name: String; let bundleID: String; let pid: Int32
        enum CodingKeys: String, CodingKey { case name, pid; case bundleID = "bundle_id" }
    }

    private struct CurrentWindow: Encodable {
        let title: String; let windowID: String; let observationID: String
        enum CodingKeys: String, CodingKey {
            case title; case windowID = "window_id"; case observationID = "observation_id"
        }
    }
}

public final class JavaScriptCoreMacProgramRuntime: @unchecked Sendable {
    private let deviceID: String
    private let authority: any MacAccessibilityProgramAuthority
    private let now: @Sendable () -> Date
    private let localAdvertisement: MacLocalProgramAdvertisement

    public init(deviceID: String, authority: any MacAccessibilityProgramAuthority,
                now: @escaping @Sendable () -> Date = Date.init) {
        self.deviceID = deviceID
        self.authority = authority
        self.now = now
        let issuedAt = now()
        self.localAdvertisement = .init(deviceID: deviceID, issuedAt: issuedAt,
            expiresAt: issuedAt.addingTimeInterval(24 * 60 * 60))
    }

    public var advertisement: MacLocalProgramAdvertisement { localAdvertisement }

    public func execute(_ envelope: MacLocalProgramEnvelope,
                        approvedProgramSHA256: String) -> MacLocalProgramResult {
        var bridge: MacProgramBridge?
        var executionStartedAt: Date?
        do {
            let startedAt = now()
            try envelope.validate(advertisement: localAdvertisement, now: startedAt)
            guard approvedProgramSHA256 == envelope.program.sha256 else {
                throw LocalProgramError.approvalRequired
            }
            try Self.validateProgramSource(envelope.program.source)
            try authority.validate(bindings: envelope.bindings, now: startedAt)
            executionStartedAt = startedAt
            guard let context = JSContext(virtualMachine: JSVirtualMachine()) else {
                throw LocalProgramError.executionFailed("JavaScriptCore unavailable")
            }
            let createdBridge = MacProgramBridge(authority: authority,
                executionID: envelope.executionID,
                allowed: Set(envelope.catalog.allowedCapabilityIDs),
                maximumCalls: envelope.limits.toolCalls,
                deadline: min(envelope.expiresAt,
                    startedAt.addingTimeInterval(Double(envelope.limits.wallMS) / 1_000)),
                preStateSHA256: envelope.bindings.stateSHA256,
                now: now)
            bridge = createdBridge
            var exception: String?
            context.exceptionHandler = { _, value in
                if let value { exception = value.toString() }
                else { exception = "JavaScript exception" }
            }
            context.setObject(createdBridge, forKeyedSubscript: "__moaMacHost" as NSString)
            context.evaluateScript(Self.bootstrap)
            guard exception == nil else { throw LocalProgramError.executionFailed(exception!) }

            let wrapped = "JSON.stringify((function(){\n\(envelope.program.source)\n})())"
            let value = context.evaluateScript(wrapped)
            if let failure = createdBridge.failure { throw failure }
            if let exception { throw LocalProgramError.executionFailed(exception) }
            guard now().timeIntervalSince(startedAt) * 1_000 <= Double(envelope.limits.wallMS) else {
                throw LocalProgramError.expired
            }
            let output: String
            if let value { output = value.toString() }
            else { output = "null" }
            guard output.utf8.count <= envelope.limits.resultBytes else {
                throw LocalProgramError.outputTooLarge
            }
            return result(envelope, status: "completed", resultJSON: output,
                error: nil, bridge: createdBridge, startedAt: executionStartedAt)
        } catch {
            return result(envelope, status: "failed", resultJSON: nil,
                error: Self.safeError(error), bridge: bridge, startedAt: executionStartedAt)
        }
    }

    private func result(_ envelope: MacLocalProgramEnvelope, status: String,
                        resultJSON: String?, error: String?, bridge: MacProgramBridge?,
                        startedAt: Date?) -> MacLocalProgramResult {
        MacLocalProgramResult(executionID: envelope.executionID,
            sessionID: envelope.sessionID, turnID: envelope.turnID,
            claimantDeviceID: deviceID, runtimeID: envelope.runtime.runtimeID,
            status: status, resultJSON: resultJSON, error: error,
            toolCalls: bridge?.calls ?? 0, receipts: bridge?.receipts ?? [],
            programSHA256: envelope.program.sha256,
            catalogSHA256: envelope.catalog.sha256,
            bindingsSHA256: MacLocalProgramDigest.bindings(envelope.bindings),
            startedAt: startedAt, finishedAt: now())
    }

    /// JavaScriptCore has no supported per-context interrupt or heap-budget API.
    /// Until execution is isolated in a killable helper, reject source constructs
    /// that can create unbounded computation or dynamically recover constructors.
    private static func validateProgramSource(_ source: String) throws {
        let denied = #"(\b(?:while|for|do|function|class|import|export|with|debugger|constructor|prototype|__proto__|eval)\b|=>)"#
        if source.range(of: denied, options: .regularExpression) != nil {
            throw LocalProgramError.unsafeProgram
        }
    }

    private static let bootstrap = #"""
    "use strict";
    const host = __moaMacHost;
    const decode = value => {
      const result = JSON.parse(value);
      if (result && result.ok === false) throw new Error(result.error || "host operation failed");
      return result;
    };
    const call = (capability, input = {}) => decode(host.call(capability, JSON.stringify(input)));
    const accessibility = Object.freeze({
      observe: () => call("macos.accessibility.observe"),
      find: (query = {}) => call("macos.accessibility.find", query),
      press: input => call("macos.accessibility.press", {...input, action:"press"}),
      confirm: input => call("macos.accessibility.confirm", {...input, action:"confirm"}),
      cancel: input => call("macos.accessibility.cancel", {...input, action:"cancel"}),
      increment: input => call("macos.accessibility.increment", {...input, action:"increment"}),
      decrement: input => call("macos.accessibility.decrement", {...input, action:"decrement"}),
      show_menu: input => call("macos.accessibility.show_menu", {...input, action:"show_menu"}),
      set_value: input => call("macos.accessibility.set_value", {...input, action:"set_value"})
    });
    globalThis.tools = Object.freeze({macos:Object.freeze({
      accessibility,
      app:Object.freeze({current:()=>call("macos.app.current")}),
      window:Object.freeze({current:()=>call("macos.window.current")})
    })});
    delete globalThis.__moaMacHost;
    delete globalThis.fetch;
    delete globalThis.XMLHttpRequest;
    delete globalThis.WebSocket;
    delete globalThis.require;
    delete globalThis.process;
    delete globalThis.eval;
    delete globalThis.Function;
    delete globalThis.Promise;
    delete globalThis.Array;
    delete globalThis.Map;
    delete globalThis.Set;
    delete globalThis.WeakMap;
    delete globalThis.WeakSet;
    delete globalThis.RegExp;
    Object.freeze(globalThis.tools);
    """#

    private static func safeError(_ error: Error) -> String {
        switch error {
        case let local as LocalProgramError: return String(describing: local)
        default: return "local program failed"
        }
    }
}
#endif
