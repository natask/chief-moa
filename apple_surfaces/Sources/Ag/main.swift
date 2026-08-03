#if os(macOS)
import AppKit
import Carbon.HIToolbox
import Combine
import CoreGraphics
import Darwin
import MoaMacCore
import MoaMacShell
import MoaMacUI
import SwiftUI

private let usesIsolatedQASpace = CommandLine.arguments.contains("--isolated-qa-space")

private final class CommandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        // The controller owns a physical-screen-safe frame. AppKit otherwise
        // pushes a notch panel down to visibleFrame when it is ordered front.
        frameRect
    }
}

private final class AgentRailPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor final class AgentRailPanelController {
    static let shared = AgentRailPanelController()
    private var panel: AgentRailPanel?

    func sync(model: CommandModel) {
        guard !model.agentRuns.isEmpty else {
            panel?.orderOut(nil)
            return
        }
        let count = min(model.agentRuns.count, 6)
        let size = NSSize(width: 70, height: CGFloat(20 + count * 56))
        let panel = panel ?? makePanel(model: model, size: size)
        panel.setContentSize(size)
        position(panel)
        panel.orderFrontRegardless()
    }

    private func makePanel(model: CommandModel, size: NSSize) -> AgentRailPanel {
        let view = AgentRailView(model: model) { CommandPanelController.shared.invokeAgents() }
        let panel = AgentRailPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentView = NSHostingView(rootView: view)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = usesIsolatedQASpace
            ? [.moveToActiveSpace, .fullScreenAuxiliary]
            : [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        self.panel = panel
        return panel
    }

    private func position(_ panel: NSPanel) {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        panel.setFrameOrigin(NSPoint(
            x: frame.maxX - panel.frame.width - 12,
            y: frame.midY - panel.frame.height / 2
        ))
    }
}

@MainActor final class CommandPanelController {
    static let shared = CommandPanelController()
    private let model = CommandModel()
    private let presentation = PanelPresentationModel()
    private var panel: CommandPanel?
    private var previousApplication: NSRunningApplication?
    private(set) var shortcutLabel = "Control-Space"
    private var screenObserver: NSObjectProtocol?
    private var presentationObserver: AnyCancellable?

    func setShortcutLabel(_ value: String) { shortcutLabel = value }

    func invoke() {
        let wasActive = model.voiceState.isActive
        NSHapticFeedbackManager.defaultPerformer.perform(
            wasActive ? .levelChange : .alignment,
            performanceTime: .now
        )
        show()
        Task { await model.handleSummon() }
    }

    func invokeDictation() {
        let wasActive = model.voiceState.isActive
        NSHapticFeedbackManager.defaultPerformer.perform(
            wasActive ? .levelChange : .alignment,
            performanceTime: .now
        )
        show()
        Task { await model.handleDictation() }
    }

    func invokeAgents() {
        model.showAgents()
        presentation.handle(.open)
        show()
    }

    func refreshAgentSurfaces() async {
        await model.refreshAgentRuns()
        AgentRailPanelController.shared.sync(model: model)
    }

    func runGeometrySmoke() -> Bool {
        let panel = panel ?? makePanel()
        presentation.handle(.collapse)
        position(panel)
        let compactExpected = panel.frame
        panel.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        let compactActual = panel.frame
        presentation.handle(.open)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        let expandedActual = panel.frame
        presentation.handle(.collapse)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        let compactAgain = panel.frame
        panel.orderOut(nil)
        let stable = compactActual == compactExpected
            && compactAgain == compactExpected
            && expandedActual.midX == compactExpected.midX
            && expandedActual.maxY == compactExpected.maxY
        print("Ag geometry smoke: compact=\(NSStringFromRect(compactActual)) expanded=\(NSStringFromRect(expandedActual)) compact_again=\(NSStringFromRect(compactAgain)) stable=\(stable)")
        return stable
    }

    func show() {
        let panel = panel ?? makePanel()
        position(panel)
        let current = NSRunningApplication.current
        let frontmost = NSWorkspace.shared.frontmostApplication
        if frontmost?.processIdentifier != current.processIdentifier { previousApplication = frontmost }
        panel.orderFrontRegardless()
    }

    func hide() {
        NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .now)
        Task {
            await model.cancelVoice()
            presentation.handle(.collapse)
            panel?.orderOut(nil)
            previousApplication?.activate(options: [])
            previousApplication = nil
        }
    }

    private func makePanel() -> CommandPanel {
        let view = CommandPaletteView(
            model: model,
            presentation: presentation,
            shortcutLabel: shortcutLabel
        ) { [weak self] in self?.hide() }
        let hosting = NSHostingView(rootView: view)
        let panel = CommandPanel(
            contentRect: NSRect(origin: .zero, size: PanelPresentationMetrics.compactSize),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.contentView = hosting
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.collectionBehavior = usesIsolatedQASpace
            ? [.moveToActiveSpace, .fullScreenAuxiliary]
            : [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isReleasedWhenClosed = false
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, let panel = self.panel else { return }
                self.position(panel)
            }
        }
        presentationObserver = presentation.$state
            .removeDuplicates()
            .sink { [weak self, weak panel] state in
                Task { @MainActor in
                    guard let self, let panel else { return }
                    await Task.yield()
                    self.resize(panel, expanded: state.isExpanded)
                }
            }
        self.panel = panel
        return panel
    }

