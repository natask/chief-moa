#if os(macOS)
import AppKit
import Carbon.HIToolbox
import MoaMacShell
import MoaMacUI
import SwiftUI

private final class CommandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor final class CommandPanelController {
    static let shared = CommandPanelController()
    private let model = CommandModel()
    private var panel: CommandPanel?
    private var previousApplication: NSRunningApplication?
    private(set) var shortcutLabel = "Control-Space"

    func setShortcutLabel(_ value: String) { shortcutLabel = value }

    func toggle() { panel?.isVisible == true ? hide() : show() }

    func show() {
        let panel = panel ?? makePanel()
        position(panel)
        let current = NSRunningApplication.current
        let frontmost = NSWorkspace.shared.frontmostApplication
        if frontmost?.processIdentifier != current.processIdentifier {
            previousApplication = frontmost
            model.captureInsertionTargetBeforeFocus()
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func hide() {
        panel?.orderOut(nil)
        previousApplication?.activate(options: [])
        previousApplication = nil
    }

    private func makePanel() -> CommandPanel {
        let view = CommandPaletteView(model: model, shortcutLabel: shortcutLabel) { [weak self] in self?.hide() }
        let hosting = NSHostingView(rootView: view)
        let panel = CommandPanel(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 420),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.contentView = hosting
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isReleasedWhenClosed = false
        self.panel = panel
        return panel
    }

    private func position(_ panel: NSPanel) {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { panel.center(); return }
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2 + 80))
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        registerHotKey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let handler { RemoveEventHandler(handler) }
    }

    private func registerHotKey() {
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let handlerStatus = InstallEventHandler(GetApplicationEventTarget(), { _, carbonEvent, _ in
            guard let carbonEvent else { return noErr }
            var identifier = EventHotKeyID()
            let status = GetEventParameter(carbonEvent, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                           MemoryLayout<EventHotKeyID>.size, nil, &identifier)
            guard status == noErr, identifier.signature == OSType(0x4D4F4143), identifier.id == 1 else { return status }
            Task { @MainActor in CommandPanelController.shared.toggle() }
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

struct MoaMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Aggie", systemImage: "sparkles") {
            Button("Open Aggie") { CommandPanelController.shared.show() }
                .keyboardShortcut(" ", modifiers: .control)
            SettingsLink { Text("Privacy & Screen Context…") }
            Divider()
            Button("Quit Moa Mac") { NSApp.terminate(nil) }
        }
        Settings { StatusView() }
    }
}

@main
enum MoaMacMain {
    static func main() {
        if CommandLine.arguments.contains("--coverage-smoke") {
            _ = MoaMacApp().body
            return
        }
        MoaMacApp.main()
    }
}
#else
import Foundation

@main
enum MoaMacUnavailable {
    static func main() { print("MoaMac requires macOS") }
}
#endif
