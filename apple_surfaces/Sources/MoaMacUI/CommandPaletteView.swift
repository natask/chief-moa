#if os(macOS)
import AppKit
import MoaMacCore
import MoaMacShell
import SwiftUI

public struct CommandPaletteView: View {
    @ObservedObject private var model: CommandModel
    @ObservedObject private var presentation: PanelPresentationModel
    private let dismiss: () -> Void
    private let shortcutLabel: String
    @FocusState private var promptFocused: Bool
    @State private var editingConnection = false
    @State private var showingBrowserHandoff = false
    @State private var boundaryPulse = false

    public init(
        model: CommandModel,
        presentation: PanelPresentationModel = PanelPresentationModel(),
        shortcutLabel: String = "Control-Space",
        dismiss: @escaping () -> Void = {}
    ) {
        self.model = model
        self.presentation = presentation
        self.shortcutLabel = shortcutLabel
        self.dismiss = dismiss
    }

    public var body: some View {
        Group {
            if presentation.isExpanded { expandedSurface }
            else { compactSurface }
        }
        .frame(
            width: presentation.isExpanded ? PanelPresentationMetrics.expandedSize.width : PanelPresentationMetrics.compactSize.width,
            height: presentation.isExpanded ? PanelPresentationMetrics.expandedSize.height : PanelPresentationMetrics.compactSize.height,
            alignment: .top
        )
        .background(Color.black.opacity(0.97), in: RoundedRectangle(cornerRadius: presentation.isExpanded ? 24 : 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: presentation.isExpanded ? 24 : 22, style: .continuous)
                .stroke(boundaryColor, lineWidth: model.voiceState.isActive ? 3 : 1)
                .opacity(boundaryPulse ? 1 : (model.voiceState.isActive ? 0.9 : 0.34))
        )
        .shadow(color: boundaryColor.opacity(model.voiceState.isActive ? 0.42 : 0), radius: 18)
        .animation(.snappy(duration: 0.22), value: model.voiceState.phase)
        .onAppear {
            model.refreshMicrophonePermission()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            model.refreshMicrophonePermission()
        }
        .onChange(of: model.interactionPulse) {
            boundaryPulse = true
            withAnimation(.easeOut(duration: 0.42)) { boundaryPulse = false }
        }
        .onExitCommand(perform: cancelAndDismiss)
    }

    private var compactSurface: some View {
        compactHeader
            .contentShape(Rectangle())
            .onTapGesture {
                guard !model.voiceState.isActive else { return }
                presentation.handle(.open)
            }
    }

