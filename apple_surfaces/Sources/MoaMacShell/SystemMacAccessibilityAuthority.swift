#if os(macOS)
import ApplicationServices
import AppKit
import CryptoKit
import Foundation
import MoaMacCore

public final class SystemMacAccessibilityAuthority: MacAccessibilityProgramAuthority, @unchecked Sendable {
    private struct Handle {
        let element: AXUIElement
        let observationID: String
        let expiresAt: Date
        let supportedActions: Set<String>
        let settableValue: Bool
    }

    private let lock = NSLock()
    private let process: ProcessIdentity
    private let applicationName: String
    private let grantID: String
    private var handles: [String: Handle] = [:]
    private var current: MacAXProgramObservation?
    private var boundWindow: AXUIElement?
    private var acceptedBindings: MacLocalProgramEnvelope.Bindings?

    public init(process: ProcessIdentity, applicationName: String, grantID: String) {
        self.process = process
        self.applicationName = applicationName
        self.grantID = grantID
    }

    public func validate(bindings: MacLocalProgramEnvelope.Bindings, now: Date) throws {
        try lock.withLock {
            guard bindings.localGrantID == grantID, bindings.bundleID == process.bundleID,
                  bindings.pid == process.pid, bindings.processGeneration == Self.generation(process),
                  bindings.signingIdentity == process.signingIdentity else { throw LocalProgramError.staleTarget }
            try validateProcess()
            if let acceptedBindings {
                guard acceptedBindings == bindings,
                      current?.binding.windowID == bindings.windowID else {
                    throw LocalProgramError.staleObservation
                }
                return
            }
            guard let current,
                  current.binding.windowID == bindings.windowID,
                  current.binding.observationID == bindings.axSnapshotID,
                  MacLocalProgramDigest.axState(current) == bindings.stateSHA256,
                  now < current.binding.expiresAt else { throw LocalProgramError.staleObservation }
            acceptedBindings = bindings
        }
    }

