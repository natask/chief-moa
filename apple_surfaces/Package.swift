// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AggieAppleSurface",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "AggieAppleSurface", targets: ["AggieAppleSurface"]),
        .library(name: "MoaMacCore", targets: ["MoaMacCore"]),
        .executable(name: "AggieSurfaceApp", targets: ["AggieSurfaceApp"]),
        .executable(name: "MoaMac", targets: ["MoaMac"]),
    ],
    targets: [
        .target(name: "AggieAppleSurface", swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .target(name: "MoaMacCore", swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .executableTarget(name: "AggieSurfaceApp", dependencies: ["AggieAppleSurface"], swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .executableTarget(name: "MoaMac", dependencies: ["AggieAppleSurface", "MoaMacCore"], swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .testTarget(name: "AggieAppleSurfaceTests", dependencies: ["AggieAppleSurface"]),
        .testTarget(name: "MoaMacCoreTests", dependencies: ["MoaMacCore"]),
    ]
)
