#if os(macOS)
import MoaMacCore
import MoaMacShell
import SwiftUI

public struct StatusView: View {
    public init() {}
    @StateObject private var model = SurfaceModel()
    public var body: some View { Form {
        Text("Moa Mac").font(.title); Text(model.status); Text("Scope: \(model.appName)")
        HStack { Button("Select frontmost app") { model.selectFrontmost() }; Button("Enable Accessibility") { model.requestAccessibility() }; Button("Enable Screen Recording") { model.requestScreenRecording() } }
        TextField("Canonical gateway origin (no default)", text: $model.origin).textFieldStyle(.roundedBorder)
        Picker("Release", selection: $model.mode) { Text("Local only").tag(ReleaseMode.localOnly); Text("Ask each time").tag(ReleaseMode.askEachTime); Text("Trust server for 15m").tag(ReleaseMode.trustedServer15m) }
        SecureField("Gateway bearer token", text: $model.token).textFieldStyle(.roundedBorder)
        HStack { Button("Save token in Keychain") { model.saveToken() }; Button("Delete token") { model.deleteToken() } }
        Toggle("Attach focused-window screenshot for this grant", isOn: $model.screenshot)
        HStack { Button("Start 15 minutes") { Task { await model.start() } }; Button("Pause") { Task { await model.pause() } }; Button("Resume") { model.resume() }; Button("Stop") { Task { await model.stop() } } }
        if !model.suggestion.isEmpty { GroupBox("Suggestion (inert)") { Text(model.suggestion).textSelection(.enabled) } }
        Text("Permissions alone never start observation. Screenshot capture is optional and scoped to the selected app's focused window.").font(.caption)
    }.padding().frame(minWidth: 720, minHeight: 500) }
}
#endif
