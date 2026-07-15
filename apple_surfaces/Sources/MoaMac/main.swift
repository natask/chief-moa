#if os(macOS)
import MoaMacUI
import SwiftUI

@main
struct MoaMacApp: App {
    var body: some Scene {
        WindowGroup { StatusView() }
    }
}
#else
import Foundation

@main
enum MoaMacUnavailable {
    static func main() { print("MoaMac requires macOS") }
}
#endif