    public func observe(now: Date) throws -> MacAXProgramObservation {
        try lock.withLock {
            try validateProcess()
            let window: AXUIElement
            if let boundWindow { window = boundWindow }
            else {
                let app = AXUIElementCreateApplication(process.pid)
                var rawWindow: CFTypeRef?
                guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &rawWindow) == .success,
                      let rawWindow else { throw LocalProgramError.staleTarget }
                window = unsafeDowncast(rawWindow, to: AXUIElement.self)
            }
            return try capture(window: window, now: now)
        }
    }

    private func capture(window: AXUIElement, now: Date) throws -> MacAXProgramObservation {
            let windowID = Self.number(window, "AXWindowNumber").map(String.init) ?? "unknown"
            if let current, current.binding.windowID != windowID { throw LocalProgramError.staleTarget }
            let observationID = UUID().uuidString
            let expiresAt = now.addingTimeInterval(LocalProgramLimits.maxHandleLifetime)
            var captured: [MacAXProgramNode] = []
            var nextHandles: [String: Handle] = [:]
            walk(window, depth: 0, observationID: observationID, expiresAt: expiresAt,
                 nodes: &captured, nextHandles: &nextHandles)
            let binding = MacAXTargetBinding(bundleID: process.bundleID, pid: process.pid,
                processGeneration: Self.generation(process), windowID: windowID,
                observationID: observationID, observedAt: now, expiresAt: expiresAt)
            let observation = MacAXProgramObservation(binding: binding, applicationName: applicationName,
                windowTitle: ObservationBounds.text(Self.string(window, kAXTitleAttribute) ?? "Untitled"), nodes: captured)
            handles = nextHandles
            current = observation
            boundWindow = window
            return observation
    }

    public func perform(_ request: MacAXActionRequest, executionID: String,
                        sequence: Int, now: Date) throws -> MacAXActionOutcome {
        try lock.withLock {
            try validateProcess()
            guard let current, current.binding.observationID == request.observationID,
                  now < current.binding.expiresAt else { throw LocalProgramError.staleObservation }
            guard let handle = handles[request.handle], handle.observationID == request.observationID,
                  now < handle.expiresAt else { throw LocalProgramError.unknownHandle }
            let allowed = Set(["press", "confirm", "cancel", "increment", "decrement", "show_menu", "set_value"])
            guard allowed.contains(request.action) else { throw LocalProgramError.unsupportedAction }

            let result: AXError
            if request.action == "set_value" {
                guard handle.settableValue, let value = request.value, value.utf8.count <= 4_096 else {
                    throw LocalProgramError.unsupportedAction
                }
                result = AXUIElementSetAttributeValue(handle.element, kAXValueAttribute as CFString, value as CFTypeRef)
            } else {
                guard handle.supportedActions.contains(request.action), let native = Self.nativeAction(request.action) else {
                    throw LocalProgramError.unsupportedAction
                }
                result = AXUIElementPerformAction(handle.element, native as CFString)
            }
            guard result == .success else { throw LocalProgramError.executionFailed("Accessibility action failed") }
            handles.removeAll(keepingCapacity: false)
            self.current = nil
            let digestInput = "\(process.bundleID)|\(process.pid)|\(Self.generation(process))|\(current.binding.windowID)|\(request.observationID)|\(request.handle)|\(request.action)"
            let resource = "ax_\(Self.digest(Data(digestInput.utf8)).prefix(24))"
            guard let boundWindow, let post = try? capture(window: boundWindow, now: now) else {
                return MacAXActionOutcome(postStateSHA256: nil, resourceID: resource)
            }
            return MacAXActionOutcome(postStateSHA256: MacLocalProgramDigest.axState(post),
                resourceID: resource)
        }
    }

    private func validateProcess() throws {
        guard let running = NSRunningApplication(processIdentifier: process.pid),
              ProcessInspector.identity(running) == process else { throw LocalProgramError.staleTarget }
    }

    private func walk(_ element: AXUIElement, depth: Int, observationID: String, expiresAt: Date,
                      nodes: inout [MacAXProgramNode], nextHandles: inout [String: Handle]) {
        guard depth <= ObservationBounds.maxDepth, nodes.count < ObservationBounds.maxNodes else { return }
        let role = Self.string(element, kAXRoleAttribute) ?? "AXUnknown"
        guard role != "AXSecureTextField" else { return }
        let handleID = UUID().uuidString
        var settable: DarwinBoolean = false
        let valueSettable = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
        var rawActions: CFArray?
        AXUIElementCopyActionNames(element, &rawActions)
        let mapped = Set(((rawActions as? [String]) ?? []).compactMap(Self.semanticAction))
        var enabled: CFTypeRef?, focused: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabled)
        AXUIElementCopyAttributeValue(element, kAXFocusedAttribute as CFString, &focused)
        let label = Self.string(element, kAXTitleAttribute) ?? Self.string(element, kAXDescriptionAttribute)
        var actions = mapped
        if valueSettable { actions.insert("set_value") }
        nodes.append(MacAXProgramNode(handle: handleID, role: role, label: ObservationBounds.label(label),
            enabled: (enabled as? Bool) ?? true, focused: (focused as? Bool) ?? false, actions: actions.sorted()))
        nextHandles[handleID] = Handle(element: element, observationID: observationID, expiresAt: expiresAt,
            supportedActions: mapped, settableValue: valueSettable)
        var childrenValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue) == .success,
              let children = childrenValue as? [AXUIElement] else { return }
        for child in children {
            walk(child, depth: depth + 1, observationID: observationID, expiresAt: expiresAt,
                 nodes: &nodes, nextHandles: &nextHandles)
        }
    }

    private static func semanticAction(_ native: String) -> String? {
        [kAXPressAction: "press", kAXConfirmAction: "confirm", kAXCancelAction: "cancel",
         kAXIncrementAction: "increment", kAXDecrementAction: "decrement", kAXShowMenuAction: "show_menu"][native]
    }

    private static func nativeAction(_ semantic: String) -> String? {
        ["press": kAXPressAction, "confirm": kAXConfirmAction, "cancel": kAXCancelAction,
         "increment": kAXIncrementAction, "decrement": kAXDecrementAction, "show_menu": kAXShowMenuAction][semantic]
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return raw as? String
    }

    private static func number(_ element: AXUIElement, _ attribute: String) -> Int? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return (raw as? NSNumber)?.intValue
    }

    private static func generation(_ process: ProcessIdentity) -> String {
        String(format: "%.6f", process.processStart.timeIntervalSince1970)
    }

    private static func digest<T: Encodable>(_ value: T) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        return digest((try? encoder.encode(value)) ?? Data())
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
#endif
