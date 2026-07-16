import Foundation

/// Hard limits for the passive, one-shot application observation exposed by this
/// package. Window contents, accessibility trees, screenshots, and credentials
/// are deliberately not part of this value.
public enum MacApplicationObservationLimits {
    public static let identifierBytes = 512
    public static let displayNameBytes = 512
}

public enum MacSurfaceAdapterError: Error, Equatable, Sendable {
    case unavailable
    case invalidObservation
    case wrongSurface
}

public struct MacActiveApplicationObservation: Codable, Equatable, Sendable {
    public let bundleIdentifier: String
    public let displayName: String?
    public let observedAt: Date

    public init(bundleIdentifier: String, displayName: String?, observedAt: Date) throws {
        let identifier = bundleIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !identifier.isEmpty,
              identifier.utf8.count <= MacApplicationObservationLimits.identifierBytes,
              displayName?.utf8.count ?? 0 <= MacApplicationObservationLimits.displayNameBytes
        else { throw MacSurfaceAdapterError.invalidObservation }
        self.bundleIdentifier = identifier
        self.displayName = displayName
        self.observedAt = observedAt
    }
}

public enum MacModelOutputPolicy: String, Codable, Sendable {
    /// Model output may be displayed or passed to the existing local approval
    /// coordinator. This adapter never turns it into an OS effect.
    case proposalOnly = "proposal_only"
}

public enum MacContextAvailability: String, Codable, Sendable { case available, unavailable }

public struct MacContextApplication: Codable, Equatable, Sendable {
    public let kind: String
    public let id: String
    public let origin: URL?
}

public struct MacContextPrivacy: Codable, Equatable, Sendable {
    public let pageContentIncluded: Bool
    public let windowContentIncluded: Bool
    public let credentialsIncluded: Bool
    enum CodingKeys: String, CodingKey {
        case pageContentIncluded = "page_content_included"
        case windowContentIncluded = "window_content_included"
        case credentialsIncluded = "credentials_included"
    }
}

public struct MacContextDescriptor: Codable, Equatable, Sendable {
    public let version: Int
    public let surface: String
    public let availability: MacContextAvailability
    public let reason: String?
    public let capturedAt: Date
    public let application: MacContextApplication?
    public let privacy: MacContextPrivacy
    enum CodingKeys: String, CodingKey {
        case version, surface, availability, reason, application, privacy
        case capturedAt = "captured_at"
    }

    public init(applicationID: String, capturedAt: Date) {
        self.version = 1
        self.surface = "macos"
        self.availability = .available
        self.reason = nil
        self.capturedAt = capturedAt
        self.application = MacContextApplication(kind: "native_application", id: applicationID, origin: nil)
        self.privacy = MacContextPrivacy(
            pageContentIncluded: false,
            windowContentIncluded: false,
            credentialsIncluded: false
        )
    }
}

public enum MacExecutionAdapterStatus: String, Codable, Sendable { case available, unavailable }
public enum MacAuthenticationState: String, Codable, Sendable { case notInspected = "not_inspected" }

public struct MacExecutionContextBinding: Codable, Equatable, Sendable {
    public let applicationID: String
    enum CodingKeys: String, CodingKey { case applicationID = "application_id" }
}

/// A credential-free advertisement of an executor owned by a product shell.
/// Merely including this descriptor never grants this library authority to use
/// the session or execute an operation.
public struct MacExecutionAdapterDescriptor: Codable, Equatable, Sendable {
    public let version: Int
    public let adapter: String
    public let status: MacExecutionAdapterStatus
    public let unavailableReason: String?
    public let credentialSource: String
    public let authenticationState: MacAuthenticationState
    public let contextBinding: MacExecutionContextBinding?
    public let modes: [String]
    public let constraints: [String]
    enum CodingKeys: String, CodingKey {
        case version, adapter, status, modes, constraints
        case unavailableReason = "unavailable_reason"
        case credentialSource = "credential_source"
        case authenticationState = "authentication_state"
        case contextBinding = "context_binding"
    }

