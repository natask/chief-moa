import AggieAppleSurface
import SwiftUI

public struct ApprovalSurfaceView: View {
    public init() {}
    @State private var state: ApprovalUXState = .awaitingApproval

    public var body: some View {
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
