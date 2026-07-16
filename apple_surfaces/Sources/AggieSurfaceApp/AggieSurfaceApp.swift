import AggieSurfaceUI
import SwiftUI

struct AggieSurfaceApp: App {
    var body: some Scene {
        WindowGroup { ApprovalSurfaceView() }
    }
}

@main
enum AggieSurfaceMain {
    static func main() {
        if CommandLine.arguments.contains("--coverage-smoke") {
            _ = AggieSurfaceApp().body
            return
        }
        AggieSurfaceApp.main()
    }
}
