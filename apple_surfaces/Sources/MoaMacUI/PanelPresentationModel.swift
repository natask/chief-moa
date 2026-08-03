#if os(macOS)
import MoaMacCore
import SwiftUI

@MainActor public final class PanelPresentationModel: ObservableObject {
    @Published public private(set) var state: PanelPresentationState

    public init(state: PanelPresentationState = PanelPresentationState()) {
        self.state = state
    }

    public var isExpanded: Bool { state.isExpanded }
    public var phase: PanelPresentationPhase { state.phase }

    public func handle(_ event: PanelPresentationEvent) {
        var next = state
        next.handle(event)
        guard next != state else { return }
        state = next
    }
}
#endif
