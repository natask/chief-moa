#if os(macOS)
import Foundation
import Darwin
import MoaMacCore

struct MacProgramRunnerOutcome: Sendable {
    let outputJSON: String?
    let error: String?
    let timedOut: Bool
}

final class MacProgramRunnerHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var active = true
    private var process: Process?
    private var admittedCalls = 0

    func attach(_ process: Process) {
        lock.withLock {
            self.process = process
            if !active { terminateLocked(process) }
        }
    }

    func admitCall() -> Bool {
        lock.withLock {
            guard active else { return false }
            admittedCalls += 1
            return true
        }
    }

    func completeCall() { lock.withLock { admittedCalls = max(0, admittedCalls - 1) } }

    var isActive: Bool { lock.withLock { active } }

    var hasInFlightCall: Bool { lock.withLock { admittedCalls > 0 } }

    func stop() {
        lock.withLock {
            guard active else { return }
            active = false
            if let process { terminateLocked(process) }
        }
    }

    private func terminateLocked(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(100)) {
            if process.isRunning { Darwin.kill(pid, SIGKILL) }
        }
    }
}

enum MacProgramProcessRunner {
    static func run(executableURL: URL, source: String, wallMS: Int,
                    handle: MacProgramRunnerHandle,
                    resultBytes: Int = LocalProgramLimits.outputBytes,
                    logBytes: Int = LocalProgramLimits.logBytes,
                    progress: @escaping @Sendable (String, Int, Int) -> Bool = { _, _, _ in true },
                    call: @escaping @Sendable (String, String) -> String) throws -> MacProgramRunnerOutcome {
        let process = Process()
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.executableURL = executableURL
        process.arguments = ["--stdio-v1"]
        process.environment = ["LANG": "C", "LC_ALL": "C", "LLVM_PROFILE_FILE": "/dev/null"]
        process.standardInput = input; process.standardOutput = output; process.standardError = errors

        let terminal = DispatchSemaphore(value: 0)
        let state = RunnerState(input: input, handle: handle, logBytes: logBytes,
            progress: progress, call: call, terminal: terminal)
        output.fileHandleForReading.readabilityHandler = { file in
            let data = file.availableData
            if data.isEmpty { state.finishEOF(); return }
            state.consume(data)
        }
        try process.run()
        handle.attach(process)
        try state.send(["kind": "start", "source": source,
            "result_bytes": resultBytes, "log_bytes": logBytes])

        let wait = terminal.wait(timeout: .now() + .milliseconds(wallMS))
        let timedOut = wait == .timedOut
        if timedOut { handle.stop(); _ = terminal.wait(timeout: .now() + .milliseconds(250)) }
        handle.stop()
        output.fileHandleForReading.readabilityHandler = nil
        try? input.fileHandleForWriting.close()
        if process.isRunning { process.waitUntilExit() }
        let result = state.outcome(timedOut: timedOut)
        if !result.timedOut, result.outputJSON == nil, result.error == nil {
            let diagnostic = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
            return .init(outputJSON: nil,
                error: diagnostic?.isEmpty == false ? "program runner failed" : "program runner closed",
                timedOut: false)
        }
        return result
    }

    final class RunnerState: @unchecked Sendable {
        private let lock = NSLock()
        private let input: Pipe
        private let handle: MacProgramRunnerHandle
        private let logBytes: Int
        private let progress: @Sendable (String, Int, Int) -> Bool
        private let call: @Sendable (String, String) -> String
        private let terminal: DispatchSemaphore
        private var buffer = Data()
        private var outputJSON: String?
        private var error: String?
        private var finished = false
        private var emittedProgressBytes = 0
        private var abortPolls = 0
        private static let allowedProgressMessages: Set<String> = [
            "Processing local items.",
            "Processed local items.",
            "Trying a safe local alternative.",
            "Local work completed.",
        ]

