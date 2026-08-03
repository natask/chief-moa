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

@Test func builtInNotchAttachesPanelToDynamicIsland() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(safeAreaTop: 38)))
    #expect(value.placement == .dynamicIsland)
    #expect(value.origin == CGPoint(x: 476, y: 562))
    #expect(value.origin.y + 420 == 982)
}

@Test func notchAnchorUsesPhysicalScreenTopInsteadOfVisibleFrame() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        visible: CGRect(x: 0, y: 0, width: 1_512, height: 930),
        safeAreaTop: 38
    )))
    #expect(value.placement == .dynamicIsland)
    #expect(value.origin.y == 562)
    #expect(value.origin.y + 420 == 982)
}

@Test func largeFiniteSafeAreaDoesNotMoveIslandOffscreen() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(safeAreaTop: 10_000)))
    #expect(value.placement == .dynamicIsland)
    #expect(value.origin.y == 562)
    #expect(PanelLayoutPolicy.decision(for: input(safeAreaTop: CGFloat.greatestFiniteMagnitude)) != nil)
}

@Test func safeAreaExactlyAtVisibleBottomRemainsDeterministic() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        screen: CGRect(x: 100, y: 100, width: 1_000, height: 900),
        visible: CGRect(x: 100, y: 120, width: 1_000, height: 840),
        safeAreaTop: 880
    )))
    #expect(value.placement == .dynamicIsland)
    #expect(value.origin == CGPoint(x: 320, y: 580))
}

@Test(arguments: [
    (false, CGFloat(38)),
    (true, CGFloat(0)),
    (true, CGFloat(-1)),
    (true, CGFloat.nan),
])
func nonNotchedAndExternalDisplaysAttachBelowMenuBar(
    isBuiltIn: Bool,
    safeAreaTop: CGFloat
) throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        safeAreaTop: safeAreaTop,
        isBuiltIn: isBuiltIn
    )))
    #expect(value.placement == .belowMenuBar)
    #expect(value.origin == CGPoint(x: 476, y: 516))
}

@Test func fallbackHonorsOffsetExternalDisplayCoordinates() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        screen: CGRect(x: -1_920, y: -120, width: 1_920, height: 1_080),
        visible: CGRect(x: -1_920, y: -120, width: 1_920, height: 1_040),
        panel: CGSize(width: 600, height: 400),
        isBuiltIn: false
    )))
    #expect(value.origin == CGPoint(x: -1_260, y: 512))
}

@Test func notchAndFallbackClampHorizontallyInsidePhysicalScreen() throws {
    for safeAreaTop in [CGFloat(0), CGFloat(40)] {
        let value = try #require(PanelLayoutPolicy.decision(for: input(
            screen: CGRect(x: 100, y: 0, width: 500, height: 900),
            visible: CGRect(x: 120, y: 0, width: 460, height: 850),
            panel: CGSize(width: 560, height: 420),
            safeAreaTop: safeAreaTop
        )))
        #expect(value.origin.x == 100)
    }
}

@Test func fallbackClampsLiftBelowMenuBar() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        screen: CGRect(x: 0, y: 0, width: 800, height: 600),
        visible: CGRect(x: 0, y: 40, width: 800, height: 520),
        panel: CGSize(width: 560, height: 500)
    )))
    #expect(value.origin.y == 52)
    #expect(value.origin.y + 500 == 552)
}

@Test func oversizedPanelUsesDeterministicVisibleFrameOrigin() throws {
    let value = try #require(PanelLayoutPolicy.decision(for: input(
        screen: CGRect(x: 10, y: 20, width: 300, height: 300),
        visible: CGRect(x: 20, y: 30, width: 280, height: 260),
        panel: CGSize(width: 400, height: 400),
        safeAreaTop: 30
    )))
    #expect(value.placement == .dynamicIsland)
    #expect(value.origin == CGPoint(x: 10, y: 20))
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

@Test func panelRemainsCompactUntilExplicitlyOpened() {
    var state = PanelPresentationState()
    #expect(state.phase == .compact)
    #expect(!state.isExpanded)
    state.handle(.open)
    #expect(state.phase == .expanded)
    #expect(state.isExpanded)
}

@Test func explicitCollapseResetsExpandedPanel() {
    var state = PanelPresentationState(phase: .expanded)
    state.handle(.collapse)
    #expect(state.phase == .compact)
    #expect(!state.isExpanded)
}

@Test func notchedBuiltInDisplayWinsOverPointerOrExternalDisplay() {
    let external = PanelScreenDescriptor(id: 11, safeAreaTop: 0, isBuiltInDisplay: false)
    let builtIn = PanelScreenDescriptor(id: 22, safeAreaTop: 38, isBuiltInDisplay: true)
    #expect(PanelScreenSelectionPolicy.targetDisplayID(
        screens: [external, builtIn],
        mainDisplayID: external.id
    ) == builtIn.id)
}

@Test func mainDisplayIsFallbackWithoutAnActiveNotch() {
    let builtIn = PanelScreenDescriptor(id: 22, safeAreaTop: 0, isBuiltInDisplay: true)
    let external = PanelScreenDescriptor(id: 11, safeAreaTop: 0, isBuiltInDisplay: false)
    #expect(PanelScreenSelectionPolicy.targetDisplayID(
        screens: [builtIn, external],
        mainDisplayID: external.id
    ) == external.id)
}

@Test func compactAndExpandedFramesKeepTheSameHardwareAnchor() throws {
    let compact = try #require(PanelLayoutPolicy.decision(for: input(
        panel: PanelPresentationMetrics.compactSize,
        safeAreaTop: 38
    )))
    let expanded = try #require(PanelLayoutPolicy.decision(for: input(
        panel: PanelPresentationMetrics.expandedSize,
        safeAreaTop: 38
    )))
    #expect(compact.origin.x + PanelPresentationMetrics.compactSize.width / 2 == 756)
    #expect(expanded.origin.x + PanelPresentationMetrics.expandedSize.width / 2 == 756)
    #expect(compact.origin.y + PanelPresentationMetrics.compactSize.height == 982)
    #expect(expanded.origin.y + PanelPresentationMetrics.expandedSize.height == 982)
}
