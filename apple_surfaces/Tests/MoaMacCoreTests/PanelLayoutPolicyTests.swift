import CoreGraphics
import Foundation
import MoaMacCore
import Testing

private func input(
    screen: CGRect = CGRect(x: 0, y: 0, width: 1_512, height: 982),
    visible: CGRect = CGRect(x: 0, y: 0, width: 1_512, height: 944),
    panel: CGSize = CGSize(width: 560, height: 420),
    safeAreaTop: CGFloat = 0,
    isBuiltIn: Bool = true
) -> PanelLayoutInput {
    PanelLayoutInput(
        screenFrame: screen,
        visibleFrame: visible,
        panelSize: panel,
        safeAreaTop: safeAreaTop,
        isBuiltInDisplay: isBuiltIn
    )
}

@Test func builtInNotchAnchorsPanelBelowSafeArea() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(safeAreaTop: 38)))
    #expect(value.placement == .belowNotch)
    #expect(value.origin == CGPoint(x: 476, y: 512))
    #expect(value.origin.y + 420 + PanelLayoutPolicy.notchGap == 944)
}

@Test func notchAnchorUsesLowerMenuBarSafeBoundary() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        visible: CGRect(x: 0, y: 0, width: 1_512, height: 930),
        safeAreaTop: 38
    )))
    #expect(value.placement == .belowNotch)
    #expect(value.origin.y == 498)
    #expect(value.origin.y + 420 + PanelLayoutPolicy.notchGap == 930)
}

@Test func impossibleFiniteSafeAreaRequestsAppKitCenterFallback() {
    #expect(PanelLayoutPolicy.decision(for: input(safeAreaTop: 10_000)) == nil)
    #expect(PanelLayoutPolicy.decision(for: input(safeAreaTop: CGFloat.greatestFiniteMagnitude)) == nil)
}

@Test func safeAreaExactlyAtVisibleBottomRemainsDeterministic() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        screen: CGRect(x: 100, y: 100, width: 1_000, height: 900),
        visible: CGRect(x: 100, y: 120, width: 1_000, height: 840),
        safeAreaTop: 880
    )))
    #expect(value.placement == .belowNotch)
    #expect(value.origin == CGPoint(x: 320, y: 120))
}

@Test(arguments: [
    (false, CGFloat(38)),
    (true, CGFloat(0)),
    (true, CGFloat(-1)),
    (true, CGFloat.nan),
])
func nonNotchedAndExternalDisplaysUseCenteredVisibleFrameFallback(
    isBuiltIn: Bool,
    safeAreaTop: CGFloat
) throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        safeAreaTop: safeAreaTop,
        isBuiltIn: isBuiltIn
    )))
    #expect(value.placement == .centeredInVisibleFrame)
    #expect(value.origin == CGPoint(x: 476, y: 342))
}

@Test func fallbackHonorsOffsetExternalDisplayCoordinates() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        screen: CGRect(x: -1_920, y: -120, width: 1_920, height: 1_080),
        visible: CGRect(x: -1_920, y: -120, width: 1_920, height: 1_040),
        panel: CGSize(width: 600, height: 400),
        isBuiltIn: false
    )))
    #expect(value.origin == CGPoint(x: -1_260, y: 280))
}

@Test func notchAndFallbackClampHorizontallyInsideVisibleFrame() throws {
    for safeAreaTop in [CGFloat(0), CGFloat(40)] {
        let value = try #require(PanelLayoutPolicy.decision(for: input(
            screen: CGRect(x: 100, y: 0, width: 500, height: 900),
            visible: CGRect(x: 120, y: 0, width: 460, height: 850),
            panel: CGSize(width: 560, height: 420),
            safeAreaTop: safeAreaTop
        )))
        #expect(value.origin.x == 120)
    }
}

@Test func fallbackClampsLiftBelowMenuBar() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        screen: CGRect(x: 0, y: 0, width: 800, height: 600),
        visible: CGRect(x: 0, y: 40, width: 800, height: 520),
        panel: CGSize(width: 560, height: 500)
    )))
    #expect(value.origin.y == 60)
    #expect(value.origin.y + 500 == 560)
}

@Test func oversizedPanelUsesDeterministicVisibleFrameOrigin() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        screen: CGRect(x: 10, y: 20, width: 300, height: 300),
        visible: CGRect(x: 20, y: 30, width: 280, height: 260),
        panel: CGSize(width: 400, height: 400),
        safeAreaTop: 30
    )))
    #expect(value.placement == .belowNotch)
    #expect(value.origin == CGPoint(x: 20, y: 30))
}

@Test(arguments: [
    input(screen: .zero),
    input(visible: .zero),
    input(panel: .zero),
    input(screen: CGRect(x: CGFloat.infinity, y: 0, width: 100, height: 100)),
    input(visible: CGRect(x: 0, y: 0, width: CGFloat.nan, height: 100)),
    input(panel: CGSize(width: CGFloat.infinity, height: 100)),
])
func invalidGeometryRequestsAppKitCenterFallback(value: PanelLayoutInput) {
    #expect(PanelLayoutPolicy.decision(for: value) == nil)
}
