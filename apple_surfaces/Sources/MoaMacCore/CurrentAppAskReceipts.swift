import Darwin
import Foundation

public enum CurrentAppAskReceiptStage: String, Codable, Sendable {
    case pending, approved, released, terminal
}

public enum CurrentAppAskReceiptOutcome: String, Codable, Sendable {
    case pending, approved, released, canceled, expired, stale, failed, completed
}

public struct CurrentAppAskReceiptDraft: Equatable, Sendable {
    public let attemptID: UUID
    public let grantID: UUID
    public let stage: CurrentAppAskReceiptStage
    public let outcome: CurrentAppAskReceiptOutcome
    public let requestDigest: String
    public let semanticDigest: String
    public let screenshotDigest: String?
    public let destinationDigest: String
    public let scopeDigest: String
    public let recordedAt: Date
    public let errorCode: String?

    public init(
        attemptID: UUID,
        grantID: UUID,
        stage: CurrentAppAskReceiptStage,
        outcome: CurrentAppAskReceiptOutcome,
        requestDigest: String,
        semanticDigest: String,
        screenshotDigest: String?,
        destinationDigest: String,
        scopeDigest: String,
        recordedAt: Date,
        errorCode: String? = nil
    ) {
        self.attemptID = attemptID
        self.grantID = grantID
        self.stage = stage
        self.outcome = outcome
        self.requestDigest = requestDigest
        self.semanticDigest = semanticDigest
        self.screenshotDigest = screenshotDigest
        self.destinationDigest = destinationDigest
        self.scopeDigest = scopeDigest
        self.recordedAt = recordedAt
        self.errorCode = errorCode
    }
}

public struct CurrentAppAskReceipt: Codable, Equatable, Sendable {
    public let version: Int
    public let receiptID: UUID
    public let attemptID: UUID
    public let grantID: UUID
    public let stage: CurrentAppAskReceiptStage
    public let outcome: CurrentAppAskReceiptOutcome
    public let requestDigest: String
    public let semanticDigest: String
    public let screenshotDigest: String?
    public let destinationDigest: String
    public let scopeDigest: String
    public let recordedAt: Date
    public let errorCode: String?
    public let previousReceiptHash: String?
    public let receiptHash: String
}

public protocol CurrentAppAskReceiptJournaling: Sendable {
    func append(_ draft: CurrentAppAskReceiptDraft) throws -> CurrentAppAskReceipt
    func receipts() throws -> [CurrentAppAskReceipt]
}

public final class InMemoryCurrentAppAskReceiptJournal: CurrentAppAskReceiptJournaling, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [CurrentAppAskReceipt] = []
    public init() {}

    public func append(_ draft: CurrentAppAskReceiptDraft) throws -> CurrentAppAskReceipt {
        lock.withLock {
            let receipt = CurrentAppAskReceiptFactory.make(draft, previous: values.last?.receiptHash)
            values.append(receipt)
            return receipt
        }
    }

    public func receipts() throws -> [CurrentAppAskReceipt] { lock.withLock { values } }
}

public final class FsyncCurrentAppAskReceiptJournal: CurrentAppAskReceiptJournaling, @unchecked Sendable {
    public static let maximumJournalBytes = 4 * 1024 * 1024
    private let url: URL
    private let writer = POSIXAtomicReceiptWriter()

    public init(url: URL) { self.url = url }

    public func append(_ draft: CurrentAppAskReceiptDraft) throws -> CurrentAppAskReceipt {
        do {
            return try withFileLock {
                let current = try readUnlocked()
                let receipt = CurrentAppAskReceiptFactory.make(draft, previous: current.last?.receiptHash)
                let bytes = try Self.encode(current + [receipt])
                guard bytes.count <= Self.maximumJournalBytes else { throw CurrentAppAskError.journalFailure }
                do { try writer.replace(bytes, at: url) }
                catch { throw CurrentAppAskError.journalFailure }
                return receipt
            }
        } catch let error as CurrentAppAskError { throw error }
        catch { throw CurrentAppAskError.journalFailure }
    }

    public func receipts() throws -> [CurrentAppAskReceipt] {
        do { return try withFileLock { try readUnlocked() } }
        catch let error as CurrentAppAskError { throw error }
        catch { throw CurrentAppAskError.journalFailure }
    }

