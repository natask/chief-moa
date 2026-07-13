// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AggieAppleSurface",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "AggieAppleSurface", targets: ["AggieAppleSurface"]),
        .executable(name: "AggieSurfaceApp", targets: ["AggieSurfaceApp"]),
    ],
    targets: [
        .target(name: "AggieAppleSurface", swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .executableTarget(name: "AggieSurfaceApp", dependencies: ["AggieAppleSurface"], swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .testTarget(name: "AggieAppleSurfaceTests", dependencies: ["AggieAppleSurface"]),
    ]
)
