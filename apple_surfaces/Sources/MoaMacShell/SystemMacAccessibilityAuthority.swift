#if os(macOS)
import Foundation
import MoaMacCore

protocol MacSystemAccessibilityPlatform: AnyObject, Sendable {
    func validateProcess() throws
    func observe(requiredWindowID: String?, now: Date) throws -> MacAXProgramObservation
    func perform(_ request: MacAXActionRequest, executionID: String,
                 sequence: Int, now: Date) throws -> String?
}

/// Policy coordinator for the production Accessibility adapter. All target,
/// snapshot, window, expiry, and post-effect proof decisions live here and are
/// tested with a synthetic platform; raw AX calls remain in the thin adapter.
public final class SystemMacAccessibilityAuthority: MacAccessibilityProgramAuthority, @unchecked Sendable {
    private let lock = NSLock()
    private let process: ProcessIdentity
    private let grantID: String
    private let platform: any MacSystemAccessibilityPlatform
    private var current: MacAXProgramObservation?
    private var acceptedBindings: MacLocalProgramEnvelope.Bindings?

    public init(process: ProcessIdentity, applicationName: String, grantID: String) {
        self.process = process; self.grantID = grantID
        self.platform = ApplicationServicesMacAccessibilityPlatform(
            process: process, applicationName: applicationName)
    }

    init(process: ProcessIdentity, grantID: String, platform: any MacSystemAccessibilityPlatform) {
        self.process = process; self.grantID = grantID; self.platform = platform
    }

    public func validate(bindings: MacLocalProgramEnvelope.Bindings, now: Date) throws {
        try lock.withLock {
            guard bindings.localGrantID == grantID, bindings.bundleID == process.bundleID,
                  bindings.pid == process.pid, bindings.processGeneration == Self.generation(process),
                  bindings.signingIdentity == process.signingIdentity else {
                throw LocalProgramError.staleTarget
            }
            try platform.validateProcess()
            guard let current, current.binding.windowID == bindings.windowID,
                  now < current.binding.expiresAt else { throw LocalProgramError.staleObservation }
            if let acceptedBindings {
                guard acceptedBindings == bindings else { throw LocalProgramError.staleObservation }
            } else {
                guard current.binding.observationID == bindings.axSnapshotID,
                      MacLocalProgramDigest.axState(current) == bindings.stateSHA256 else {
                    throw LocalProgramError.staleObservation
                }
                acceptedBindings = bindings
            }
        }
    }

    public func observe(now: Date) throws -> MacAXProgramObservation {
        try lock.withLock {
            try platform.validateProcess()
            let requiredWindowID = acceptedBindings?.windowID ?? current?.binding.windowID
            let observation = try platform.observe(requiredWindowID: requiredWindowID, now: now)
            guard observation.binding.bundleID == process.bundleID,
                  observation.binding.pid == process.pid,
                  observation.binding.processGeneration == Self.generation(process),
                  requiredWindowID == nil || observation.binding.windowID == requiredWindowID,
                  now < observation.binding.expiresAt else { throw LocalProgramError.staleTarget }
            current = observation
            return observation
        }
    }

    public func perform(_ request: MacAXActionRequest, executionID: String,
                        sequence: Int, now: Date) throws -> MacAXActionOutcome {
        try lock.withLock {
            try platform.validateProcess()
            guard let current, current.binding.observationID == request.observationID,
                  now < current.binding.expiresAt else { throw LocalProgramError.staleObservation }
            let resourceID = try platform.perform(request, executionID: executionID,
                sequence: sequence, now: now)
            guard let post = try? platform.observe(requiredWindowID: current.binding.windowID, now: now),
                  post.binding.bundleID == process.bundleID, post.binding.pid == process.pid,
                  post.binding.processGeneration == Self.generation(process),
                  post.binding.windowID == current.binding.windowID,
                  now < post.binding.expiresAt else {
                self.current = nil
                return .init(postStateSHA256: nil, resourceID: resourceID)
            }
            self.current = post
            return .init(postStateSHA256: MacLocalProgramDigest.axState(post), resourceID: resourceID)
        }
    }

    private static func generation(_ process: ProcessIdentity) -> String {
        String(format: "%.6f", process.processStart.timeIntervalSince1970)
    }
}
#endif
