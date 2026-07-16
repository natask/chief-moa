#if os(macOS)
import AppKit
import ApplicationServices
import Foundation
import MoaMacCore

@MainActor public protocol TranscriptInsertionAXAdapting: AnyObject {
    func captureFocusedTarget() throws -> TranscriptTargetBinding
    func revalidateAndSet(_ preview: TranscriptInsertionPreview, binding: TranscriptTargetBinding) throws
}

@MainActor public protocol TranscriptInsertionApproving: AnyObject {
    func approve(_ preview: TranscriptInsertionPreview) async -> Bool
}

@MainActor public final class TranscriptInsertionCoordinator {
    private let adapter: any TranscriptInsertionAXAdapting
    private let journal: any TranscriptReceiptJournaling
    private let now: @Sendable () -> Date
    public private(set) var binding: TranscriptTargetBinding?

    public init(
        adapter: any TranscriptInsertionAXAdapting,
        journal: any TranscriptReceiptJournaling,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.adapter = adapter
        self.journal = journal
        self.now = now
    }

    @discardableResult public func captureBeforeMoaTakesFocus() -> Bool {
        do {
            binding = try adapter.captureFocusedTarget()
            return true
        } catch {
            binding = nil
            return false
        }
    }

    public func clear() { binding = nil }

    @discardableResult public func insertLiteralTranscript(
        _ transcript: String,
        approver: any TranscriptInsertionApproving
    ) async throws -> TranscriptInsertionReceipt {
        guard let binding else { throw TranscriptInsertionError.noTarget }
        let preview = try TranscriptInsertionPreview(binding: binding, literalTranscript: transcript)
        guard await approver.approve(preview) else { throw TranscriptInsertionError.denied }
        self.binding = nil

        let pending = TranscriptReceiptDraft(
            attemptID: preview.attemptID,
            targetID: preview.targetID,
            stage: .pending,
            outcome: .pending,
            targetStateDigest: binding.stateFingerprint,
            transcriptDigest: preview.transcriptDigest,
            transcriptBytes: preview.transcriptBytes,
            recordedAt: now()
        )
        do {
            _ = try journal.append(pending)
        } catch {
            throw TranscriptInsertionError.journalFailure
        }

        do {
            // The adapter owns the last read and AXValue mutation in one
            // synchronous MainActor call, leaving no suspension gap.
            try adapter.revalidateAndSet(preview, binding: binding)
        } catch {
            let insertionError = error as? TranscriptInsertionError ?? .staleState
            _ = try? journal.append(.init(
                attemptID: preview.attemptID,
                targetID: preview.targetID,
                stage: .terminal,
                outcome: .rejected,
                targetStateDigest: binding.stateFingerprint,
                transcriptDigest: preview.transcriptDigest,
                transcriptBytes: preview.transcriptBytes,
                recordedAt: now(),
                errorCode: insertionError.rawValue
            ))
            throw insertionError
        }
        do {
            return try journal.append(.init(
                attemptID: preview.attemptID,
                targetID: preview.targetID,
                stage: .terminal,
                outcome: .inserted,
                targetStateDigest: binding.stateFingerprint,
                transcriptDigest: preview.transcriptDigest,
                transcriptBytes: preview.transcriptBytes,
                recordedAt: now()
            ))
        } catch {
            // The durable pending receipt remains the crash-recovery truth.
            // Never mislabel an already-applied value as a rejected mutation.
            throw TranscriptInsertionError.terminalJournalFailure
        }
    }
}

@MainActor public final class SystemTranscriptInsertionAXAdapter: TranscriptInsertionAXAdapting {
    private struct BoundAXTarget {
        let binding: TranscriptTargetBinding
        let app: AXUIElement
        let window: AXUIElement
        let element: AXUIElement
    }

    private var target: BoundAXTarget?

    public init() {}

    public func captureFocusedTarget() throws -> TranscriptTargetBinding {
        guard AXIsProcessTrusted(),
              let running = NSWorkspace.shared.frontmostApplication,
              running.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              let process = ProcessInspector.identity(running) else {
            throw TranscriptInsertionError.noTarget
        }
        let app = AXUIElementCreateApplication(process.pid)
        let window = try elementAttribute(app, kAXFocusedWindowAttribute)
        let element = try elementAttribute(app, kAXFocusedUIElementAttribute)
        let state = try state(process: process, window: window, element: element)
        let binding = try TranscriptTargetBinding(capturedAt: Date(), state: state)
        target = BoundAXTarget(binding: binding, app: app, window: window, element: element)
        return binding
    }

