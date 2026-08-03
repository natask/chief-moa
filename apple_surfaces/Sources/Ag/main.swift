#if os(macOS)
import AppKit
import Carbon.HIToolbox
import Combine
import CoreGraphics
import MoaMacCore
import MoaMacShell
import MoaMacUI
import SwiftUI

private final class CommandPanel: NSPanel {
    var interactionHandler: (() -> Void)?
    private(set) var isProcessingPointerInteraction = false
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown || event.type == .rightMouseDown || event.type == .otherMouseDown {
            isProcessingPointerInteraction = true
        }
        super.sendEvent(event)
        if event.type == .leftMouseUp || event.type == .rightMouseUp || event.type == .otherMouseUp {
            interactionHandler?()
            isProcessingPointerInteraction = false
        }
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
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
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
    private var isApplyingPanelPosition = false
    private var moveObserver: NSObjectProtocol?
    private var focusObserver: NSObjectProtocol?
    private var presentationObserver: AnyCancellable?
    private let panelAnchorXKey = "ag.command-panel.anchor-center-x"
    private let panelAnchorYKey = "ag.command-panel.anchor-top-y"

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
        show()
    }

    func refreshAgentSurfaces() async {
        await model.refreshAgentRuns()
        AgentRailPanelController.shared.sync(model: model)
    }

    func resetPanelPosition() {
        UserDefaults.standard.removeObject(forKey: panelAnchorXKey)
        UserDefaults.standard.removeObject(forKey: panelAnchorYKey)
        if let panel { position(panel, preferSaved: false) }
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
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isMovable = true
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.interactionHandler = { [weak self] in self?.presentation.handle(.interacted) }
        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: panel,
            queue: .main
        ) { [weak self, weak panel] _ in
            Task { @MainActor in
                guard let self, let panel, !self.isApplyingPanelPosition else { return }
                UserDefaults.standard.set(panel.frame.midX, forKey: self.panelAnchorXKey)
                UserDefaults.standard.set(panel.frame.maxY, forKey: self.panelAnchorYKey)
            }
        }
        focusObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: panel,
            queue: .main
        ) { [weak self, weak panel] _ in
            Task { @MainActor in
                guard panel?.isProcessingPointerInteraction != true else { return }
                self?.presentation.handle(.gainedFocus)
            }
        }
        presentationObserver = presentation.$state
            .removeDuplicates()
            .sink { [weak self, weak panel] state in
                guard let self, let panel else { return }
                self.resize(panel, expanded: state.isExpanded)
            }
        self.panel = panel
        return panel
    }

    private func resize(_ panel: NSPanel, expanded: Bool) {
        let size = expanded ? PanelPresentationMetrics.expandedSize : PanelPresentationMetrics.compactSize
        guard panel.frame.size != size else { return }
        let current = panel.frame
        let origin = NSPoint(x: current.midX - size.width / 2, y: current.maxY - size.height)
        isApplyingPanelPosition = true
        panel.setFrame(NSRect(origin: origin, size: size), display: true, animate: true)
        isApplyingPanelPosition = false
    }

    private func position(_ panel: NSPanel, preferSaved: Bool = true) {
        if preferSaved, let saved = savedPanelOrigin(for: panel) {
            applyPanelOrigin(saved, to: panel)
            return
        }
        let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main
        guard let screen else { panel.center(); return }
        let displayID = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)
            .map { CGDirectDisplayID($0.uint32Value) }
        let decision = PanelLayoutPolicy.decision(for: PanelLayoutInput(
            screenFrame: screen.frame,
            visibleFrame: screen.visibleFrame,
            panelSize: panel.frame.size,
            safeAreaTop: screen.safeAreaInsets.top,
            isBuiltInDisplay: displayID.map { CGDisplayIsBuiltin($0) != 0 } ?? false
        ))
        guard let decision else { panel.center(); return }
        applyPanelOrigin(decision.origin, to: panel)
    }

    private func savedPanelOrigin(for panel: NSPanel) -> NSPoint? {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: panelAnchorXKey) != nil,
              defaults.object(forKey: panelAnchorYKey) != nil else { return nil }
        let origin = NSPoint(
            x: defaults.double(forKey: panelAnchorXKey) - panel.frame.width / 2,
            y: defaults.double(forKey: panelAnchorYKey) - panel.frame.height
        )
        let frame = NSRect(origin: origin, size: panel.frame.size)
        return NSScreen.screens.contains { $0.visibleFrame.intersects(frame) } ? origin : nil
    }

    private func applyPanelOrigin(_ origin: NSPoint, to panel: NSPanel) {
        isApplyingPanelPosition = true
        panel.setFrameOrigin(origin)
        isApplyingPanelPosition = false
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
            Button("Reset panel position") { CommandPanelController.shared.resetPanelPosition() }
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
