#if os(macOS)
import AppKit
import MoaMacCore
import MoaMacShell
import SwiftUI

public struct StatusView: View {
    @StateObject private var model: SurfaceModel
    public init() {
        _model = StateObject(wrappedValue: SurfaceModel())
    }
    init(model: SurfaceModel) {
        _model = StateObject(wrappedValue: model)
    }
    public var body: some View { Form {
        Text("Ag").font(.title); Text(model.status); Text("Scope: \(model.appName)")
        GroupBox("Voice") {
            HStack {
                Text("Dictation uses Microphone access only.")
                Spacer()
                Button("Open Microphone Settings") { openMicrophoneSettings() }
            }
        }
        GroupBox("Optional screen context") {
            HStack {
                Button("Select frontmost app") { model.selectFrontmost() }
                Button("Enable Accessibility") { model.requestAccessibility() }
                Button("Enable optional Screen Recording") { model.requestScreenRecording() }
            }
            Text("These permissions are never required for literal dictation.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        TextField("Canonical gateway origin (no default)", text: $model.origin).textFieldStyle(.roundedBorder)
        Picker("Release", selection: $model.mode) { Text("Local only").tag(ReleaseMode.localOnly); Text("Ask each time").tag(ReleaseMode.askEachTime); Text("Trust server for 15m").tag(ReleaseMode.trustedServer15m) }
        SecureField("Gateway session token (memory only)", text: $model.token).textFieldStyle(.roundedBorder)
        HStack { Button("Use for this session") { model.useConnectionForSession() }; Button("Clear session token") { model.clearSessionCredential() } }
        Toggle("Attach focused-window screenshot for this grant", isOn: $model.screenshot)
        HStack { Button("Start 15 minutes") { Task { await model.start() } }; Button("Pause") { Task { await model.pause() } }; Button("Resume") { model.resume() }; Button("Stop") { Task { await model.stop() } } }
        if !model.suggestion.isEmpty { GroupBox("Suggestion (inert)") { Text(model.suggestion).textSelection(.enabled) } }
        Text("Permissions alone never start observation. Screenshot capture is optional and scoped to the selected app's focused window.").font(.caption)
    }.padding().frame(minWidth: 720, minHeight: 500) }

    private func openMicrophoneSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") else { return }
        NSWorkspace.shared.open(url)
    }
}
#endif