    public func revalidateAndSet(_ preview: TranscriptInsertionPreview, binding: TranscriptTargetBinding) throws {
        guard let target, target.binding == binding, target.binding.id == preview.targetID else {
            throw TranscriptInsertionError.noTarget
        }
        guard let running = NSRunningApplication(processIdentifier: binding.state.process.pid),
              ProcessInspector.identity(running) == binding.state.process else {
            throw TranscriptInsertionError.wrongApplication
        }
        let currentWindow = try elementAttribute(target.app, kAXFocusedWindowAttribute, error: .focusChanged)
        let currentElement = try elementAttribute(target.app, kAXFocusedUIElementAttribute, error: .focusChanged)
        guard CFEqual(currentWindow, target.window), CFEqual(currentElement, target.element) else {
            throw TranscriptInsertionError.focusChanged
        }
        let current = try state(process: binding.state.process, window: currentWindow, element: currentElement)
        try TranscriptInsertionPolicy.validate(binding: binding, current: current)

        let rawValue = try stringAttribute(currentElement, kAXValueAttribute, error: .staleState)
        let range = NSRange(location: current.selection.location, length: current.selection.length)
        guard NSMaxRange(range) <= (rawValue as NSString).length else {
            throw TranscriptInsertionError.invalidSelection
        }
        let nextValue = (rawValue as NSString).replacingCharacters(in: range, with: preview.literalTranscript)

        // One final state read occurs directly adjacent to AXValue set. Any
        // target, focus, value, selection, role, secure, or settable change
        // rejects before the only mutating API call in this adapter.
        let finalWindow = try elementAttribute(target.app, kAXFocusedWindowAttribute, error: .focusChanged)
        let finalElement = try elementAttribute(target.app, kAXFocusedUIElementAttribute, error: .focusChanged)
        guard CFEqual(finalWindow, target.window), CFEqual(finalElement, target.element) else {
            throw TranscriptInsertionError.focusChanged
        }
        let finalState = try state(process: binding.state.process, window: finalWindow, element: finalElement)
        try TranscriptInsertionPolicy.validate(binding: binding, current: finalState)
        guard AXUIElementSetAttributeValue(finalElement, kAXValueAttribute as CFString, nextValue as CFTypeRef) == .success else {
            throw TranscriptInsertionError.nonSettable
        }
        self.target = nil
    }

    private func state(process: ProcessIdentity, window: AXUIElement, element: AXUIElement) throws -> TranscriptTargetState {
        let role = try stringAttribute(element, kAXRoleAttribute, error: .unsupportedRole)
        let subrole = optionalStringAttribute(element, kAXSubroleAttribute)
        let protected = boolAttribute(element, "AXProtectedContent") ?? false
        let secure = role == "AXSecureTextField" ||
            subrole?.localizedCaseInsensitiveContains("secure") == true ||
            subrole?.localizedCaseInsensitiveContains("password") == true || protected
        var settable = DarwinBoolean(false)
        let settableStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        let value = try stringAttribute(element, kAXValueAttribute, error: .staleState)
        let selection = try selectedRange(element)
        let windowFingerprint = TranscriptDigest.sha256([
            optionalNumberAttribute(window, "AXWindowNumber").map(String.init) ?? "no-window-number",
            optionalStringAttribute(window, kAXRoleAttribute) ?? "",
            TranscriptDigest.sha256(optionalStringAttribute(window, kAXTitleAttribute) ?? ""),
        ].joined(separator: "\u{1f}"))
        let elementFingerprint = TranscriptDigest.sha256([
            role,
            subrole ?? "",
            optionalStringAttribute(element, kAXIdentifierAttribute) ?? "",
            windowFingerprint,
        ].joined(separator: "\u{1f}"))
        return TranscriptTargetState(
            process: process,
            windowFingerprint: windowFingerprint,
            elementFingerprint: elementFingerprint,
            role: role,
            subrole: subrole,
            secure: secure,
            settable: settableStatus == .success && settable.boolValue,
            // `element` was obtained from the application's
            // kAXFocusedUIElementAttribute in the same synchronous call. The
            // app becomes inactive while Moa previews the transcript, so its
            // separate AXFocused boolean is not a reliable continuity signal.
            focused: true,
            valueDigest: TranscriptDigest.sha256(value),
            valueUTF16Count: (value as NSString).length,
            selection: selection
        )
    }

    private func selectedRange(_ element: AXUIElement) throws -> TranscriptSelection {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &raw) == .success,
              let raw, CFGetTypeID(raw) == AXValueGetTypeID() else {
            throw TranscriptInsertionError.invalidSelection
        }
        var range = CFRange()
        guard AXValueGetValue(raw as! AXValue, .cfRange, &range) else {
            throw TranscriptInsertionError.invalidSelection
        }
        return TranscriptSelection(location: range.location, length: range.length)
    }

    private func elementAttribute(
        _ element: AXUIElement,
        _ attribute: String,
        error: TranscriptInsertionError = .noTarget
    ) throws -> AXUIElement {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { throw error }
        return unsafeDowncast(raw, to: AXUIElement.self)
    }

    private func stringAttribute(
        _ element: AXUIElement,
        _ attribute: String,
        error: TranscriptInsertionError
    ) throws -> String {
        guard let value = optionalStringAttribute(element, attribute) else { throw error }
        return value
    }

    private func optionalStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return raw as? String
    }

    private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return raw as? Bool
    }

    private func optionalNumberAttribute(_ element: AXUIElement, _ attribute: String) -> Int? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return (raw as? NSNumber)?.intValue
    }
}

@MainActor public final class SystemTranscriptInsertionApprover: TranscriptInsertionApproving {
    public init() {}

    public func approve(_ preview: TranscriptInsertionPreview) async -> Bool {
        let alert = NSAlert()
        alert.messageText = "Insert this exact transcript?"
        alert.informativeText = "Target: \(preview.applicationBundleID) (\(preview.role))\n\nOnly the literal text shown below will be inserted at the previously bound cursor. Moa will not click, submit, or press a key."
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 460, height: 150))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let text = NSTextView(frame: scroll.bounds)
        text.isEditable = false
        text.isSelectable = true
        text.string = preview.literalTranscript
        text.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        scroll.documentView = text
        alert.accessoryView = scroll
        alert.addButton(withTitle: "Insert exact text")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

public enum SystemTranscriptReceiptJournal {
    public static func make() -> FsyncTranscriptReceiptJournal {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ??
            FileManager.default.temporaryDirectory
        let url = base.appendingPathComponent("app.agee.moa.mac", isDirectory: true)
            .appendingPathComponent("transcript-insertion-receipts.jsonl")
        let journal = FsyncTranscriptReceiptJournal(url: url)
        _ = try? journal.recoverInterrupted(at: Date())
        return journal
    }
}
#endif
