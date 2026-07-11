// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AggieAppleSurface",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "AggieAppleSurface", targets: ["AggieAppleSurface"])],
    targets: [
        .target(name: "AggieAppleSurface", swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .testTarget(name: "AggieAppleSurfaceTests", dependencies: ["AggieAppleSurface"]),
    ]
)
