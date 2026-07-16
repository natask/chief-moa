#if os(macOS)
import CryptoKit
import Foundation
import MoaMacCore

/// Opaque element reference supplied by the low-level Accessibility client.
/// The substantive adapter never inspects or casts the platform object.
protocol MacAXElement: AnyObject, Sendable {}

enum MacAXValue: Sendable {
    case element(any MacAXElement)
    case elements([any MacAXElement])
    case string(String)
    case boolean(Bool)
}

/// Injectable, typed boundary around the public Accessibility C API.
/// Implementations collapse raw AX errors to absent values or `false`.
protocol MacAccessibilityCAPI: AnyObject, Sendable {
    func processIdentity(pid: Int32) -> ProcessIdentity?
    func application(pid: Int32) -> any MacAXElement
    func attribute(_ name: String, of element: any MacAXElement) -> MacAXValue?
    func isAttributeSettable(_ name: String, of element: any MacAXElement) -> Bool
    func actionNames(of element: any MacAXElement) -> [String]
    func performAction(_ name: String, on element: any MacAXElement) -> Bool
    func setStringValue(_ value: String, attribute: String,
                        on element: any MacAXElement) -> Bool
    func elementsEqual(_ lhs: any MacAXElement, _ rhs: any MacAXElement) -> Bool
}

/// Semantic translation over an injected Accessibility client. The raw shell
/// owns `import ApplicationServices` and all `AXUIElement` calls; this type owns
/// bounded traversal, ephemeral handles, exact focused-window binding, and
/// sanitized domain errors only.
final class ApplicationServicesMacAccessibilityPlatform: MacSystemAccessibilityPlatform, @unchecked Sendable {
    private struct Handle {
        let element: any MacAXElement
        let observationID: String
        let expiresAt: Date
        let supportedActions: Set<String>
        let settableValue: Bool
    }

    private let process: ProcessIdentity
    private let applicationName: String
    private let api: any MacAccessibilityCAPI
    private let makeID: @Sendable () -> String
    private var handles: [String: Handle] = [:]
    private var boundWindow: (element: any MacAXElement, id: String)?

    convenience init(process: ProcessIdentity, applicationName: String) {
        self.init(process: process, applicationName: applicationName,
                  api: ApplicationServicesAXCAPI(), makeID: { UUID().uuidString })
    }

    init(process: ProcessIdentity, applicationName: String,
         api: any MacAccessibilityCAPI,
         makeID: @escaping @Sendable () -> String = { UUID().uuidString }) {
        self.process = process
        self.applicationName = applicationName
        self.api = api
        self.makeID = makeID
    }

    func validateProcess() throws {
        guard api.processIdentity(pid: process.pid) == process else {
            throw LocalProgramError.staleTarget
        }
    }

    func observe(requiredWindowID: String?, now: Date) throws -> MacAXProgramObservation {
        try validateProcess()
        let application = api.application(pid: process.pid)
        guard case .element(let focusedWindow)? = api.attribute("AXFocusedWindow", of: application)
        else { throw LocalProgramError.staleTarget }

        let windowID: String
        if let boundWindow {
            guard api.elementsEqual(focusedWindow, boundWindow.element) else {
                throw LocalProgramError.staleTarget
            }
            windowID = boundWindow.id
        } else {
            guard requiredWindowID == nil else { throw LocalProgramError.staleTarget }
            windowID = "window_\(makeID())"
            boundWindow = (focusedWindow, windowID)
        }
        guard requiredWindowID == nil || requiredWindowID == windowID else {
            throw LocalProgramError.staleTarget
        }

        let observationID = "observation_\(makeID())"
        let expiresAt = now.addingTimeInterval(LocalProgramLimits.maxHandleLifetime)
        var nodes: [MacAXProgramNode] = []
        var nextHandles: [String: Handle] = [:]
        walk(focusedWindow, depth: 0, observationID: observationID, expiresAt: expiresAt,
             nodes: &nodes, nextHandles: &nextHandles)
        handles = nextHandles
        let title = stringAttribute("AXTitle", of: focusedWindow) ?? "Untitled"
        return .init(binding: .init(bundleID: process.bundleID, pid: process.pid,
            processGeneration: Self.generation(process), windowID: windowID,
            observationID: observationID, observedAt: now, expiresAt: expiresAt),
            applicationName: applicationName,
            windowTitle: ObservationBounds.text(title), nodes: nodes)
    }

