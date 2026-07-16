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
                    call: @escaping @Sendable (String, String) -> String) throws -> MacProgramRunnerOutcome {
        let process = Process()
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.executableURL = executableURL
        process.arguments = ["--stdio-v1"]
        process.environment = ["LANG": "C", "LC_ALL": "C", "LLVM_PROFILE_FILE": "/dev/null"]
        process.standardInput = input; process.standardOutput = output; process.standardError = errors

        let terminal = DispatchSemaphore(value: 0)
        let state = RunnerState(input: input, handle: handle, call: call, terminal: terminal)
        output.fileHandleForReading.readabilityHandler = { file in
            let data = file.availableData
            if data.isEmpty { state.finishEOF(); return }
            state.consume(data)
        }
        try process.run()
        handle.attach(process)
        try state.send(["kind": "start", "source": source])

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
        private let call: @Sendable (String, String) -> String
        private let terminal: DispatchSemaphore
        private var buffer = Data()
        private var outputJSON: String?
        private var error: String?
        private var finished = false

        init(input: Pipe, handle: MacProgramRunnerHandle,
             call: @escaping @Sendable (String, String) -> String,
             terminal: DispatchSemaphore) {
            self.input = input; self.handle = handle; self.call = call; self.terminal = terminal
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
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let kind = object["kind"] as? String else { return }
            if kind == "call", let id = object["id"] as? Int,
               let capability = object["capability_id"] as? String,
               let inputJSON = object["input_json"] as? String {
                guard handle.admitCall() else { return }
                let response = call(capability, inputJSON)
                handle.completeCall()
                guard handle.isActive else { return }
                try? send(["kind": "call_result", "id": id, "output_json": response])
            } else if kind == "terminal" {
                lock.withLock {
                    guard !finished else { return }
                    outputJSON = object["output_json"] as? String
                    error = object["error"] == nil ? nil : "program runner failed"
                    finished = true; terminal.signal()
                }
            }
        }
    }
}
#endif
