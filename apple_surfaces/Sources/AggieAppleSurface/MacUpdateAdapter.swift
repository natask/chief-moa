import Foundation

/// Established distribution authorities supported by the seam. The package
/// intentionally does not define a downloader, installer, feed, or signature
/// format of its own.
public enum EstablishedMacUpdater: String, Codable, Sendable {
    case sparkle2
    case macAppStore = "mac_app_store"
    case managedDistribution = "managed_distribution"
}

public enum MacUpdateVerificationAuthority: String, Codable, Sendable {
    case sparkleEdDSAAndAppleNotarization = "sparkle_eddsa_and_apple_notarization"
    case appStoreReceiptAndAppleReview = "app_store_receipt_and_apple_review"
    case organizationManaged = "organization_managed"
}

public struct MacUpdateMetadata: Codable, Equatable, Sendable {
    public let version: String
    public let build: String
    public let updater: EstablishedMacUpdater
    public let verificationAuthority: MacUpdateVerificationAuthority
    public let releaseNotesURL: URL?

    public init(version: String, build: String, updater: EstablishedMacUpdater,
                verificationAuthority: MacUpdateVerificationAuthority, releaseNotesURL: URL? = nil) throws {
        guard Self.isBoundedVersion(version), Self.isBoundedVersion(build),
              releaseNotesURL == nil || releaseNotesURL?.scheme == "https",
              Self.matches(updater: updater, authority: verificationAuthority)
        else { throw MacUpdateAdapterError.invalidMetadata }
        self.version = version
        self.build = build
        self.updater = updater
        self.verificationAuthority = verificationAuthority
        self.releaseNotesURL = releaseNotesURL
    }

    private static func isBoundedVersion(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 64 && value.allSatisfy { $0.isNumber || ".-+_".contains($0) || $0.isLetter }
    }

    private static func matches(updater: EstablishedMacUpdater, authority: MacUpdateVerificationAuthority) -> Bool {
        switch (updater, authority) {
        case (.sparkle2, .sparkleEdDSAAndAppleNotarization),
             (.macAppStore, .appStoreReceiptAndAppleReview),
             (.managedDistribution, .organizationManaged): true
        default: false
        }
    }
}

public enum MacUpdateState: Equatable, Sendable {
    case current
    case available(MacUpdateMetadata)
    case deferred(String)
}

public enum MacUpdateAdapterError: Error, Equatable, Sendable {
    case invalidMetadata
    case adapterMismatch
}

/// Product shells inject a mature updater behind this boundary. Checking and
/// presenting remain separate so observing availability never installs code.
public protocol MacUpdateAdapter: Sendable {
    var updater: EstablishedMacUpdater { get }
    func checkForUpdates() async throws -> MacUpdateState
    func presentUpdate(_ metadata: MacUpdateMetadata) async throws
}

public extension MacUpdateAdapter {
    func validatedUpdateState() async throws -> MacUpdateState {
        let state = try await checkForUpdates()
        if case .available(let metadata) = state, metadata.updater != updater {
            throw MacUpdateAdapterError.adapterMismatch
        }
        return state
    }
}