    public init(adapter: String, status: MacExecutionAdapterStatus, unavailableReason: String? = nil,
                credentialSource: String = "local_signed_in_session", applicationID: String?, modes: [String]) throws {
        guard !adapter.isEmpty, adapter.utf8.count <= 160,
              credentialSource.utf8.count <= 160, modes.count <= 64,
              modes.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 160 }),
              applicationID?.utf8.count ?? 0 <= 512
        else { throw MacSurfaceAdapterError.invalidObservation }
        self.version = 1
        self.adapter = adapter
        self.status = status
        self.unavailableReason = unavailableReason
        self.credentialSource = credentialSource
        self.authenticationState = .notInspected
        self.contextBinding = applicationID.map(MacExecutionContextBinding.init(applicationID:))
        self.modes = modes
        self.constraints = [
            "local_allowlist_validation",
            "no_cookie_export",
            "no_provider_credentials",
            "proposal_before_execution",
        ]
    }
}

public struct MacCapabilityDescriptor: Codable, Equatable, Sendable {
    public let adapterID: String
    public let platform: String
    public let observations: [String]
    public let executableActions: [String]
    public let modelOutputPolicy: MacModelOutputPolicy
    public let requiresExplicitRead: Bool

    public static let activeApplication = MacCapabilityDescriptor(
        adapterID: "macos.public.active-application.v1",
        platform: "macos",
        observations: ["active_application.bundle_identifier", "active_application.display_name"],
        executableActions: [],
        modelOutputPolicy: .proposalOnly,
        requiresExplicitRead: true
    )
}

public struct MacSurfaceSnapshot: Codable, Equatable, Sendable {
    public let capability: MacCapabilityDescriptor
    public let contextDescriptor: MacContextDescriptor
    public let executionAdapters: [MacExecutionAdapterDescriptor]
    public let activeApplication: MacActiveApplicationObservation
}

public protocol MacActiveApplicationProviding: Sendable {
    func activeApplication(at date: Date) async throws -> MacActiveApplicationObservation
}

/// A bounded representation of a gateway/model proposal. Creating this value
/// performs no local action and grants no execution authority.
public struct InertMacActionProposal: Codable, Equatable, Sendable {
    public let proposalID: String
    public let proposalMessageID: String
    public let kind: String
    public let expiresAt: Date
    public let proposalDigest: String
}

/// Reusable macOS surface facade. Reads are caller initiated; it has no timer,
/// persistence, network transport, Accessibility observer, or action executor.
public actor MacSurfaceAdapter {
    private let provider: any MacActiveApplicationProviding
    private let now: @Sendable () -> Date

    public init(provider: any MacActiveApplicationProviding, now: @escaping @Sendable () -> Date = Date.init) {
        self.provider = provider
        self.now = now
    }

    public nonisolated var capability: MacCapabilityDescriptor { .activeApplication }

    public func observeActiveApplication() async throws -> MacSurfaceSnapshot {
        let observation = try await provider.activeApplication(at: now())
        return MacSurfaceSnapshot(
            capability: capability,
            contextDescriptor: MacContextDescriptor(
                applicationID: observation.bundleIdentifier,
                capturedAt: observation.observedAt
            ),
            executionAdapters: [],
            activeApplication: observation
        )
    }

    public func holdProposal(_ data: Data, expectedSurface: SurfaceIdentity) throws -> InertMacActionProposal {
        let proposal = try AggieEnvelopeDecoder.decodeProposal(data)
        guard proposal.surface == expectedSurface, proposal.surface.kind == .macOS else {
            throw MacSurfaceAdapterError.wrongSurface
        }
        return InertMacActionProposal(
            proposalID: proposal.payload.proposalID,
            proposalMessageID: proposal.messageID,
            kind: proposal.payload.kind.rawValue,
            expiresAt: proposal.payload.expiresAt,
            proposalDigest: try AggieDigest.proposal(proposal)
        )
    }
}

#if os(macOS)
import AppKit

/// Public-API implementation backed only by `NSWorkspace`. It intentionally
/// does not start Accessibility observation or read window/page contents.
public struct SystemMacActiveApplicationProvider: MacActiveApplicationProviding {
    public init() {}

    public func activeApplication(at date: Date) async throws -> MacActiveApplicationObservation {
        try await MainActor.run {
            guard let application = NSWorkspace.shared.frontmostApplication,
                  let bundleIdentifier = application.bundleIdentifier
            else { throw MacSurfaceAdapterError.unavailable }
            return try MacActiveApplicationObservation(
                bundleIdentifier: bundleIdentifier,
                displayName: application.localizedName,
                observedAt: date
            )
        }
    }
}
#endif
