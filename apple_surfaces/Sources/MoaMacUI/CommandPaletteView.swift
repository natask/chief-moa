#if os(macOS)
import MoaMacShell
import SwiftUI

public struct CommandPaletteView: View {
    @ObservedObject private var model: CommandModel
    private let dismiss: () -> Void
    private let shortcutLabel: String
    @FocusState private var promptFocused: Bool
    @State private var editingConnection = false

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
                    Text("Aggie").font(.headline)
                    Text(model.status).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { editingConnection.toggle() } label: {
                    Image(systemName: model.isConfigured ? "network.badge.shield.half.filled" : "network.slash")
                }
                .buttonStyle(.plain)
                .help("Gateway connection")
                Button(action: dismiss) { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
                    .help("Hide")
            }

            if editingConnection || !model.isConfigured {
                connectionEditor
            }

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

            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask Aggie anything…", text: $model.prompt, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .focused($promptFocused)
                    .onSubmit { send() }
                Button(action: send) {
                    if model.isSending { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                }
                .buttonStyle(.plain)
                .disabled(model.isSending || model.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))

            Text("\(shortcutLabel) to toggle · Return to send · no screen context attached")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(18)
        .frame(width: 560, height: 420, alignment: .top)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(.white.opacity(0.16)))
        .onAppear { promptFocused = true }
        .onExitCommand(perform: dismiss)
    }

    private var connectionEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your Chief Moa gateway").font(.subheadline.weight(.semibold))
            TextField("Canonical HTTPS gateway origin", text: $model.origin)
                .textFieldStyle(.roundedBorder)
            SecureField("Gateway bearer token", text: $model.token)
                .textFieldStyle(.roundedBorder)
            HStack {
                Text("Provider credentials stay on the gateway.")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button("Save connection") {
                    if model.saveConnection() { editingConnection = false }
                    promptFocused = true
                }
            }
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }

    private func send() {
        Task { await model.submit(); promptFocused = true }
    }
}
#endif
