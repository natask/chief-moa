import Foundation
import Testing
@testable import AggieAppleSurface
@testable import AggieSurfaceUI

private let macSurface = SurfaceIdentity(id: "moa-apple", kind: .macOS, mode: .text, deviceID: "dev-1")

private func macProposalData() throws -> Data {
    try JSONSerialization.data(withJSONObject: [
        "version": 2, "type": "action.proposed", "message_id": "msg-1", "session_id": "sess-1",
        "surface": ["id": "moa-apple", "kind": "macos", "mode": "text", "device_id": "dev-1"],
        "timestamp": "2023-11-14T22:13:20Z",
        "payload": ["proposal_id": "prop-1", "kind": "open_url", "approval_class": "confirm",
                    "expires_at": "2023-11-14T22:14:20Z", "preconditions": ["screen": "home"],
                    "params": ["url": "https://example.com"]]
    ])
}

private struct FakeApplicationProvider: MacActiveApplicationProviding {
    let bundleIdentifier: String
    let displayName: String?
    func activeApplication(at date: Date) async throws -> MacActiveApplicationObservation {
        try MacActiveApplicationObservation(bundleIdentifier: bundleIdentifier, displayName: displayName, observedAt: date)
    }
}

private actor FakeUpdater: MacUpdateAdapter {
    nonisolated let updater: EstablishedMacUpdater
    let state: MacUpdateState
    private(set) var presented = false

    init(updater: EstablishedMacUpdater, state: MacUpdateState) {
        self.updater = updater
        self.state = state
    }

    func checkForUpdates() async throws -> MacUpdateState { state }
    func presentUpdate(_ metadata: MacUpdateMetadata) async throws { presented = true }
}

@Test func activeApplicationReadIsBoundedAndDeclaresNoActions() async throws {
    let observedAt = Date(timeIntervalSince1970: 1_700_000_100)
    let adapter = MacSurfaceAdapter(
        provider: FakeApplicationProvider(bundleIdentifier: "com.apple.Safari", displayName: "Safari"),
        now: { observedAt }
    )
    let snapshot = try await adapter.observeActiveApplication()
    #expect(snapshot.activeApplication.bundleIdentifier == "com.apple.Safari")
    #expect(snapshot.activeApplication.observedAt == observedAt)
    #expect(snapshot.contextDescriptor.version == 1)
    #expect(snapshot.contextDescriptor.application?.id == "com.apple.Safari")
    #expect(snapshot.contextDescriptor.privacy.pageContentIncluded == false)
    #expect(snapshot.executionAdapters.isEmpty)
    #expect(snapshot.capability.executableActions.isEmpty)
    #expect(snapshot.capability.modelOutputPolicy == .proposalOnly)
    #expect(snapshot.capability.requiresExplicitRead)

    let encoded = try JSONEncoder().encode(snapshot.contextDescriptor)
    let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(json["captured_at"] != nil)
    #expect(json["document"] == nil)
    let privacy = try #require(json["privacy"] as? [String: Any])
    #expect(privacy["page_content_included"] as? Bool == false)
    #expect(privacy["credentials_included"] as? Bool == false)
}

@Test func executionAdapterDescriptorExportsNoCredentialsOrExecutionAuthority() throws {
    let descriptor = try MacExecutionAdapterDescriptor(
        adapter: "browser.session.v1",
        status: .available,
        applicationID: "com.apple.Safari",
        modes: ["navigate"]
    )
    #expect(descriptor.version == 1)
    #expect(descriptor.credentialSource == "local_signed_in_session")
    #expect(descriptor.authenticationState == .notInspected)
    #expect(descriptor.constraints.contains("no_cookie_export"))
}

@Test func applicationObservationRejectsUnboundedIdentity() throws {
    #expect(throws: MacSurfaceAdapterError.invalidObservation) {
        try MacActiveApplicationObservation(bundleIdentifier: String(repeating: "a", count: 513), displayName: nil, observedAt: Date())
    }
}

@Test func heldProposalRemainsInertAndSurfaceBound() async throws {
    let data = try macProposalData()
    let adapter = MacSurfaceAdapter(provider: FakeApplicationProvider(bundleIdentifier: "com.apple.Safari", displayName: nil))
    let held = try await adapter.holdProposal(data, expectedSurface: macSurface)
    #expect(held.proposalID == "prop-1")
    #expect(held.kind == "open_url")
    #expect(held.proposalDigest == "ef5cb445055779eaf372ae531c414cdab4aefbeb85aa6929f5068d63ca750632")

    let ios = SurfaceIdentity(id: "moa-apple", kind: .iOS, mode: .text, deviceID: "dev-1")
    await #expect(throws: MacSurfaceAdapterError.wrongSurface) {
        try await adapter.holdProposal(data, expectedSurface: ios)
    }
}