    private func readUnlocked() throws -> [CurrentAppAskReceipt] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= Self.maximumJournalBytes,
              let data = try? Data(contentsOf: url) else { throw CurrentAppAskError.journalFailure }
        do {
            var previous: String?
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try data.split(separator: 0x0a).map { line in
                let receipt = try decoder.decode(CurrentAppAskReceipt.self, from: Data(line))
                guard receipt.previousReceiptHash == previous,
                      CurrentAppAskReceiptFactory.verify(receipt) else {
                    throw CurrentAppAskError.journalFailure
                }
                previous = receipt.receiptHash
                return receipt
            }
        } catch let error as CurrentAppAskError { throw error }
        catch { throw CurrentAppAskError.journalFailure }
    }

    private func withFileLock<T>(_ body: () throws -> T) throws -> T {
        let directory = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let lockURL = directory.appendingPathComponent(".\(url.lastPathComponent).lock")
            let descriptor = open(lockURL.path, O_RDWR | O_CREAT, S_IRUSR | S_IWUSR)
            guard descriptor >= 0 else { throw CurrentAppAskError.journalFailure }
            defer { close(descriptor) }
            guard flock(descriptor, LOCK_EX) == 0 else { throw CurrentAppAskError.journalFailure }
            defer { _ = flock(descriptor, LOCK_UN) }
            return try body()
        } catch let error as CurrentAppAskError { throw error }
        catch { throw CurrentAppAskError.journalFailure }
    }

    private static func encode(_ receipts: [CurrentAppAskReceipt]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        var data = Data()
        for receipt in receipts {
            data.append(try encoder.encode(receipt))
            data.append(0x0a)
        }
        return data
    }
}

private enum CurrentAppAskReceiptFactory {
    private struct Unsigned: Codable {
        let version: Int
        let receiptID: UUID
        let attemptID: UUID
        let grantID: UUID
        let stage: CurrentAppAskReceiptStage
        let outcome: CurrentAppAskReceiptOutcome
        let requestDigest: String
        let semanticDigest: String
        let screenshotDigest: String?
        let destinationDigest: String
        let scopeDigest: String
        let recordedAt: Date
        let errorCode: String?
        let previousReceiptHash: String?
    }

    static func make(_ draft: CurrentAppAskReceiptDraft, previous: String?) -> CurrentAppAskReceipt {
        receipt(.init(
            version: 1,
            receiptID: UUID(),
            attemptID: draft.attemptID,
            grantID: draft.grantID,
            stage: draft.stage,
            outcome: draft.outcome,
            requestDigest: draft.requestDigest,
            semanticDigest: draft.semanticDigest,
            screenshotDigest: draft.screenshotDigest,
            destinationDigest: draft.destinationDigest,
            scopeDigest: draft.scopeDigest,
            recordedAt: draft.recordedAt,
            errorCode: draft.errorCode,
            previousReceiptHash: previous
        ))
    }

    static func verify(_ value: CurrentAppAskReceipt) -> Bool {
        digest(unsigned(value)) == value.receiptHash
    }

    private static func receipt(_ value: Unsigned) -> CurrentAppAskReceipt {
        CurrentAppAskReceipt(
            version: value.version,
            receiptID: value.receiptID,
            attemptID: value.attemptID,
            grantID: value.grantID,
            stage: value.stage,
            outcome: value.outcome,
            requestDigest: value.requestDigest,
            semanticDigest: value.semanticDigest,
            screenshotDigest: value.screenshotDigest,
            destinationDigest: value.destinationDigest,
            scopeDigest: value.scopeDigest,
            recordedAt: value.recordedAt,
            errorCode: value.errorCode,
            previousReceiptHash: value.previousReceiptHash,
            receiptHash: digest(value)
        )
    }

    private static func unsigned(_ value: CurrentAppAskReceipt) -> Unsigned {
        .init(
            version: value.version,
            receiptID: value.receiptID,
            attemptID: value.attemptID,
            grantID: value.grantID,
            stage: value.stage,
            outcome: value.outcome,
            requestDigest: value.requestDigest,
            semanticDigest: value.semanticDigest,
            screenshotDigest: value.screenshotDigest,
            destinationDigest: value.destinationDigest,
            scopeDigest: value.scopeDigest,
            recordedAt: value.recordedAt,
            errorCode: value.errorCode,
            previousReceiptHash: value.previousReceiptHash
        )
    }

    private static func digest(_ value: Unsigned) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return TranscriptDigest.sha256((try? encoder.encode(value)) ?? Data())
    }
}