    private func resize(_ panel: NSPanel, expanded: Bool) {
        let size = expanded ? PanelPresentationMetrics.expandedSize : PanelPresentationMetrics.compactSize
        if panel.frame.size != size {
            panel.setFrame(NSRect(origin: panel.frame.origin, size: size), display: true, animate: false)
        }
        position(panel)
    }

    private func position(_ panel: NSPanel) {
        let screensByID: [UInt32: NSScreen] = Dictionary(uniqueKeysWithValues: NSScreen.screens.compactMap { screen in
            displayID(for: screen).map { ($0, screen) }
        })
        let descriptors = screensByID.map { entry in
            let (id, screen) = entry
            return PanelScreenDescriptor(
                id: id,
                safeAreaTop: screen.safeAreaInsets.top,
                isBuiltInDisplay: CGDisplayIsBuiltin(CGDirectDisplayID(id)) != 0
            )
        }
        let targetID = PanelScreenSelectionPolicy.targetDisplayID(
            screens: descriptors,
            mainDisplayID: NSScreen.main.flatMap { displayID(for: $0) }
        )
        let screen = targetID.flatMap { screensByID[$0] } ?? NSScreen.main ?? NSScreen.screens.first
        guard let screen else { panel.center(); return }
        let cgDisplayID = displayID(for: screen).map { CGDirectDisplayID($0) }
        let decision = PanelLayoutPolicy.decision(for: PanelLayoutInput(
            screenFrame: screen.frame,
            visibleFrame: screen.visibleFrame,
            panelSize: panel.frame.size,
            safeAreaTop: screen.safeAreaInsets.top,
            isBuiltInDisplay: cgDisplayID.map { CGDisplayIsBuiltin($0) != 0 } ?? false
        ))
        guard let decision else { panel.center(); return }
        applyPanelOrigin(decision.origin, to: panel)
    }

    private func displayID(for screen: NSScreen) -> UInt32? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    private func applyPanelOrigin(_ origin: NSPoint, to panel: NSPanel) {
        panel.setFrameOrigin(origin)
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var agentRefreshTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        registerHotKey()
        CommandPanelController.shared.invoke()
        Task { await CommandPanelController.shared.refreshAgentSurfaces() }
        agentRefreshTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { _ in
            Task { @MainActor in await CommandPanelController.shared.refreshAgentSurfaces() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let handler { RemoveEventHandler(handler) }
        agentRefreshTimer?.invalidate()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        CommandPanelController.shared.invoke()
        return false
    }

    private func registerHotKey() {
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let handlerStatus = InstallEventHandler(GetApplicationEventTarget(), { _, carbonEvent, _ in
            guard let carbonEvent else { return noErr }
            var identifier = EventHotKeyID()
            let status = GetEventParameter(carbonEvent, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                           MemoryLayout<EventHotKeyID>.size, nil, &identifier)
            guard status == noErr, identifier.signature == OSType(0x4D4F4143), identifier.id == 1 else { return status }
            Task { @MainActor in CommandPanelController.shared.invoke() }
            return noErr
        }, 1, &event, nil, &handler)
        guard handlerStatus == noErr else {
            CommandPanelController.shared.setShortcutLabel("Use the menu bar")
            return
        }
        let signature = OSType(0x4D4F4143) // MOAC
        let identifier = EventHotKeyID(signature: signature, id: 1)
        let primary = RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey), identifier, GetApplicationEventTarget(), 0, &hotKey)
        if primary == noErr { return }
        hotKey = nil
        let fallback = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), identifier, GetApplicationEventTarget(), 0, &hotKey)
        if fallback == noErr {
            CommandPanelController.shared.setShortcutLabel("Option-Space")
        } else {
            CommandPanelController.shared.setShortcutLabel("Use the menu bar")
        }
    }
}

struct AgApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Ag", systemImage: "sparkles") {
            Button("Speak with Ag") { CommandPanelController.shared.invoke() }
                .keyboardShortcut(" ", modifiers: .control)
            Button("Dictate literal text") { CommandPanelController.shared.invokeDictation() }
            Button("Agents") { CommandPanelController.shared.invokeAgents() }
            SettingsLink { Text("Privacy & Screen Context…") }
            Divider()
            Button("Quit Ag") { NSApp.terminate(nil) }
        }
        Settings { StatusView() }
    }
}

@main
enum AgMain {
    static func main() {
        if CommandLine.arguments.contains("--window-geometry-smoke") {
            Darwin.exit(CommandPanelController.shared.runGeometrySmoke() ? EXIT_SUCCESS : EXIT_FAILURE)
        }
        if CommandLine.arguments.contains("--coverage-smoke") {
            _ = AgApp().body
            return
        }
        AgApp.main()
    }
}
#else
import Foundation

@main
enum AgUnavailable {
    static func main() { print("Ag requires macOS") }
}
#endif
