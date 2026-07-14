import AggieAppleSurface
import SwiftUI

@main
struct AggieSurfaceApp: App {
    var body: some Scene {
        WindowGroup { ApprovalSurfaceView() }
    }
}

enum ApprovalUXState: String, CaseIterable, Sendable {
    case awaitingProposal, permissionRequired, awaitingApproval, denied
    case stale, expired, executing, succeeded, failed, unknownEffect

    var title: String {
        switch self {
        case .awaitingProposal: "Ready for a proposal"
        case .permissionRequired: "Permission required"
        case .awaitingApproval: "Review this action"
        case .denied: "Action denied"
        case .stale: "Device state changed"
        case .expired: "Proposal expired"
        case .executing: "Performing approved action"
        case .succeeded: "Action completed"
        case .failed: "Action failed safely"
        case .unknownEffect: "Action outcome needs review"
        }
    }

    var detail: String {
        switch self {
        case .awaitingProposal: "Moa will show proposed local actions here. Nothing runs automatically."
        case .permissionRequired: "Grant the named system permission in Settings, then return and review again."
        case .awaitingApproval: "Opening https://example.com was proposed. Confirm only if you recognize it."
        case .denied: "No local action ran. You can return to the proposal list."
        case .stale: "The device no longer matches the proposal. Ask Moa to make a fresh proposal."
        case .expired: "This proposal is no longer valid. Ask Moa to try again."
        case .executing: "Keep this window open while the locally approved action is checked."
        case .succeeded: "A local receipt recorded the observed successful outcome."
        case .failed: "A local receipt recorded a definite failure. It is safe to review a new proposal."
        case .unknownEffect: "Moa cannot prove whether the effect occurred. Do not retry until you verify it."
        }
    }
}

struct ApprovalSurfaceView: View {
    @State private var state: ApprovalUXState = .awaitingApproval

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Aggie local approval", systemImage: "checkmark.shield")
                .font(.title2.bold())
                .accessibilityIdentifier("aggie.approval.heading")
            Text(state.title).font(.headline)
                .accessibilityIdentifier("aggie.approval.status")
            Text(state.detail).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("aggie.approval.detail")
            Picker("Preview safety state", selection: $state) {
                ForEach(ApprovalUXState.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .accessibilityHint("Demonstrates unsigned shell states without performing a local effect")
            .accessibilityIdentifier("aggie.approval.demo-state")
            if state == .awaitingApproval {
                HStack {
                    Button("Deny") { state = .denied }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityHint("Rejects the proposal without running a local action")
                        .accessibilityIdentifier("aggie.approval.deny")
                    Button("Approve locally") { state = .executing }
                        .keyboardShortcut(.defaultAction)
                        .accessibilityHint("Approves this proposal for final local checks; it does not bypass permissions")
                        .accessibilityIdentifier("aggie.approval.approve")
                }
            } else if state == .unknownEffect {
                Button("I verified the outcome") { state = .awaitingProposal }
                    .accessibilityHint("Acknowledges this demo outcome; automatic retry remains disabled")
                    .accessibilityIdentifier("aggie.approval.verify-unknown")
            } else {
                Button("Return to proposals") { state = .awaitingProposal }
                    .accessibilityIdentifier("aggie.approval.recover")
            }
            Divider()
            Text("Static demo shell: not connected to transport or the authority coordinator; no network, OS action, signing, or provider credential authority.")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("aggie.approval.boundary")
        }
        .padding(24)
        .frame(minWidth: 360, idealWidth: 480, maxWidth: 620)
    }
}
