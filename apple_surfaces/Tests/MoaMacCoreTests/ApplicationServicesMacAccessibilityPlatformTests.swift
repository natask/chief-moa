#if os(macOS)
import Foundation
import MoaMacCore
@testable import MoaMacShell
import Testing

private final class SyntheticAXElement: MacAXElement, @unchecked Sendable {
    let id: String
    var attributes: [String: MacAXValue] = [:]
    var actions: [String] = []
    var settableValue = false

    init(_ id: String) { self.id = id }
}

private final class SyntheticAXAPI: MacAccessibilityCAPI, @unchecked Sendable {
    var identity: ProcessIdentity?
    let applicationElement = SyntheticAXElement("application")
    var performed: [(String, String)] = []
    var valuesSet: [(String, String, String)] = []
    var performSucceeds = true
    var setSucceeds = true

    init(identity: ProcessIdentity?) { self.identity = identity }

    func processIdentity(pid: Int32) -> ProcessIdentity? { identity }
    func application(pid: Int32) -> any MacAXElement { applicationElement }
    func attribute(_ name: String, of element: any MacAXElement) -> MacAXValue? {
        (element as? SyntheticAXElement)?.attributes[name]
    }
    func isAttributeSettable(_ name: String, of element: any MacAXElement) -> Bool {
        name == "AXValue" && ((element as? SyntheticAXElement)?.settableValue ?? false)
    }
    func actionNames(of element: any MacAXElement) -> [String] {
        (element as? SyntheticAXElement)?.actions ?? []
    }
    func performAction(_ name: String, on element: any MacAXElement) -> Bool {
        performed.append((name, (element as? SyntheticAXElement)?.id ?? "wrong-type"))
        return performSucceeds
    }
    func setStringValue(_ value: String, attribute: String,
                        on element: any MacAXElement) -> Bool {
        valuesSet.append((value, attribute, (element as? SyntheticAXElement)?.id ?? "wrong-type"))
        return setSucceeds
    }
    func elementsEqual(_ lhs: any MacAXElement, _ rhs: any MacAXElement) -> Bool {
        guard let lhs = lhs as? SyntheticAXElement, let rhs = rhs as? SyntheticAXElement else {
            return false
        }
        return lhs.id == rhs.id
    }
}

private final class SyntheticIDSequence: @unchecked Sendable {
    private var next = 0
    func make() -> String { next += 1; return String(next) }
}

private let axFixtureNow = Date(timeIntervalSince1970: 1_800_000_000)
private let axFixtureProcess = ProcessIdentity(bundleID: "com.example.fixture", pid: 42,
    processStart: axFixtureNow.addingTimeInterval(-10), signingIdentity: "fixture-signing")

private func makeAXPlatform(window: SyntheticAXElement? = nil)
    -> (ApplicationServicesMacAccessibilityPlatform, SyntheticAXAPI, SyntheticAXElement) {
    let api = SyntheticAXAPI(identity: axFixtureProcess)
    let focused = window ?? SyntheticAXElement("focused-window")
    api.applicationElement.attributes["AXFocusedWindow"] = .element(focused)
    let ids = SyntheticIDSequence()
    return (ApplicationServicesMacAccessibilityPlatform(process: axFixtureProcess,
        applicationName: "Fixture App", api: api, makeID: ids.make), api, focused)
}

@Test func injectedAdapterObservesTypedTreeAndMapsOnlyClosedActions() throws {
    let (platform, _, window) = makeAXPlatform()
    window.attributes["AXTitle"] = .string("Fixture Window")
    window.attributes["AXRole"] = .string("AXWindow")
    window.attributes["AXEnabled"] = .boolean(false)
    window.attributes["AXFocused"] = .boolean(true)
    window.actions = ["AXShowMenu", "unknown-native"]

    let button = SyntheticAXElement("button")
    button.attributes["AXRole"] = .string("AXButton")
    button.attributes["AXDescription"] = .string("Continue")
    button.actions = ["AXPress", "AXConfirm", "AXCancel", "AXIncrement", "AXDecrement"]
    button.settableValue = true
    let secure = SyntheticAXElement("secure")
    secure.attributes["AXRole"] = .string("AXSecureTextField")
    let hiddenChild = SyntheticAXElement("hidden-child")
    hiddenChild.attributes["AXRole"] = .string("AXButton")
    secure.attributes["AXChildren"] = .elements([hiddenChild])
    window.attributes["AXChildren"] = .elements([button, secure])

    let observation = try platform.observe(requiredWindowID: nil, now: axFixtureNow)
    #expect(observation.binding.windowID == "window_1")
    #expect(observation.binding.observationID == "observation_2")
    #expect(observation.windowTitle == "Fixture Window")
    #expect(observation.nodes.count == 2)
    #expect(observation.nodes[0].role == "AXWindow")
    #expect(observation.nodes[0].enabled == false)
    #expect(observation.nodes[0].focused == true)
    #expect(observation.nodes[0].actions == ["show_menu"])
    #expect(observation.nodes[1].label == "Continue")
    #expect(observation.nodes[1].enabled == true)
    #expect(observation.nodes[1].focused == false)
    #expect(observation.nodes[1].actions ==
        ["cancel", "confirm", "decrement", "increment", "press", "set_value"])
}

