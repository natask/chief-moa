#if os(macOS)
import AppKit
import ApplicationServices
import CryptoKit
import Foundation
import MoaMacCore
import ScreenCaptureKit
import Security
import SwiftUI

private enum ProcessInspector {
    static func identity(_ app: NSRunningApplication) -> ProcessIdentity? {
        guard let bundle = app.bundleIdentifier, let launch = app.launchDate, let signing = signingIdentity(pid: app.processIdentifier) else { return nil }
        return ProcessIdentity(bundleID: bundle, pid: app.processIdentifier, processStart: launch,
            signingIdentity: signing)
    }
    static func signingIdentity(pid: pid_t) -> String? {
        var code: SecCode?; let attrs = [kSecGuestAttributePid as String: pid] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?; guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var info: CFDictionary?; guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let values = info as? [String: Any] else { return nil }
        let team = values[kSecCodeInfoTeamIdentifier as String] as? String ?? "adhoc"
        let identifier = values[kSecCodeInfoIdentifier as String] as? String ?? "unknown"
        return "\(team):\(identifier)"
    }
}

private enum KeychainToken {
    static let service = "app.agee.moa-mac.gateway", account = "bearer"
    static func load() -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?; guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ token: String) throws {
        delete(); let data = Data(token.utf8)
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw MoaMacError.missingToken }
    }
    static func delete() { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary) }
}

private final class AXSession: @unchecked Sendable {
    private var observer: AXObserver?; private var fallback: Timer?; private var debounce: DispatchWorkItem?
    private let pid: pid_t; private let changed: () -> Void
    init(pid: pid_t, changed: @escaping () -> Void) { self.pid = pid; self.changed = changed }
    func start() throws {
        let callback: AXObserverCallback = { _, _, _, context in
            guard let context else { return }; Unmanaged<AXSession>.fromOpaque(context).takeUnretainedValue().schedule()
        }
        guard AXObserverCreate(pid, callback, &observer) == .success, let observer else { throw MoaMacError.invalidGrant }
        let app = AXUIElementCreateApplication(pid), context = Unmanaged.passUnretained(self).toOpaque()
        for event in [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification, kAXValueChangedNotification,
                      kAXTitleChangedNotification, kAXUIElementDestroyedNotification] {
            _ = AXObserverAddNotification(observer, app, event as CFString, context)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        fallback = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in self?.schedule() }
        schedule()
    }
    func stop() { debounce?.cancel(); fallback?.invalidate(); fallback = nil; if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }; observer = nil }
    private func schedule() { debounce?.cancel(); let work = DispatchWorkItem { [weak self] in self?.changed() }; debounce = work; DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work) }
    deinit { stop() }
}

private enum AXCapture {
    static func snapshot(pid: pid_t) -> (AXSnapshot, String, CGWindowID?) {
        let app = AXUIElementCreateApplication(pid); var rawWindow: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &rawWindow) == .success, let rawWindow else { return (.init(nodes: [], truncated: false, dropped: 0), "", nil) }
        let window = unsafeDowncast(rawWindow, to: AXUIElement.self)
        let title = string(window, kAXTitleAttribute); var number: CFTypeRef?; AXUIElementCopyAttributeValue(window, "AXWindowNumber" as CFString, &number)
        let sensitiveWindow = ["sign in", "login", "password", "payment", "checkout", "security settings", "keychain", "1password"].contains { title?.localizedCaseInsensitiveContains($0) == true }
        if sensitiveWindow { return (.init(nodes: [], truncated: false, dropped: 1), "[sensitive window suppressed]", nil) }
        var nodes: [AXNode] = [], dropped = 0
        walk(window, parent: nil, depth: 0, nodes: &nodes, dropped: &dropped)
        return (ObservationBounds.snapshot(nodes, dropped: dropped), title ?? "Untitled", (number as? NSNumber).map { CGWindowID($0.uint32Value) })
    }
    private static func walk(_ element: AXUIElement, parent: String?, depth: Int, nodes: inout [AXNode], dropped: inout Int) {
        guard depth <= ObservationBounds.maxDepth, nodes.count < ObservationBounds.maxNodes else { dropped += 1; return }
        let role = string(element, kAXRoleAttribute) ?? "AXUnknown"
        if role == "AXSecureTextField" { dropped += 1; return }
        let id = "n\(nodes.count)", subrole = string(element, kAXSubroleAttribute)
        var editable: DarwinBoolean = false; let isEditable = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &editable) == .success && editable.boolValue
        let label = string(element, kAXTitleAttribute) ?? string(element, kAXDescriptionAttribute) ?? (isEditable ? nil : string(element, kAXValueAttribute))
        var enabled: CFTypeRef?, focused: CFTypeRef?, actions: CFArray?
        AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabled); AXUIElementCopyAttributeValue(element, kAXFocusedAttribute as CFString, &focused); AXUIElementCopyActionNames(element, &actions)
        let actionMap = [kAXPressAction: "press", kAXConfirmAction: "confirm", kAXCancelAction: "cancel", kAXIncrementAction: "increment", kAXDecrementAction: "decrement", kAXShowMenuAction: "show_menu"]
        let semanticActions = ((actions as? [String]) ?? []).compactMap { actionMap[$0] }
        nodes.append(AXNode(id: id, parentID: parent, role: role, subrole: subrole, label: label,
            enabled: (enabled as? Bool) ?? true, focused: (focused as? Bool) ?? false, actions: semanticActions))
        var raw: CFTypeRef?; guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success, let children = raw as? [AXUIElement] else { return }
        for child in children { walk(child, parent: id, depth: depth + 1, nodes: &nodes, dropped: &dropped) }
    }
    private static func string(_ element: AXUIElement, _ attribute: String) -> String? { var raw: CFTypeRef?; guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }; return raw as? String }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
