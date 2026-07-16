#if os(macOS)
import ApplicationServices
import AppKit
import Foundation
import MoaMacCore

/// Minimal raw bridge to public macOS Accessibility APIs. Policy, traversal,
/// identifiers, action validation, and error messages live in the injected
/// semantic adapter rather than this shell.
final class ApplicationServicesAXElement: MacAXElement, @unchecked Sendable {
    let raw: AXUIElement
    init(_ raw: AXUIElement) { self.raw = raw }
}

final class ApplicationServicesAXCAPI: MacAccessibilityCAPI, @unchecked Sendable {
    func processIdentity(pid: Int32) -> ProcessIdentity? {
        guard let running = NSRunningApplication(processIdentifier: pid) else { return nil }
        return ProcessInspector.identity(running)
    }

    func application(pid: Int32) -> any MacAXElement {
        ApplicationServicesAXElement(AXUIElementCreateApplication(pid))
    }

    func attribute(_ name: String, of element: any MacAXElement) -> MacAXValue? {
        guard let element = element as? ApplicationServicesAXElement else { return nil }
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element.raw, name as CFString, &raw) == .success,
              let raw else { return nil }
        switch name {
        case kAXFocusedWindowAttribute:
            guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
            return .element(ApplicationServicesAXElement(unsafeDowncast(raw, to: AXUIElement.self)))
        case kAXChildrenAttribute:
            guard let children = raw as? [AXUIElement] else { return nil }
            return .elements(children.map(ApplicationServicesAXElement.init))
        case kAXEnabledAttribute, kAXFocusedAttribute:
            guard let value = raw as? Bool else { return nil }
            return .boolean(value)
        default:
            guard let value = raw as? String else { return nil }
            return .string(value)
        }
    }

    func isAttributeSettable(_ name: String, of element: any MacAXElement) -> Bool {
        guard let element = element as? ApplicationServicesAXElement else { return false }
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element.raw, name as CFString, &settable) == .success
            && settable.boolValue
    }

    func actionNames(of element: any MacAXElement) -> [String] {
        guard let element = element as? ApplicationServicesAXElement else { return [] }
        var names: CFArray?
        guard AXUIElementCopyActionNames(element.raw, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    func performAction(_ name: String, on element: any MacAXElement) -> Bool {
        guard let element = element as? ApplicationServicesAXElement else { return false }
        return AXUIElementPerformAction(element.raw, name as CFString) == .success
    }

    func setStringValue(_ value: String, attribute: String,
                        on element: any MacAXElement) -> Bool {
        guard let element = element as? ApplicationServicesAXElement else { return false }
        return AXUIElementSetAttributeValue(
            element.raw, attribute as CFString, value as CFTypeRef) == .success
    }

    func elementsEqual(_ lhs: any MacAXElement, _ rhs: any MacAXElement) -> Bool {
        guard let lhs = lhs as? ApplicationServicesAXElement,
              let rhs = rhs as? ApplicationServicesAXElement else { return false }
        return CFEqual(lhs.raw, rhs.raw)
    }
}
#endif
