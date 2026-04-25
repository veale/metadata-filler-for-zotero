// swift-tools-version: 6.0
//
// fm-helper: a tiny CLI that wraps Apple's on-device FoundationModels
// framework so the Zotero plugin can call it as a subprocess. The plugin
// writes a JSON request to a file, runs this binary with [inFile, outFile],
// reads a JSON response back. See ../README.md → "Apple Intelligence
// (on-device)" for the protocol.
import PackageDescription

let package = Package(
    name: "fm-helper",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(name: "fm-helper")
    ]
)
