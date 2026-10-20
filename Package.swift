// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "MacTuner",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "MacTuner", path: "Sources/MacTuner")
    ]
)