@Test func updateMetadataRequiresAnEstablishedMatchingAuthority() throws {
    _ = try MacUpdateMetadata(
        version: "1.2.3", build: "42", updater: .sparkle2,
        verificationAuthority: .sparkleEdDSAAndAppleNotarization,
        releaseNotesURL: URL(string: "https://example.test/releases/1.2.3")
    )
    #expect(throws: MacUpdateAdapterError.invalidMetadata) {
        try MacUpdateMetadata(
            version: "1.2.3", build: "42", updater: .sparkle2,
            verificationAuthority: .organizationManaged
        )
    }
}

@Test func updateCheckCannotCrossUpdaterAuthoritiesOrInstallImplicitly() async throws {
    let metadata = try MacUpdateMetadata(
        version: "1.2.3", build: "42", updater: .sparkle2,
        verificationAuthority: .sparkleEdDSAAndAppleNotarization
    )
    let updater = FakeUpdater(updater: .sparkle2, state: .available(metadata))
    #expect(try await updater.validatedUpdateState() == .available(metadata))
    #expect(await updater.presented == false)

    let mismatch = FakeUpdater(updater: .managedDistribution, state: .available(metadata))
    await #expect(throws: MacUpdateAdapterError.adapterMismatch) {
        try await mismatch.validatedUpdateState()
    }
}

@Test func observationAndExecutorDescriptorsRejectEveryInvalidBoundary() throws {
    #expect(throws: MacSurfaceAdapterError.invalidObservation) {
        try MacActiveApplicationObservation(bundleIdentifier: "   ", displayName: nil, observedAt: Date())
    }
    #expect(throws: MacSurfaceAdapterError.invalidObservation) {
        try MacActiveApplicationObservation(bundleIdentifier: "valid", displayName: String(repeating: "x", count: 513), observedAt: Date())
    }
    for create in [
        { try MacExecutionAdapterDescriptor(adapter: "", status: .available, applicationID: nil, modes: []) },
        { try MacExecutionAdapterDescriptor(adapter: String(repeating: "x", count: 161), status: .available, applicationID: nil, modes: []) },
        { try MacExecutionAdapterDescriptor(adapter: "a", status: .available, credentialSource: String(repeating: "x", count: 161), applicationID: nil, modes: []) },
        { try MacExecutionAdapterDescriptor(adapter: "a", status: .available, applicationID: nil, modes: [""]) },
        { try MacExecutionAdapterDescriptor(adapter: "a", status: .available, applicationID: String(repeating: "x", count: 513), modes: []) },
    ] { #expect(throws: MacSurfaceAdapterError.invalidObservation) { try create() } }
    let unavailable = try MacExecutionAdapterDescriptor(adapter: "a", status: .unavailable,
        unavailableReason: "disabled", applicationID: nil, modes: [])
    #expect(unavailable.contextBinding == nil)
}

@Test func updateMetadataRejectsMalformedVersionsURLsAndOtherMismatches() throws {
    for create in [
        { try MacUpdateMetadata(version: "", build: "1", updater: .sparkle2, verificationAuthority: .sparkleEdDSAAndAppleNotarization) },
        { try MacUpdateMetadata(version: "1!", build: "1", updater: .sparkle2, verificationAuthority: .sparkleEdDSAAndAppleNotarization) },
        { try MacUpdateMetadata(version: "1", build: String(repeating: "1", count: 65), updater: .sparkle2, verificationAuthority: .sparkleEdDSAAndAppleNotarization) },
        { try MacUpdateMetadata(version: "1", build: "1", updater: .macAppStore, verificationAuthority: .appStoreReceiptAndAppleReview, releaseNotesURL: URL(string: "http://example.test")) },
        { try MacUpdateMetadata(version: "1", build: "1", updater: .managedDistribution, verificationAuthority: .sparkleEdDSAAndAppleNotarization) },
    ] { #expect(throws: MacUpdateAdapterError.invalidMetadata) { try create() } }
    _ = try MacUpdateMetadata(version: "1", build: "1", updater: .macAppStore, verificationAuthority: .appStoreReceiptAndAppleReview)
    _ = try MacUpdateMetadata(version: "1", build: "1", updater: .managedDistribution, verificationAuthority: .organizationManaged)
}

@Test func updateValidationPassesNonAvailableStatesAndPresentationIsExplicit() async throws {
    let current = FakeUpdater(updater: .sparkle2, state: .current)
    #expect(try await current.validatedUpdateState() == .current)
    let deferred = FakeUpdater(updater: .sparkle2, state: .deferred("later"))
    #expect(try await deferred.validatedUpdateState() == .deferred("later"))
    let metadata = try MacUpdateMetadata(version: "1", build: "1", updater: .sparkle2,
        verificationAuthority: .sparkleEdDSAAndAppleNotarization)
    try await current.presentUpdate(metadata)
    #expect(await current.presented)
}

#if os(macOS)
@Test func systemProviderAttemptsOnlyPublicFrontmostApplicationRead() async {
    let provider = SystemMacActiveApplicationProvider()
    _ = try? await provider.activeApplication(at: Date())
}
#endif

@MainActor @Test func approvalShellExposesEverySafetyStateCopy() {
    for state in ApprovalUXState.allCases {
        #expect(!state.title.isEmpty)
        #expect(!state.detail.isEmpty)
    }
    _ = ApprovalSurfaceView().body
}
