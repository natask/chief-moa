import CoreGraphics
import Foundation

public enum PanelPresentationPhase: Equatable, Sendable {
    case compact
    case expanded
}

public enum PanelPresentationEvent: Equatable, Sendable {
    case open
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
        case .open:
            phase = .expanded
        case .collapse:
            phase = .compact
        }
    }
}

public enum PanelPresentationMetrics {
    public static let compactSize = CGSize(width: 392, height: 64)
    public static let expandedSize = CGSize(width: 720, height: 520)
}
