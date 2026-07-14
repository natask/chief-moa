import Foundation
import Testing
@testable import AggieAppleSurface

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
    let data = try proposalData()
    let adapter = MacSurfaceAdapter(provider: FakeApplicationProvider(bundleIdentifier: "com.apple.Safari", displayName: nil))
    let held = try await adapter.holdProposal(data, expectedSurface: surface)
    #expect(held.proposalID == "prop-1")
    #expect(held.kind == "open_url")
    #expect(held.proposalDigest == "ef5cb445055779eaf372ae531c414cdab4aefbeb85aa6929f5068d63ca750632")

    let ios = SurfaceIdentity(id: "moa-apple", kind: "ios", mode: "text", deviceID: "dev-1")
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
