import CoreGraphics
import Foundation

public enum PanelPresentationPhase: Equatable, Sendable {
    case compact
    case hoverExpanded
    case pinned
}

public enum PanelPresentationEvent: Equatable, Sendable {
    case pointerEntered
    case pointerExited
    case interacted
    case gainedFocus
    case collapse
}

public struct PanelPresentationState: Equatable, Sendable {
    public private(set) var phase: PanelPresentationPhase

    public init(phase: PanelPresentationPhase = .compact) {
        self.phase = phase
    }

    public var isExpanded: Bool { phase != .compact }

    public mutating func handle(_ event: PanelPresentationEvent) {
        switch event {
        case .pointerEntered where phase == .compact:
            phase = .hoverExpanded
        case .pointerExited where phase == .hoverExpanded:
            phase = .compact
        case .interacted, .gainedFocus:
            phase = .pinned
        case .collapse:
            phase = .compact
        default:
            break
        }
    }
}

public enum PanelPresentationMetrics {
    public static let compactSize = CGSize(width: 392, height: 64)
    public static let expandedSize = CGSize(width: 720, height: 520)
}
