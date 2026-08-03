#if os(macOS)
import MoaMacShell
import SwiftUI

public struct AgentWorkspaceView: View {
    @ObservedObject private var model: CommandModel
    @State private var search = ""
    @State private var selectedRunID: String?

    public init(model: CommandModel) { self.model = model }

    public var body: some View {
        HStack(spacing: 0) {
            projectSidebar
                .frame(width: 248)
            Rectangle()
                .fill(.white.opacity(0.10))
                .frame(width: 1)
            runDetail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .foregroundStyle(.white)
        .background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(.white.opacity(0.08)))
        .task {
            await model.refreshAgentRuns()
            selectFirstRunIfNeeded()
        }
        .onChange(of: model.agentRuns) { selectFirstRunIfNeeded() }
    }

    private var projectSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: "sparkles")
                    .font(.system(size: 17, weight: .black))
                    .foregroundStyle(.cyan)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Agent projects").font(.headline)
                    Text(model.runningAgentCount == 0 ? "All work" : "\(model.runningAgentCount) running")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.46))
                }
                Spacer()
                if model.isLoadingAgentRuns { ProgressView().controlSize(.small) }
                Button { Task { await model.refreshAgentRuns() } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.plain)
                .help("Refresh projects")
            }
            .padding(14)

            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.white.opacity(0.38))
                TextField("Search projects", text: $search)
                    .textFieldStyle(.plain)
            }
            .padding(.horizontal, 10)
            .frame(height: 34)
            .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
            .padding(.horizontal, 12)
            .padding(.bottom, 10)

            if !model.agentRunStatus.isEmpty {
                Text(model.agentRunStatus)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.54))
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3) {
                    if !runningRuns.isEmpty { sectionLabel("RUNNING") }
                    ForEach(runningRuns) { sidebarRow($0) }
                    if !recentRuns.isEmpty { sectionLabel("RECENT") }
                    ForEach(recentRuns) { sidebarRow($0) }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 10)
            }
        }
        .background(.white.opacity(0.035))
    }

    @ViewBuilder private var runDetail: some View {
        if let run = selectedRun {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .top, spacing: 14) {
                        AgentAvatar(run: run, size: 52)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(run.title)
                                .font(.title2.weight(.bold))
                                .textSelection(.enabled)
                            HStack(spacing: 8) {
                                statusChip(run)
                                if !run.projectID.isEmpty { metadataChip(run.projectID) }
                                if !run.harness.isEmpty { metadataChip(run.harness) }
                            }
                        }
                        Spacer()
                        if run.isRunning {
                            Button("Stop agent", role: .destructive) {
                                Task { await model.cancelAgentRun(run.id) }
                            }
                            .buttonStyle(.bordered)
                            .tint(.red)
                        }
                    }

                    detailBlock("CURRENT ACTIVITY", text: run.outputPreview.isEmpty ? "Waiting for the first agent update…" : run.outputPreview)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("RUN DETAILS")
                            .font(.caption2.weight(.black))
                            .tracking(1.1)
                            .foregroundStyle(.white.opacity(0.42))
                        detailRow("Run", value: run.id)
                        detailRow("Project", value: run.projectID.isEmpty ? "Unassigned" : run.projectID)
                        detailRow("Session", value: run.conversationID.isEmpty ? "No session" : run.conversationID)
                        detailRow("Branch", value: run.branchID)
                        detailRow("Source", value: run.source.isEmpty ? "Unknown" : run.source)
                    }
                    .padding(16)
                    .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 15))
                }
                .padding(22)
            }
        } else {
            ContentUnavailableView(
                model.agentRuns.isEmpty ? "No agent projects yet" : "No matching projects",
                systemImage: "rectangle.stack",
                description: Text("Agent work from your Chief Moa gateway appears here.")
            )
            .foregroundStyle(.white.opacity(0.68))
        }
    }

    private var filteredRuns: [GatewayAgentRun] {
        guard !search.isEmpty else { return model.agentRuns }
        return model.agentRuns.filter {
            $0.title.localizedCaseInsensitiveContains(search)
                || $0.projectID.localizedCaseInsensitiveContains(search)
                || $0.harness.localizedCaseInsensitiveContains(search)
                || $0.outputPreview.localizedCaseInsensitiveContains(search)
        }
    }

    private var runningRuns: [GatewayAgentRun] { filteredRuns.filter(\.isRunning) }
    private var recentRuns: [GatewayAgentRun] { filteredRuns.filter { !$0.isRunning } }
    private var selectedRun: GatewayAgentRun? {
        filteredRuns.first { $0.id == selectedRunID } ?? filteredRuns.first
    }

    private func selectFirstRunIfNeeded() {
        if let selectedRunID, model.agentRuns.contains(where: { $0.id == selectedRunID }) { return }
        selectedRunID = model.agentRuns.first?.id
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.caption2.weight(.black))
            .tracking(1.1)
            .foregroundStyle(.white.opacity(0.38))
            .padding(.horizontal, 8)
            .padding(.top, 9)
            .padding(.bottom, 3)
    }

    private func sidebarRow(_ run: GatewayAgentRun) -> some View {
        Button { selectedRunID = run.id } label: {
            HStack(spacing: 9) {
                Circle()
                    .fill(run.isRunning ? .orange : statusColor(run))
                    .frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(run.title)
                        .font(.subheadline.weight(selectedRun?.id == run.id ? .semibold : .regular))
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(run.projectID.isEmpty ? run.status : run.projectID)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.42))
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(selectedRun?.id == run.id ? .white.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 9))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func statusChip(_ run: GatewayAgentRun) -> some View {
        Text(run.status.uppercased())
            .font(.system(size: 9, weight: .black))
            .foregroundStyle(run.isRunning ? .orange : statusColor(run))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.white.opacity(0.07), in: Capsule())
    }

    private func metadataChip(_ value: String) -> some View {
        Text(value)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.white.opacity(0.56))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.white.opacity(0.06), in: Capsule())
    }

    private func detailBlock(_ label: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(label)
                .font(.caption2.weight(.black))
                .tracking(1.1)
                .foregroundStyle(.white.opacity(0.42))
            Text(text)
                .font(.body)
                .foregroundStyle(.white.opacity(0.78))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, minHeight: 100, alignment: .topLeading)
        }
        .padding(16)
        .background(
            LinearGradient(colors: [.blue.opacity(0.20), .cyan.opacity(0.06)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 15)
        )
        .overlay(RoundedRectangle(cornerRadius: 15).stroke(.cyan.opacity(0.18)))
    }

    private func detailRow(_ label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.white.opacity(0.44)).frame(width: 72, alignment: .leading)
            Text(value).foregroundStyle(.white.opacity(0.76)).textSelection(.enabled)
            Spacer()
        }
        .font(.caption)
    }

    private func statusColor(_ run: GatewayAgentRun) -> Color {
        switch run.status.lowercased() {
        case "completed": .green
        case "failed", "timed-out": .red
        case "canceled": .gray
        default: .blue
        }
    }
}

