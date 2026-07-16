import Foundation

public enum ApprovalUXState: String, CaseIterable, Sendable {
    case awaitingProposal, permissionRequired, awaitingApproval, denied
    case stale, expired, executing, succeeded, failed, unknownEffect

    public var title: String {
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

    public var detail: String {
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
