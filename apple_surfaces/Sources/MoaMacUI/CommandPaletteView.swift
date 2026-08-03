#if os(macOS)
import MoaMacShell
import SwiftUI

public struct CommandPaletteView: View {
    @ObservedObject private var model: CommandModel
    private let dismiss: () -> Void
    private let shortcutLabel: String
    @FocusState private var promptFocused: Bool
    @State private var editingConnection = false
    @State private var boundaryPulse = false

    public init(model: CommandModel, shortcutLabel: String = "Control-Space", dismiss: @escaping () -> Void = {}) {
        self.model = model
        self.shortcutLabel = shortcutLabel
        self.dismiss = dismiss
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.title2)
                    .foregroundStyle(.purple)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Ag").font(.headline)
                    Text(model.status).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await model.toggleHistory() } } label: {
                    Image(systemName: "clock.arrow.circlepath")
                }
                .buttonStyle(.plain)
                .help("Show this session's durable gateway history")
                Button { editingConnection.toggle() } label: {
                    Image(systemName: model.isConfigured ? "network.badge.shield.half.filled" : "network.slash")
                }
                .buttonStyle(.plain)
                .help("Gateway connection")
                Button(action: cancelAndDismiss) { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
                    .help("Hide")
            }

            if editingConnection {
                connectionEditor
            }

            if model.isShowingHistory {
                history
            }

            browserHandoff

            if !model.reply.isEmpty {
                ScrollView {
                    Text(model.reply)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 100)
                .padding(12)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
            }

            if !model.voiceState.partial.isEmpty || !model.voiceState.final.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(transcriptLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer()
                        if model.voiceActivity == .dictation && !model.voiceState.final.isEmpty {
                            Button("Copy") { model.copyDictation() }
                                .buttonStyle(.plain)
                        }
                    }
                    Text(model.voiceState.final.isEmpty ? model.voiceState.partial : model.voiceState.final)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .padding(12)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
            }

            if model.voiceState.isActive {
                VoiceWaveform(levels: model.voiceLevels)
                    .frame(height: 34)
                    .accessibilityLabel("Live microphone level")
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }

            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask Ag anything…", text: $model.prompt, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .focused($promptFocused)
                    .onSubmit { send() }
                Button {
                    Task { await model.handleSummon() }
                } label: {
                    Image(systemName: model.voiceState.isActive ? "stop.circle.fill" : "mic.circle.fill")
                        .font(.title2)
                        .foregroundStyle(model.voiceState.isActive ? .red : .purple)
                }
                .buttonStyle(.plain)
                .help(model.voiceState.isActive ? "Finish and send" : "Start listening")
                .accessibilityLabel(model.voiceState.isActive ? "Finish and send" : "Start listening")
                Button {
                    Task { await model.handleDictation() }
                } label: {
                    Image(systemName: model.voiceState.isActive && model.voiceActivity == .dictation
                          ? "stop.circle.fill" : "text.cursor")
                        .font(.title2)
                        .foregroundStyle(model.voiceActivity == .dictation ? .orange : .secondary)
                }
                .buttonStyle(.plain)
                .help(model.voiceState.isActive && model.voiceActivity == .dictation
                      ? "Finish literal dictation" : "Start literal dictation")
                .accessibilityLabel("Literal dictation")
                Button(action: send) {
                    if model.isSending { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                }
                .buttonStyle(.plain)
                .disabled(model.isSending || model.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))

            Text(model.voiceState.message)
                .font(.caption2)
                .foregroundStyle(model.voiceState.phase == .denied || model.voiceState.phase == .failed ? .red : .secondary)

            Text("\(shortcutLabel) toggles assistant voice · Dictate captures literal text · no screen context attached")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(16)
        .frame(minWidth: 480, maxWidth: 480, minHeight: 300, maxHeight: 420, alignment: .top)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(boundaryColor, lineWidth: model.voiceState.isActive ? 3 : 1)
                .opacity(boundaryPulse ? 1 : (model.voiceState.isActive ? 0.9 : 0.34))
        )
        .shadow(color: boundaryColor.opacity(model.voiceState.isActive ? 0.42 : 0), radius: 18)
        .animation(.snappy(duration: 0.22), value: model.voiceState.phase)
        .onAppear { promptFocused = true }
        .onChange(of: model.interactionPulse) {
            boundaryPulse = true
            withAnimation(.easeOut(duration: 0.42)) { boundaryPulse = false }
        }
        .onExitCommand(perform: cancelAndDismiss)
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
            Text(model.isConfigured ? "Signed in on this Mac" : "Sign in once. Ag keeps this Mac connected securely.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                if model.isConfigured { Button("Sign out") {
                    Task { await model.disconnect() }
                } } else { Button("Sign in") { Task { await model.signIn() } } }
            }
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
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
#endif