@Test func injectedAdapterRequiresExactLiveProcessAndFocusedWindowBinding() throws {
    let (platform, api, window) = makeAXPlatform()
    window.attributes["AXRole"] = .string("AXWindow")
    let initial = try platform.observe(requiredWindowID: nil, now: axFixtureNow)
    let refreshed = try platform.observe(requiredWindowID: initial.binding.windowID, now: axFixtureNow)
    #expect(refreshed.binding.windowID == initial.binding.windowID)

    #expect(throws: LocalProgramError.staleTarget) {
        try platform.observe(requiredWindowID: "window_wrong", now: axFixtureNow)
    }
    api.applicationElement.attributes["AXFocusedWindow"] = .string("not-an-element")
    #expect(throws: LocalProgramError.staleTarget) {
        try platform.observe(requiredWindowID: initial.binding.windowID, now: axFixtureNow)
    }
    api.applicationElement.attributes["AXFocusedWindow"] = .element(SyntheticAXElement("other-window"))
    #expect(throws: LocalProgramError.staleTarget) {
        try platform.observe(requiredWindowID: initial.binding.windowID, now: axFixtureNow)
    }
    api.identity = nil
    #expect(throws: LocalProgramError.staleTarget) { try platform.validateProcess() }

    let unboundAPI = SyntheticAXAPI(identity: axFixtureProcess)
    unboundAPI.applicationElement.attributes["AXFocusedWindow"] = .element(window)
    let ids = SyntheticIDSequence()
    let unbound = ApplicationServicesMacAccessibilityPlatform(process: axFixtureProcess,
        applicationName: "Fixture", api: unboundAPI, makeID: ids.make)
    #expect(throws: LocalProgramError.staleTarget) {
        try unbound.observe(requiredWindowID: "untrusted-caller-id", now: axFixtureNow)
    }
}

@Test func injectedAdapterBoundsTraversalAndDefaultsMalformedAttributes() throws {
    let (platform, _, window) = makeAXPlatform()
    window.attributes["AXTitle"] = .boolean(true)
    window.attributes["AXRole"] = .boolean(true)
    window.attributes["AXEnabled"] = .string("not-a-boolean")
    var current = window
    for index in 1...10 {
        let child = SyntheticAXElement("depth-\(index)")
        child.attributes["AXRole"] = .string("AXGroup")
        current.attributes["AXChildren"] = .elements([child])
        current = child
    }
    let observation = try platform.observe(requiredWindowID: nil, now: axFixtureNow)
    #expect(observation.windowTitle == "Untitled")
    #expect(observation.nodes.first?.role == "AXUnknown")
    #expect(observation.nodes.first?.enabled == true)
    #expect(observation.nodes.count == ObservationBounds.maxDepth + 1)

    let wideWindow = SyntheticAXElement("wide-window")
    wideWindow.attributes["AXRole"] = .string("AXWindow")
    wideWindow.attributes["AXChildren"] = .elements((0..<140).map { index in
        let child = SyntheticAXElement("wide-\(index)")
        child.attributes["AXRole"] = .string("AXButton")
        return child
    })
    let (widePlatform, _, _) = makeAXPlatform(window: wideWindow)
    let wide = try widePlatform.observe(requiredWindowID: nil, now: axFixtureNow)
    #expect(wide.nodes.count == ObservationBounds.maxNodes)
}

