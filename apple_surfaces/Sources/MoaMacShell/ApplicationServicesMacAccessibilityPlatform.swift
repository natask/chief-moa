#if os(macOS)
import ApplicationServices
import AppKit
import CryptoKit
import Foundation
import MoaMacCore

/// Thin translation layer over public ApplicationServices APIs. It owns no
/// proposal, approval, receipt, replay, or success policy.
final class ApplicationServicesMacAccessibilityPlatform: MacSystemAccessibilityPlatform, @unchecked Sendable {
    private struct Handle {
        let element: AXUIElement, observationID: String, expiresAt: Date
        let supportedActions: Set<String>, settableValue: Bool
    }
    private let process: ProcessIdentity
    private let applicationName: String
    private var handles: [String: Handle] = [:]
    private var boundWindow: AXUIElement?

    init(process: ProcessIdentity, applicationName: String) {
        self.process = process; self.applicationName = applicationName
    }

    func validateProcess() throws {
        guard let running = NSRunningApplication(processIdentifier: process.pid),
              ProcessInspector.identity(running) == process else { throw LocalProgramError.staleTarget }
    }

    func observe(requiredWindowID: String?, now: Date) throws -> MacAXProgramObservation {
        try validateProcess()
        let window: AXUIElement
        if let boundWindow { window = boundWindow }
        else {
            let app = AXUIElementCreateApplication(process.pid); var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &raw) == .success,
                  let raw else { throw LocalProgramError.staleTarget }
            window = unsafeDowncast(raw, to: AXUIElement.self)
        }
        let windowID = Self.number(window, "AXWindowNumber").map(String.init) ?? "unknown"
        guard requiredWindowID == nil || requiredWindowID == windowID else { throw LocalProgramError.staleTarget }
        let observationID = UUID().uuidString
        let expiresAt = now.addingTimeInterval(LocalProgramLimits.maxHandleLifetime)
        var nodes: [MacAXProgramNode] = [], nextHandles: [String: Handle] = [:]
        walk(window, depth: 0, observationID: observationID, expiresAt: expiresAt,
            nodes: &nodes, nextHandles: &nextHandles)
        handles = nextHandles; boundWindow = window
        return .init(binding: .init(bundleID: process.bundleID, pid: process.pid,
            processGeneration: Self.generation(process), windowID: windowID,
            observationID: observationID, observedAt: now, expiresAt: expiresAt),
            applicationName: applicationName,
            windowTitle: ObservationBounds.text(Self.string(window, kAXTitleAttribute) ?? "Untitled"),
            nodes: nodes)
    }

    func perform(_ request: MacAXActionRequest, executionID: String,
                 sequence: Int, now: Date) throws -> String? {
        try validateProcess()
        guard let handle = handles[request.handle], handle.observationID == request.observationID,
              now < handle.expiresAt else { throw LocalProgramError.unknownHandle }
        let result: AXError
        if request.action == "set_value" {
            guard handle.settableValue, let value = request.value, value.utf8.count <= 4_096 else {
                throw LocalProgramError.unsupportedAction
            }
            result = AXUIElementSetAttributeValue(handle.element, kAXValueAttribute as CFString, value as CFTypeRef)
        } else {
            guard handle.supportedActions.contains(request.action), let native = Self.nativeAction(request.action)
            else { throw LocalProgramError.unsupportedAction }
            result = AXUIElementPerformAction(handle.element, native as CFString)
        }
        guard result == .success else { throw LocalProgramError.executionFailed("Accessibility action failed") }
        handles.removeAll(keepingCapacity: false)
        let material = "\(process.bundleID)|\(process.pid)|\(executionID)|\(sequence)|\(request.handle)|\(request.action)"
        return "ax_\(Self.digest(Data(material.utf8)).prefix(24))"
    }

    private func walk(_ element: AXUIElement, depth: Int, observationID: String, expiresAt: Date,
                      nodes: inout [MacAXProgramNode], nextHandles: inout [String: Handle]) {
        guard depth <= ObservationBounds.maxDepth, nodes.count < ObservationBounds.maxNodes else { return }
        let role = Self.string(element, kAXRoleAttribute) ?? "AXUnknown"
        guard role != "AXSecureTextField" else { return }
        let handleID = UUID().uuidString; var settable: DarwinBoolean = false
        let valueSettable = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
        var rawActions: CFArray?; AXUIElementCopyActionNames(element, &rawActions)
        let mapped = Set(((rawActions as? [String]) ?? []).compactMap(Self.semanticAction))
        var enabled: CFTypeRef?, focused: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabled)
        AXUIElementCopyAttributeValue(element, kAXFocusedAttribute as CFString, &focused)
        var actions = mapped; if valueSettable { actions.insert("set_value") }
        let label = Self.string(element, kAXTitleAttribute) ?? Self.string(element, kAXDescriptionAttribute)
        nodes.append(.init(handle: handleID, role: role, label: ObservationBounds.label(label),
            enabled: (enabled as? Bool) ?? true, focused: (focused as? Bool) ?? false,
            actions: actions.sorted()))
        nextHandles[handleID] = .init(element: element, observationID: observationID,
            expiresAt: expiresAt, supportedActions: mapped, settableValue: valueSettable)
        var childrenValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue) == .success,
              let children = childrenValue as? [AXUIElement] else { return }
        for child in children { walk(child, depth: depth + 1, observationID: observationID,
            expiresAt: expiresAt, nodes: &nodes, nextHandles: &nextHandles) }
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
        var raw: CFTypeRef?; guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return raw as? String
    }
    private static func number(_ element: AXUIElement, _ attribute: String) -> Int? {
        var raw: CFTypeRef?; guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return (raw as? NSNumber)?.intValue
    }
    private static func generation(_ process: ProcessIdentity) -> String { String(format: "%.6f", process.processStart.timeIntervalSince1970) }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
#endif
