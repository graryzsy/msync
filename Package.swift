// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MSync",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "MSyncCore", targets: ["MSyncCore"]),
        .executable(name: "MSync", targets: ["MSyncApp"]),
        .executable(name: "msync", targets: ["MSyncCLI"])
    ],
    targets: [
        .systemLibrary(name: "CSQLite", pkgConfig: "sqlite3", providers: [.brew(["sqlite3"]), .apt(["libsqlite3-dev"])]),
        .target(name: "MSyncCore", dependencies: ["CSQLite"]),
        .target(name: "MSyncAdapters", dependencies: ["MSyncCore"], resources: [.copy("Resources/MusicBridge.js")]),
        .executableTarget(name: "MSyncApp", dependencies: ["MSyncCore", "MSyncAdapters"]),
        .executableTarget(name: "MSyncCLI", dependencies: ["MSyncCore"]),
        .testTarget(name: "MSyncCoreTests", dependencies: ["MSyncCore"]),
        .testTarget(name: "MSyncAdapterTests", dependencies: ["MSyncAdapters"])
    ],
    swiftLanguageModes: [.v5]
)
