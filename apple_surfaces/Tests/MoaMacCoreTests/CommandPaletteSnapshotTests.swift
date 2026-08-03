#if os(macOS)
import AppKit
import Foundation
import MoaMacCore
import MoaMacShell
import MoaMacUI
import SwiftUI
import Testing

private struct SnapshotConnectionStore: GatewayConnectionStore {
    func loadOrigin() -> String { "https://moa.example" }
    func loadSessionID() -> String { "snapshot-session" }
    func saveOrigin(_ origin: String) throws {}
}

private struct SnapshotSessionStore: DeviceSessionStoring {
    func load() -> String { "snapshot-token" }
    func save(_ token: String) throws {}
    func clear() throws {}
}

private actor SnapshotChatSender: GatewayChatSending {
    func send(_ request: GatewayChatRequest, bearerToken: String) async throws -> GatewayChatReply {
        GatewayChatReply(text: "Ready")
    }
}

private actor SnapshotAgentLoader: GatewayAgentRunLoading {
    func load(origin: URL, bearerToken: String, limit: Int) async throws -> [GatewayAgentRun] {
        [
            GatewayAgentRun(
                id: "run_design",
                status: "running",
                harness: "codex",
                source: "macos",
                conversationID: "product-design",
                branchID: "master",
                projectID: "Chief Moa",
                promptPreview: "Refine the compact Mac companion",
                outputPreview: "Testing the pinned workspace without opening a desktop window.",
                active: true
            ),
            GatewayAgentRun(
                id: "run_gateway",
                status: "completed",
                harness: "codex",
                projectID: "Gateway",
                promptPreview: "Verify agent projection"
            ),
        ]
    }

    func cancel(origin: URL, bearerToken: String, runID: String) async throws {}
}

@MainActor @Test func rendersCommandPaletteSnapshotsWithoutAnOnscreenWindow() async throws {
    guard let output = ProcessInfo.processInfo.environment["MOA_UI_SNAPSHOT_DIR"], !output.isEmpty else { return }
    let directory = URL(fileURLWithPath: output, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let model = CommandModel(
        store: SnapshotConnectionStore(),
        sender: SnapshotChatSender(),
        deviceSessionStore: SnapshotSessionStore(),
        agentRunLoader: SnapshotAgentLoader()
    )
    await model.refreshAgentRuns()

    try render(
        CommandPaletteView(model: model, presentation: PanelPresentationModel()),
        size: PanelPresentationMetrics.compactSize,
        to: directory.appendingPathComponent("ag-compact-resting.png")
    )

    model.showAgents()
    let expanded = PanelPresentationModel(state: PanelPresentationState(phase: .expanded))
    try render(
        CommandPaletteView(model: model, presentation: expanded),
        size: PanelPresentationMetrics.expandedSize,
        to: directory.appendingPathComponent("ag-expanded-agents.png")
    )
}

@MainActor private func render<V: View>(_ view: V, size: CGSize, to destination: URL) throws {
    let hosting = NSHostingView(rootView: view.environment(\.colorScheme, .dark))
    hosting.frame = NSRect(origin: .zero, size: size)
    hosting.appearance = NSAppearance(named: .darkAqua)
    hosting.layoutSubtreeIfNeeded()
    guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
        throw SnapshotError.renderFailed
    }
    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { throw SnapshotError.renderFailed }
    try png.write(to: destination, options: .atomic)
}

private enum SnapshotError: Error { case renderFailed }
#endif