public struct AgentRailView: View {
    @ObservedObject private var model: CommandModel
    private let open: () -> Void

    public init(model: CommandModel, open: @escaping () -> Void) {
        self.model = model
        self.open = open
    }

    public var body: some View {
        VStack(spacing: 10) {
            ForEach(Array(model.agentRuns.prefix(6))) { run in
                Button(action: open) { AgentAvatar(run: run, size: 46) }
                    .buttonStyle(.plain)
                    .help("\(run.title) — \(run.status)")
            }
        }
        .padding(10)
        .background(.black.opacity(0.76), in: Capsule())
        .overlay(Capsule().stroke(.white.opacity(0.14), lineWidth: 1))
        .shadow(color: .black.opacity(0.45), radius: 18, y: 8)
    }
}

private struct AgentAvatar: View {
    let run: GatewayAgentRun
    let size: CGFloat

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Circle()
                .fill(LinearGradient(colors: [.black.opacity(0.92), accent.opacity(0.42)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay(Circle().stroke(accent.opacity(0.72), lineWidth: 1))
                .shadow(color: run.isRunning ? accent.opacity(0.48) : .clear, radius: 10)
            Image(systemName: "cursorarrow")
                .font(.system(size: size * 0.40, weight: .black))
                .foregroundStyle(accent)
                .rotationEffect(.degrees(-16))
            Circle()
                .fill(run.isRunning ? .orange : statusColor)
                .frame(width: size * 0.22, height: size * 0.22)
                .overlay(Circle().stroke(.black, lineWidth: 2))
        }
        .frame(width: size, height: size)
        .accessibilityLabel("\(run.title), \(run.status)")
    }

    private var accent: Color {
        let palette: [Color] = [.cyan, .purple, .mint, .pink, .yellow, .blue]
        return palette[Int(UInt(bitPattern: run.id.hashValue) % UInt(palette.count))]
    }

    private var statusColor: Color {
        switch run.status.lowercased() {
        case "completed": .green
        case "failed", "timed-out": .red
        case "canceled": .gray
        default: .blue
        }
    }
}
#endif