private struct EphemeralTransport: SuggestionTransport {
    func send(preview: RequestPreview, bearerToken: String) async throws -> Data {
        var request = URLRequest(url: preview.url); request.httpMethod = preview.method; request.httpBody = preview.body; request.timeoutInterval = 30
        request.setValue(preview.contentType, forHTTPHeaderField: "Content-Type"); request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        let config = URLSessionConfiguration.ephemeral; config.urlCache = nil; config.httpShouldSetCookies = false
        let (bytes, response) = try await URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil).bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw MoaMacError.invalidResponse }
        var buffer = BoundedResponseBuffer()
        for try await byte in bytes { try buffer.append(byte) }
        return buffer.value
    }
}

private struct WorkspaceScope: ObservationScopeValidator, @unchecked Sendable {
    func validate(process: ProcessIdentity, observation: Observation, focusedWindowID: UInt32?) async -> Bool {
        await MainActor.run {
            guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier == process.pid,
                  ProcessInspector.identity(front) == process else { return false }
            let current = AXCapture.snapshot(pid: process.pid)
            return current.2 == focusedWindowID
        }
    }
}

@available(macOS 14.0, *) private enum WindowCapture {
    static func capture(id: CGWindowID, pid: pid_t) async throws -> ScreenshotEvidence {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == pid }) else { throw MoaMacError.scopeChanged }
        let filter = SCContentFilter(desktopIndependentWindow: window), config = SCStreamConfiguration()
        let scale = min(1, 1280 / max(window.frame.width, window.frame.height)); config.width = max(1, Int(window.frame.width * scale)); config.height = max(1, Int(window.frame.height * scale))
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let rep = NSBitmapImageRep(cgImage: image); guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72]), jpeg.count <= ObservationBounds.maxScreenshotBytes else { throw MoaMacError.tooLarge }
        return .init(dataBase64: jpeg.base64EncodedString(), sha256: SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined(), width: image.width, height: image.height)
    }
}

@MainActor private final class UIApprover: PreviewApprover, @unchecked Sendable {
    func approve(_ preview: RequestPreview) async throws -> String {
        let alert = NSAlert(); alert.messageText = "Release this exact observation?"
        alert.informativeText = "POST \(preview.url.absoluteString)\nContent-Type: \(preview.contentType)\nRedirect: error\nBody SHA-256: \(preview.bodySHA256)\n\n\(String(data: preview.body, encoding: .utf8) ?? "")\n\nExcluded: secure/editable values, coordinates, local AX references. Retention is controlled by your Chief Moa server."
        alert.addButton(withTitle: "Send exact body"); alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { throw MoaMacError.cancelled }; return preview.bodySHA256
    }
}