    func perform(_ request: MacAXActionRequest, executionID: String,
                 sequence: Int, now: Date) throws -> String? {
        try validateProcess()
        guard let handle = handles[request.handle],
              handle.observationID == request.observationID,
              now < handle.expiresAt else { throw LocalProgramError.unknownHandle }

        let succeeded: Bool
        if request.action == "set_value" {
            guard handle.settableValue, let value = request.value,
                  value.utf8.count <= 4_096 else {
                throw LocalProgramError.unsupportedAction
            }
            succeeded = api.setStringValue(value, attribute: "AXValue", on: handle.element)
        } else {
            guard handle.supportedActions.contains(request.action),
                  let native = Self.nativeAction(request.action) else {
                throw LocalProgramError.unsupportedAction
            }
            succeeded = api.performAction(native, on: handle.element)
        }
        guard succeeded else {
            throw LocalProgramError.executionFailed("Accessibility action failed")
        }
        handles.removeAll(keepingCapacity: false)
        let material = "\(process.bundleID)|\(process.pid)|\(executionID)|\(sequence)|\(request.handle)|\(request.action)"
        return "ax_\(Self.digest(Data(material.utf8)).prefix(24))"
    }

    private func walk(_ element: any MacAXElement, depth: Int, observationID: String,
                      expiresAt: Date, nodes: inout [MacAXProgramNode],
                      nextHandles: inout [String: Handle]) {
        guard depth <= ObservationBounds.maxDepth,
              nodes.count < ObservationBounds.maxNodes else { return }
        let role = stringAttribute("AXRole", of: element) ?? "AXUnknown"
        guard role != "AXSecureTextField" else { return }

        let handleID = "handle_\(makeID())"
        let settableValue = api.isAttributeSettable("AXValue", of: element)
        let mapped = Set(api.actionNames(of: element).compactMap(Self.semanticAction))
        var actions = mapped
        if settableValue { actions.insert("set_value") }
        let label = stringAttribute("AXTitle", of: element)
            ?? stringAttribute("AXDescription", of: element)
        nodes.append(.init(handle: handleID, role: role, label: ObservationBounds.label(label),
            enabled: booleanAttribute("AXEnabled", of: element) ?? true,
            focused: booleanAttribute("AXFocused", of: element) ?? false,
            actions: actions.sorted()))
        nextHandles[handleID] = .init(element: element, observationID: observationID,
            expiresAt: expiresAt, supportedActions: mapped, settableValue: settableValue)

        guard case .elements(let children)? = api.attribute("AXChildren", of: element)
        else { return }
        for child in children {
            walk(child, depth: depth + 1, observationID: observationID,
                 expiresAt: expiresAt, nodes: &nodes, nextHandles: &nextHandles)
        }
    }

    private func stringAttribute(_ name: String, of element: any MacAXElement) -> String? {
        guard case .string(let value)? = api.attribute(name, of: element) else { return nil }
        return value
    }

    private func booleanAttribute(_ name: String, of element: any MacAXElement) -> Bool? {
        guard case .boolean(let value)? = api.attribute(name, of: element) else { return nil }
        return value
    }

    private static func semanticAction(_ native: String) -> String? {
        ["AXPress": "press", "AXConfirm": "confirm", "AXCancel": "cancel",
         "AXIncrement": "increment", "AXDecrement": "decrement",
         "AXShowMenu": "show_menu"][native]
    }

    private static func nativeAction(_ semantic: String) -> String? {
        ["press": "AXPress", "confirm": "AXConfirm", "cancel": "AXCancel",
         "increment": "AXIncrement", "decrement": "AXDecrement",
         "show_menu": "AXShowMenu"][semantic]
    }

    private static func generation(_ process: ProcessIdentity) -> String {
        String(format: "%.6f", process.processStart.timeIntervalSince1970)
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
#endif
