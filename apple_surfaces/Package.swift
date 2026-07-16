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
        .executable(name: "MoaMacProgramRunner", targets: ["MoaMacProgramRunner"]),
    ],
    targets: [
        .target(name: "AggieAppleSurface", swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .target(name: "MoaMacCore", swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .target(name: "AggieSurfaceUI", dependencies: ["AggieAppleSurface"], swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .target(
            name: "MoaMacShell",
            dependencies: ["MoaMacCore"],
            swiftSettings: [.enableUpcomingFeature("StrictConcurrency")],
            linkerSettings: [.linkedFramework("JavaScriptCore")]
        ),
        .target(name: "MoaMacUI", dependencies: ["MoaMacCore", "MoaMacShell"], swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .executableTarget(name: "AggieSurfaceApp", dependencies: ["AggieSurfaceUI"], swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .executableTarget(name: "MoaMac", dependencies: ["MoaMacUI"], swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]),
        .executableTarget(name: "MoaMacProgramRunner", dependencies: ["MoaMacCore"],
            swiftSettings: [.enableUpcomingFeature("StrictConcurrency")],
            linkerSettings: [.linkedFramework("JavaScriptCore")]),
        .testTarget(name: "AggieAppleSurfaceTests", dependencies: ["AggieAppleSurface", "AggieSurfaceUI"]),
        .testTarget(name: "MoaMacCoreTests", dependencies: ["MoaMacCore", "MoaMacShell", "MoaMacUI"]),
    ]
)