@Test func injectedAdapterValidatesHandlesValuesAndSanitizesSystemFailures() throws {
    let (platform, api, window) = makeAXPlatform()
    window.attributes["AXRole"] = .string("AXButton")
    window.actions = ["AXPress"]
    window.settableValue = true
    let observation = try platform.observe(requiredWindowID: nil, now: axFixtureNow)
    let node = try #require(observation.nodes.first)

    #expect(throws: LocalProgramError.unknownHandle) {
        try platform.perform(.init(action: "press", handle: "missing",
            observationID: observation.binding.observationID), executionID: "exec",
            sequence: 1, now: axFixtureNow)
    }
    #expect(throws: LocalProgramError.unknownHandle) {
        try platform.perform(.init(action: "press", handle: node.handle,
            observationID: "wrong"), executionID: "exec", sequence: 1, now: axFixtureNow)
    }
    #expect(throws: LocalProgramError.unknownHandle) {
        try platform.perform(.init(action: "press", handle: node.handle,
            observationID: observation.binding.observationID), executionID: "exec",
            sequence: 1, now: observation.binding.expiresAt)
    }
    #expect(throws: LocalProgramError.unsupportedAction) {
        try platform.perform(.init(action: "set_value", handle: node.handle,
            observationID: observation.binding.observationID), executionID: "exec",
            sequence: 1, now: axFixtureNow)
    }
    #expect(throws: LocalProgramError.unsupportedAction) {
        try platform.perform(.init(action: "set_value", handle: node.handle,
            observationID: observation.binding.observationID,
            value: String(repeating: "x", count: 4_097)), executionID: "exec",
            sequence: 1, now: axFixtureNow)
    }
    #expect(throws: LocalProgramError.unsupportedAction) {
        try platform.perform(.init(action: "confirm", handle: node.handle,
            observationID: observation.binding.observationID), executionID: "exec",
            sequence: 1, now: axFixtureNow)
    }

    api.performSucceeds = false
    #expect(throws: LocalProgramError.executionFailed("Accessibility action failed")) {
        try platform.perform(.init(action: "press", handle: node.handle,
            observationID: observation.binding.observationID), executionID: "exec",
            sequence: 1, now: axFixtureNow)
    }
    api.performSucceeds = true
    let resource = try platform.perform(.init(action: "press", handle: node.handle,
        observationID: observation.binding.observationID), executionID: "exec",
        sequence: 2, now: axFixtureNow)
    #expect(resource?.hasPrefix("ax_") == true)
    #expect(api.performed.last?.0 == "AXPress")
    #expect(throws: LocalProgramError.unknownHandle) {
        try platform.perform(.init(action: "press", handle: node.handle,
            observationID: observation.binding.observationID), executionID: "exec",
            sequence: 3, now: axFixtureNow)
    }
}

@Test func injectedAdapterSetValueUsesOnlyCheckedStringSetter() throws {
    let (platform, api, window) = makeAXPlatform()
    window.attributes["AXRole"] = .string("AXTextField")
    window.settableValue = true
    var observation = try platform.observe(requiredWindowID: nil, now: axFixtureNow)
    var node = try #require(observation.nodes.first)
    api.setSucceeds = false
    #expect(throws: LocalProgramError.executionFailed("Accessibility action failed")) {
        try platform.perform(.init(action: "set_value", handle: node.handle,
            observationID: observation.binding.observationID, value: "new value"),
            executionID: "exec", sequence: 1, now: axFixtureNow)
    }

    api.setSucceeds = true
    _ = try platform.perform(.init(action: "set_value", handle: node.handle,
        observationID: observation.binding.observationID, value: "new value"),
        executionID: "exec", sequence: 2, now: axFixtureNow)
    #expect(api.valuesSet.last?.0 == "new value")
    #expect(api.valuesSet.last?.1 == "AXValue")

    observation = try platform.observe(requiredWindowID: observation.binding.windowID,
                                       now: axFixtureNow)
    node = try #require(observation.nodes.first)
    window.settableValue = false
    let newObservation = try platform.observe(requiredWindowID: observation.binding.windowID,
                                              now: axFixtureNow)
    let newNode = try #require(newObservation.nodes.first)
    #expect(throws: LocalProgramError.unsupportedAction) {
        try platform.perform(.init(action: "set_value", handle: newNode.handle,
            observationID: newObservation.binding.observationID, value: "denied"),
            executionID: "exec", sequence: 3, now: axFixtureNow)
    }
    _ = node
}
#endif