@MainActor final class SurfaceModel: ObservableObject {
    @Published var status = "Stopped — no observation or network"
    @Published var origin = ""
    @Published var token = ""
    @Published var screenshot = false
    @Published var paused = true
    @Published var mode: ReleaseMode = .localOnly; @Published var appName = "No app selected"; @Published var suggestion = ""
    private let grants = GrantStore(); private lazy var coordinator = SuggestionCoordinator(grants: grants)
    private var identity: ProcessIdentity?; private var observer: AXSession?; private var task: Task<Void, Never>?; private var generation: UInt64 = 0
    init() { token = KeychainToken.load() ?? "" }
    func selectFrontmost() {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              let value = ProcessInspector.identity(app) else { status = "Could not select frontmost app"; return }
        identity = value; appName = app.localizedName ?? value.bundleID; status = "Selected \(appName); not observing"
    }
    func requestAccessibility() { _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary); status = "Accessibility permission requested; still not observing" }
    func requestScreenRecording() { CGRequestScreenCaptureAccess(); status = "Screen Recording permission requested; still not capturing" }
    func saveToken() { do { guard !token.isEmpty else { throw MoaMacError.missingToken }; try KeychainToken.save(token); status = "Token saved in Keychain" } catch { status = "Token save failed" } }
    func deleteToken() { KeychainToken.delete(); token = ""; status = "Token deleted from Keychain" }
    func start() async {
        generation &+= 1; let requestedGeneration = generation; task?.cancel(); observer?.stop(); observer = nil
        guard AXIsProcessTrusted(), let identity, let live = NSRunningApplication(processIdentifier: identity.pid), ProcessInspector.identity(live) == identity else { status = "Select a live app and enable Accessibility first"; return }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == identity.pid else { status = "Selected app must be frontmost when starting"; return }
        let destination: URL? = mode == .localOnly ? nil : URL(string: origin)
        do {
            if let destination { _ = try DestinationPolicy.endpoint(origin: destination) }
            if mode == .trustedServer15m {
                let alert = NSAlert(); alert.messageText = "Trust this Chief Moa server for 15 minutes?"
                alert.informativeText = "Origin: \(destination?.absoluteString ?? "invalid")\nEvidence: bounded Accessibility tree and window title\nFocused-window screenshot: \(screenshot ? "included" : "excluded")\nExpires: 15 minutes or immediately on Pause/Stop/scope change."
                alert.addButton(withTitle: "Trust for 15 minutes"); alert.addButton(withTitle: "Cancel")
                guard alert.runModal() == .alertFirstButtonReturn else { status = "Start cancelled — no observation or network"; return }
            }
            let now = Date(), grant = try ObservationGrant(process: identity, mode: mode, includeScreenshot: screenshot, issuedAt: now, expiresAt: now.addingTimeInterval(900), destinationOrigin: destination)
            await grants.start(grant)
            guard generation == requestedGeneration else { await grants.stop(); return }
            observer?.stop(); observer = AXSession(pid: identity.pid) { [weak self] in self?.refresh() }; try? observer?.start()
            paused = false; status = "Active for 15 minutes — \(appName), \(mode.rawValue)"; refresh()
        } catch { status = "Cannot start: invalid gateway origin or grant" }
    }
    func pause() async { generation &+= 1; observer?.stop(); observer = nil; task?.cancel(); task = nil; await coordinator.cancel(); await grants.stop(); paused = true; status = "Paused and revoked — press Start again for a new grant" }
    func resume() { status = "Pause revoked the grant — press Start again" }
    func stop() async { generation &+= 1; observer?.stop(); observer = nil; task?.cancel(); task = nil; await coordinator.cancel(); await grants.stop(); paused = true; suggestion = ""; status = "Stopped — context purged" }
    private func refresh() {
        guard !paused, let identity, let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier == identity.pid, ProcessInspector.identity(front) == identity else { Task { await stop() }; return }
        task?.cancel(); task = Task { [weak self] in
            guard let self else { return }
            guard let grant = try? await grants.current(now: Date(), process: identity) else { await stop(); return }
            let captured = AXCapture.snapshot(pid: identity.pid)
            var image: ScreenshotEvidence? = nil
            if grant.includeScreenshot, let window = captured.2 { image = try? await WindowCapture.capture(id: window, pid: identity.pid) }
            guard let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier == identity.pid, ProcessInspector.identity(front) == identity,
                  AXCapture.snapshot(pid: identity.pid).2 == captured.2 else { await stop(); return }
            guard !Task.isCancelled else { return }
            let observation = Observation(observationID: UUID().uuidString, capturedAt: Date(), app: .init(bundleID: identity.bundleID, name: appName), window: .init(title: captured.1), ax: captured.0, screenshot: image)
            do {
                let result = try await coordinator.suggest(observation: observation, process: identity, origin: mode == .localOnly ? nil : URL(string: origin), token: token, now: Date.init,
                    approver: mode == .askEachTime ? UIApprover() : nil, transport: mode == .localOnly ? nil : EphemeralTransport(), scope: WorkspaceScope(), focusedWindowID: captured.2)
                suggestion = result.suggestion; status = "Active — suggestion ready (inert)"
            } catch is CancellationError { } catch { status = "Active — suggestion withheld: \(error)" }
        }
    }
}

struct StatusView: View {
    @StateObject private var model = SurfaceModel()
    var body: some View { Form {
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

@main struct MoaMacApp: App { var body: some Scene { WindowGroup { StatusView() } } }
#else
import Foundation
@main enum MoaMacUnavailable { static func main() { print("MoaMac requires macOS") } }
#endif