    private var expandedSurface: some View {
        VStack(spacing: 0) {
            islandHeader
            if model.panelSection == .agents && !model.voiceState.isActive {
                AgentWorkspaceView(model: model).padding(12)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if model.voiceState.phase == .denied { microphoneRecovery }
                        if editingConnection { connectionEditor }
                        if showingBrowserHandoff { browserHandoff }
                        conversationContent
                        if model.voiceState.isActive {
                            VStack(alignment: .leading, spacing: 8) {
                                Label(model.voiceState.message, systemImage: "waveform")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white.opacity(0.74))
                                VoiceWaveform(levels: model.voiceLevels)
                                    .frame(height: 38)
                                    .accessibilityLabel("Live microphone level")
                            }
                            .transition(.opacity.combined(with: .scale(scale: 0.96)))
                        } else { composer }
                        Text("\(shortcutLabel) toggles voice · Dictate is literal")
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.42))
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 16)
                }
            }
        }
    }

    private var compactHeader: some View {
        HStack(spacing: 11) {
            if model.voiceState.isActive {
                islandButton("Cancel", systemImage: "xmark", tint: .red) {
                    Task { await model.cancelVoice() }
                }
            } else {
                ZStack {
                    Circle().fill(.white.opacity(0.08))
                    Image(systemName: "sparkles")
                        .font(.system(size: 14, weight: .black))
                        .foregroundStyle(.cyan)
                }
                .frame(width: 38, height: 38)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(islandTitle)
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text(compactSubtitle)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.48))
                    .lineLimit(1)
            }
            Spacer(minLength: 6)

            if model.voiceState.isActive {
                islandButton("Finish", systemImage: "checkmark", tint: .orange) {
                    Task { await model.finishVoice() }
                }
            } else {
                if model.runningAgentCount > 0 {
                    Label("\(model.runningAgentCount)", systemImage: "bolt.fill")
                        .font(.caption2.weight(.black))
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 8)
                        .frame(height: 26)
                        .background(.orange.opacity(0.12), in: Capsule())
                }
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white.opacity(0.38))
                    .accessibilityLabel("Click to expand")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: PanelPresentationMetrics.compactSize.height)
    }

    private var compactSubtitle: String {
        if model.voiceState.isActive { return model.voiceState.message }
        if model.voiceState.phase == .denied { return "Microphone needs attention" }
        if model.runningAgentCount > 0 { return "\(model.runningAgentCount) agents working" }
        return model.status.isEmpty ? "Click to open" : model.status
    }

    private var islandHeader: some View {
        HStack(spacing: 12) {
            if model.voiceState.isActive {
                islandButton("Cancel", systemImage: "xmark", tint: .red) {
                    Task { await model.cancelVoice() }
                }
            } else {
                Image(systemName: model.voiceActivity == .dictation ? "text.cursor" : "sparkles")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(boundaryColor)
                    .frame(width: 44, height: 44)
            }

            if model.voiceState.isActive {
                VStack(spacing: 2) {
                    Text(islandTitle)
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                    Text(model.voiceState.message)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.62))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
            } else {
                HStack(spacing: 7) {
                    navigationTab(.home, systemImage: "house.fill")
                    navigationTab(.agents, systemImage: "rectangle.stack.fill")
                    Spacer()
                    Text(model.status)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.52))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
            }

            if model.voiceState.isActive {
                islandButton("Finish", systemImage: "checkmark", tint: .orange) {
                    Task { await model.finishVoice() }
                }
            } else {
                HStack(spacing: 10) {
                    Button { showingBrowserHandoff.toggle() } label: {
                        Image(systemName: "safari")
                    }
                    .help("Browser handoff")
                    Button { editingConnection.toggle() } label: {
                        Image(systemName: model.isConfigured ? "network.badge.shield.half.filled" : "network.slash")
                    }
                    .help("Gateway connection")
                    Button { presentation.handle(.collapse) } label: {
                        Image(systemName: "chevron.up")
                    }
                    .help("Collapse")
                    Button(action: cancelAndDismiss) { Image(systemName: "xmark") }
                        .help("Hide")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white.opacity(0.72))
                .frame(minWidth: 118, alignment: .trailing)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 64)
        .background(Color.black)
        .overlay(alignment: .bottom) {
            Rectangle().fill(boundaryColor.opacity(model.voiceState.isActive ? 0.8 : 0.24)).frame(height: 1)
        }
    }

    private func navigationTab(_ section: CommandModel.PanelSection, systemImage: String) -> some View {
        Button {
            section == .agents ? model.showAgents() : model.showHome()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                Text(section.rawValue)
                if section == .agents && model.runningAgentCount > 0 {
                    Text("\(model.runningAgentCount)")
                        .font(.caption2.weight(.black))
                        .foregroundStyle(.black)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(.orange, in: Capsule())
                }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white.opacity(model.panelSection == section ? 0.96 : 0.58))
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(.white.opacity(model.panelSection == section ? 0.12 : 0.03), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private var islandTitle: String {
        if model.voiceState.isActive {
            return model.voiceActivity == .dictation ? "Ag is dictating" : "Ag is listening"
        }
        if model.voiceState.phase == .denied { return "Microphone blocked" }
        if model.panelSection == .agents { return "Ag agents" }
        return "Ag"
    }

    private func islandButton(_ title: String, systemImage: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .labelStyle(.iconOnly)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(tint.opacity(0.24), in: Circle())
                .overlay(Circle().stroke(tint.opacity(0.75), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help(title)
        .accessibilityLabel(title)
    }

    private var conversationContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !model.lastSubmittedPrompt.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("You").font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.56))
                    Text(model.lastSubmittedPrompt)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .foregroundStyle(.white)
                }
                .padding(12)
                .background(.purple.opacity(0.20), in: RoundedRectangle(cornerRadius: 12))
            }
            if !model.voiceState.partial.isEmpty || !model.voiceState.final.isEmpty {
                transcriptCard
            }
            if !model.reply.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Ag").font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.56))
                    Text(model.reply)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .foregroundStyle(.white.opacity(0.92))
                }
                .padding(12)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private var transcriptCard: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(transcriptLabel).font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.56))
                Spacer()
                if model.voiceActivity == .dictation && !model.voiceState.final.isEmpty {
                    Button("Copy") { model.copyDictation() }.buttonStyle(.plain).foregroundStyle(.orange)
                }
            }
            Text(model.voiceState.final.isEmpty ? model.voiceState.partial : model.voiceState.final)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .foregroundStyle(.white)
        }
        .padding(12)
        .background(.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Ask Ag anything…", text: $model.prompt, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($promptFocused)
                .onSubmit { send() }
            Button { Task { await model.handleSummon() } } label: {
                Image(systemName: "mic.circle.fill").font(.title2).foregroundStyle(.purple)
            }
            .buttonStyle(.plain).help("Assistant voice").accessibilityLabel("Start assistant voice")
            Button { Task { await model.handleDictation() } } label: {
                Image(systemName: "text.cursor").font(.title2).foregroundStyle(.orange)
            }
            .buttonStyle(.plain).help("Literal dictation").accessibilityLabel("Start literal dictation")
            Button(action: send) {
                if model.isSending { ProgressView().controlSize(.small) }
                else { Image(systemName: "arrow.up.circle.fill").font(.title2) }
            }
            .buttonStyle(.plain)
            .disabled(model.isSending || model.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(12)
        .foregroundStyle(.white)
        .background(.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
    }

    private var microphoneRecovery: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Ag cannot hear you yet", systemImage: "mic.slash.fill")
                .font(.headline)
                .foregroundStyle(.red)
            Text("Enable Ag in Privacy & Security > Microphone. Screen Recording is optional and is not used for dictation.")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.68))
            HStack {
                Button("Open Microphone Settings") { model.openMicrophoneSettings() }
                Button("Try again") { Task { await model.handleDictation() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
            }
        }
        .padding(12)
        .background(.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.red.opacity(0.35)))
    }

    private var boundaryColor: Color {
        switch model.voiceState.phase {
        case .listening, .requestingPermission, .connecting: .purple
        case .finalizing: .orange
        case .denied, .interrupted, .failed: .red
        default: .white
        }
    }

    private var transcriptLabel: String {
        if model.voiceActivity == .dictation {
            return model.voiceState.final.isEmpty ? "Live dictation" : "Literal dictation"
        }
        return model.voiceState.final.isEmpty ? "Live transcript" : "Final transcript"
    }

    private var connectionEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your Ag account").font(.subheadline.weight(.semibold))
            connectionFeedback
            HStack {
                Spacer()
                if model.isConfigured { Button("Sign out") {
                    Task { await model.disconnect() }
                } } else { Button(model.connectionState.isFailure ? "Try again" : "Sign in") {
                    Task { await model.signIn() }
                }
                .disabled(model.isSigningIn) }
            }
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder private var connectionFeedback: some View {
        switch model.connectionState {
        case .disconnected:
            Label("Not connected", systemImage: "network.slash")
                .foregroundStyle(.secondary)
            Text("Sign in once. Ag will confirm each step here.")
                .font(.caption).foregroundStyle(.secondary)
        case .openingBrowser:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Opening secure browser sign-in…")
            }
        case .waitingForApproval(let code):
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Waiting for browser approval")
            }
            Text("Code \(code) · Ag will update automatically after approval.")
                .font(.caption).foregroundStyle(.secondary)
        case .connected:
            Label("Connected to Ag", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Text("Your portable Ag session is ready for chat and voice.")
                .font(.caption).foregroundStyle(.secondary)
        case .failed(let message):
            Label("Connection failed", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(message).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Recent gateway history").font(.subheadline.weight(.semibold))
                Spacer()
                Button("Close") { Task { await model.toggleHistory() } }
                    .buttonStyle(.plain)
            }
            if !model.historyStatus.isEmpty {
                Text(model.historyStatus).font(.caption).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 9) {
                        ForEach(model.historyEntries) { entry in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(entry.text.isEmpty ? entry.assistantText : entry.text)
                                    .lineLimit(3)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text("\(entry.type) · \(entry.source)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(8)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 9))
                        }
                    }
                }
                .frame(maxHeight: 110)
            }
        }
        .padding(10)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }

    private var browserHandoff: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Open in browser", systemImage: "safari")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button("Find extension") { Task { await model.refreshBrowserDevices() } }
                    .buttonStyle(.plain)
            }
            HStack(spacing: 8) {
                TextField("Web address", text: $model.browserURL)
                    .textFieldStyle(.roundedBorder)
                if model.browserDevices.count > 1 {
                    Picker("Browser", selection: $model.selectedBrowserID) {
                        ForEach(model.browserDevices) { device in Text(device.id).tag(device.id) }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 150)
                }
                Button {
                    Task { await model.openInBrowser() }
                } label: {
                    if model.isDelegatingBrowser { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.up.forward.app") }
                }
                .disabled(model.isDelegatingBrowser || model.selectedBrowserID.isEmpty || model.browserURL.isEmpty)
                .help("Ask the selected browser extension to open this URL")
            }
            Text("The extension owns Chrome access. The Mac app sends only this URL through your gateway.")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if model.browserHandoffPhase != .idle {
                Label(browserPhaseLabel, systemImage: browserPhaseIcon)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(model.browserHandoffPhase == .failed ? .red : .secondary)
            }
        }
        .padding(10)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }

    private var browserPhaseLabel: String {
        switch model.browserHandoffPhase {
        case .idle: "Ready"
        case .queued: "Queued for the selected extension"
        case .running: "Extension is opening the URL"
        case .completed: "Extension completed the handoff"
        case .failed: "Browser handoff failed"
        }
    }

    private var browserPhaseIcon: String {
        switch model.browserHandoffPhase {
        case .idle: "circle"
        case .queued: "clock"
        case .running: "arrow.trianglehead.2.clockwise.rotate.90"
        case .completed: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private func send() {
        Task { await model.submit(); promptFocused = true }
    }

    private func cancelAndDismiss() {
        dismiss()
    }
}

private struct VoiceWaveform: View {
    let levels: [Double]

    var body: some View {
        HStack(alignment: .center, spacing: 4) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                Capsule()
                    .fill(.purple.gradient)
                    .frame(width: 5, height: max(4, 30 * level))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .background(.purple.opacity(0.08), in: Capsule())
        .animation(.linear(duration: 0.08), value: levels)
    }
}

private extension CommandModel.ConnectionState {
    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }
}
#endif
