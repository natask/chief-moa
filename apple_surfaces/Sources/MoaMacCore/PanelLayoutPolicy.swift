import CoreGraphics
import Foundation

public enum PanelLayoutPlacement: Equatable, Sendable {
    case dynamicIsland
    case belowMenuBar
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

public struct PanelScreenDescriptor: Equatable, Sendable {
    public let id: UInt32
    public let safeAreaTop: CGFloat
    public let isBuiltInDisplay: Bool

    public init(id: UInt32, safeAreaTop: CGFloat, isBuiltInDisplay: Bool) {
        self.id = id
        self.safeAreaTop = safeAreaTop
        self.isBuiltInDisplay = isBuiltInDisplay
    }
}

public enum PanelScreenSelectionPolicy {
    public static func targetDisplayID(
        screens: [PanelScreenDescriptor],
        mainDisplayID: UInt32?
    ) -> UInt32? {
        if let notchedBuiltIn = screens.first(where: {
            $0.isBuiltInDisplay && $0.safeAreaTop.isFinite && $0.safeAreaTop > 0
        }) {
            return notchedBuiltIn.id
        }
        if let mainDisplayID, screens.contains(where: { $0.id == mainDisplayID }) {
            return mainDisplayID
        }
        return screens.first?.id
    }
}

public enum PanelLayoutPolicy {
    public static let menuBarGap: CGFloat = 8

    public static func decision(for input: PanelLayoutInput) -> PanelLayoutDecision? {
        guard isUsable(input.screenFrame), isUsable(input.visibleFrame),
              input.panelSize.width.isFinite, input.panelSize.height.isFinite,
              input.panelSize.width > 0, input.panelSize.height > 0 else {
            return nil
        }

        let horizontalBounds = input.screenFrame.minX ... input.screenFrame.maxX
        let x = constrainedOrigin(
            preferred: input.screenFrame.midX - input.panelSize.width / 2,
            length: input.panelSize.width,
            within: horizontalBounds
        )

        if input.isBuiltInDisplay, input.safeAreaTop.isFinite, input.safeAreaTop > 0 {
            let top = input.screenFrame.maxY
            guard top.isFinite else { return nil }
            let y = constrainedOrigin(
                preferred: top - input.panelSize.height,
                length: input.panelSize.height,
                within: input.screenFrame.minY ... top
            )
            return PanelLayoutDecision(origin: CGPoint(x: x, y: y), placement: .dynamicIsland)
        }

        let top = input.visibleFrame.maxY - menuBarGap
        let y = constrainedOrigin(
            preferred: top - input.panelSize.height,
            length: input.panelSize.height,
            within: input.visibleFrame.minY ... input.visibleFrame.maxY
        )
        return PanelLayoutDecision(origin: CGPoint(x: x, y: y), placement: .belowMenuBar)
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
