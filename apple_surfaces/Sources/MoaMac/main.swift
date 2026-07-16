#if os(macOS)
import MoaMacUI
import SwiftUI

struct MoaMacApp: App {
    var body: some Scene {
        WindowGroup { StatusView() }
    }
}

@main
enum MoaMacMain {
    static func main() {
        if CommandLine.arguments.contains("--coverage-smoke") {
            _ = MoaMacApp().body
            return
        }
        MoaMacApp.main()
    }
}
#else
import Foundation

@main
enum MoaMacUnavailable {
    static func main() { print("MoaMac requires macOS") }
}
#endif
