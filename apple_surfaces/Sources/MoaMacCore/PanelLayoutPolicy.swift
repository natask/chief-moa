import CoreGraphics
import Foundation

public enum PanelLayoutPlacement: Equatable, Sendable {
    case belowNotch
    case centeredInVisibleFrame
}

public struct PanelLayoutInput: Equatable, Sendable {
    public let screenFrame: CGRect
    public let visibleFrame: CGRect
    public let panelSize: CGSize
    public let safeAreaTop: CGFloat
    public let isBuiltInDisplay: Bool

    public init(
        screenFrame: CGRect,
        visibleFrame: CGRect,
        panelSize: CGSize,
        safeAreaTop: CGFloat,
        isBuiltInDisplay: Bool
    ) {
        self.screenFrame = screenFrame
        self.visibleFrame = visibleFrame
        self.panelSize = panelSize
        self.safeAreaTop = safeAreaTop
        self.isBuiltInDisplay = isBuiltInDisplay
    }
}

public struct PanelLayoutDecision: Equatable, Sendable {
    public let origin: CGPoint
    public let placement: PanelLayoutPlacement

    public init(origin: CGPoint, placement: PanelLayoutPlacement) {
        self.origin = origin
        self.placement = placement
    }
}

public enum PanelLayoutPolicy {
    public static let notchGap: CGFloat = 12
    public static let centeredVerticalLift: CGFloat = 80

    public static func decision(for input: PanelLayoutInput) -> PanelLayoutDecision? {
        guard isUsable(input.screenFrame), isUsable(input.visibleFrame),
              input.panelSize.width.isFinite, input.panelSize.height.isFinite,
              input.panelSize.width > 0, input.panelSize.height > 0 else {
            return nil
        }

        let x = constrainedOrigin(
            preferred: input.visibleFrame.midX - input.panelSize.width / 2,
            length: input.panelSize.width,
            within: input.visibleFrame.minX ... input.visibleFrame.maxX
        )

        if input.isBuiltInDisplay, input.safeAreaTop.isFinite, input.safeAreaTop > 0 {
            let safeTop = min(
                input.visibleFrame.maxY,
                input.screenFrame.maxY - input.safeAreaTop
            )
            let y = constrainedOrigin(
                preferred: safeTop - notchGap - input.panelSize.height,
                length: input.panelSize.height,
                within: input.visibleFrame.minY ... safeTop
            )
            return PanelLayoutDecision(origin: CGPoint(x: x, y: y), placement: .belowNotch)
        }

        let y = constrainedOrigin(
            preferred: input.visibleFrame.midY - input.panelSize.height / 2 + centeredVerticalLift,
            length: input.panelSize.height,
            within: input.visibleFrame.minY ... input.visibleFrame.maxY
        )
        return PanelLayoutDecision(origin: CGPoint(x: x, y: y), placement: .centeredInVisibleFrame)
    }

    private static func isUsable(_ rect: CGRect) -> Bool {
        rect.origin.x.isFinite && rect.origin.y.isFinite
            && rect.width.isFinite && rect.height.isFinite
            && rect.width > 0 && rect.height > 0
    }

    private static func constrainedOrigin(
        preferred: CGFloat,
        length: CGFloat,
        within bounds: ClosedRange<CGFloat>
    ) -> CGFloat {
        guard length <= bounds.upperBound - bounds.lowerBound else { return bounds.lowerBound }
        return min(max(preferred, bounds.lowerBound), bounds.upperBound - length)
    }
}