        init(input: Pipe, handle: MacProgramRunnerHandle,
             logBytes: Int = LocalProgramLimits.logBytes,
             progress: @escaping @Sendable (String, Int, Int) -> Bool = { _, _, _ in true },
             call: @escaping @Sendable (String, String) -> String,
             terminal: DispatchSemaphore) {
            self.input = input; self.handle = handle; self.logBytes = logBytes
            self.progress = progress; self.call = call; self.terminal = terminal
        }

        func consume(_ data: Data) {
            lock.lock(); buffer.append(data)
            if buffer.count > LocalProgramLimits.outputBytes + 16 * 1024 {
                error = "program runner frame exceeded local limit"
                finished = true
                terminal.signal()
                lock.unlock()
                handle.stop()
                return
            }
            var lines: [Data] = []
            while let newline = buffer.firstIndex(of: 0x0a) {
                lines.append(buffer[..<newline])
                buffer.removeSubrange(...newline)
            }
            lock.unlock()
            for line in lines { process(line) }
        }

        func finishEOF() {
            lock.withLock {
                guard !finished else { return }
                finished = true; terminal.signal()
            }
        }

        func send(_ object: [String: Any]) throws {
            let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            input.fileHandleForWriting.write(data + Data([0x0a]))
        }

        func outcome(timedOut: Bool) -> MacProgramRunnerOutcome {
            lock.withLock { .init(outputJSON: outputJSON, error: error, timedOut: timedOut) }
        }

        private func process(_ line: Data) {
            if lock.withLock({ finished }) {
                lock.withLock {
                    outputJSON = nil
                    error = "program runner protocol violation"
                }
                handle.stop()
                return
            }
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let kind = object["kind"] as? String else {
                fail("program runner protocol violation"); return
            }
            if kind == "call", Set(object.keys) == ["kind", "id", "capability_id", "input_json"],
               let id = object["id"] as? Int,
               let capability = object["capability_id"] as? String,
               let inputJSON = object["input_json"] as? String {
                guard handle.admitCall() else { return }
                let response = call(capability, inputJSON)
                handle.completeCall()
                guard handle.isActive else { return }
                try? send(["kind": "call_result", "id": id, "output_json": response])
            } else if kind == "progress",
                      Set(object.keys) == ["kind", "id", "message", "completed", "total"],
                      let id = object["id"] as? Int,
                      let message = object["message"] as? String,
                      let completed = object["completed"] as? Int,
                      let total = object["total"] as? Int,
                      Self.allowedProgressMessages.contains(message), message.utf8.count <= 240,
                      completed >= 0, total >= 0, completed <= total {
                let nextBytes = emittedProgressBytes + message.utf8.count
                guard nextBytes <= logBytes, progress(message, completed, total), handle.isActive else {
                    try? send(["kind": "progress_result", "id": id, "ok": false])
                    fail("program runner progress rejected"); return
                }
                emittedProgressBytes = nextBytes
                try? send(["kind": "progress_result", "id": id, "ok": true])
            } else if kind == "abort_poll", Set(object.keys) == ["kind", "id"],
                      let id = object["id"] as? Int {
                abortPolls += 1
                guard abortPolls <= 256 else {
                    fail("program runner abort channel exceeded local limit"); return
                }
                try? send(["kind": "abort_result", "id": id, "aborted": !handle.isActive])
            } else if kind == "terminal",
                      (Set(object.keys) == ["kind", "output_json"] ||
                       Set(object.keys) == ["kind", "error"]) {
                lock.withLock {
                    guard !finished else { return }
                    outputJSON = object["output_json"] as? String
                    error = object["error"] == nil ? nil : "program runner failed"
                    finished = true; terminal.signal()
                }
            } else {
                fail("program runner protocol violation")
            }
        }

        private func fail(_ message: String) {
            let shouldStop = lock.withLock { () -> Bool in
                guard !finished else { return false }
                error = message; finished = true; terminal.signal(); return true
            }
            if shouldStop { handle.stop() }
        }
    }
}
#endif
