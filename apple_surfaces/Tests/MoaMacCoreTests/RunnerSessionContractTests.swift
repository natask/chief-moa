#if os(macOS)
import Foundation
import MoaMacProgramRunnerCore
@testable import MoaMacShell
import Testing

private func runnerTranscript(source: String, resultBytes: Int = 65_536,
                              logBytes: Int = 32_768,
                              responder: (([String: Any]) -> [String: Any]?)? = nil)
    -> (code: Int32, frames: [[String: Any]]) {
    var input: [[String: Any]] = [["kind": "start", "source": source,
        "result_bytes": resultBytes, "log_bytes": logBytes]]
    var frames: [[String: Any]] = []
    let code = MacProgramRunnerSession.run(arguments: ["runner", "--stdio-v1"], read: {
        input.isEmpty ? nil : input.removeFirst()
    }, write: { frame in
        frames.append(frame)
        if let response = responder?(frame) { input.append(response) }
    })
    return (code, frames)
}

@Test func runnerInvokesLiteralAsyncMainAndKeepsPromise() {
    let transcript = runnerTranscript(source: #"""
    async function main(runtime) {
      await Promise.resolve();
      return {promise:typeof Promise, same:runtime.tools === tools};
    }
    """#)
    #expect(transcript.code == 0)
    #expect(transcript.frames.last?["output_json"] as? String ==
        #"{"promise":"function","same":true}"#)
}

@Test func runnerRejectsMissingOrNonFunctionMainAndLegacyBody() {
    for source in ["const other = 1;", "const main = 7;", "return 1;"] {
        let transcript = runnerTranscript(source: source)
        #expect(transcript.frames.last?["error"] as? String == "runtime_failed")
    }
}

@Test func rawHostBindingsAreAbsentAndToolsCannotBeReplacedOrMutated() {
    let transcript = runnerTranscript(source: #"""
    "use strict";
    async function main({tools}) {
      const before = tools.macos.app.current;
      let replace = false, mutate = false;
      try { globalThis.tools = {}; } catch (_) { replace = true; }
      try { tools.macos.app.current = 3; } catch (_) { mutate = true; }
      return {
        ambient:[typeof host,typeof call,typeof decode,typeof accessibility,typeof __moaMacHost],
        frozen:Object.isFrozen(tools) && Object.isFrozen(tools.macos) &&
          Object.isFrozen(tools.macos.app) && Object.isFrozen(before),
        intact:tools.macos.app.current === before,
        replace, mutate,
        descriptor:Object.getOwnPropertyDescriptor(globalThis,"tools").configurable
      };
    }
    """#)
    let output = transcript.frames.last?["output_json"] as? String
    #expect(output?.contains(#""ambient":["undefined","undefined","undefined","undefined","undefined"]"#) == true)
    #expect(output?.contains(#""frozen":true"#) == true)
    #expect(output?.contains(#""intact":true"#) == true)
    #expect(output?.contains(#""descriptor":false"#) == true)
}

@Test func promisedToolAbortProgressAndExplicitResultUseClosedFrames() {
    let transcript = runnerTranscript(source: #"""
    async function main({tools,signal,progress,result}) {
      if (signal.aborted) throw new Error("aborted");
      progress("Processed local items.", 1, 2);
      const app = await tools.macos.app.current();
      result({name:app.name});
    }
    """#, responder: { frame in
        let id = frame["id"] as? Int
        switch frame["kind"] as? String {
        case "abort_poll": return ["kind": "abort_result", "id": id!, "aborted": false]
        case "progress": return ["kind": "progress_result", "id": id!, "ok": true]
        case "call": return ["kind": "call_result", "id": id!,
                             "output_json": #"{"name":"Fixture"}"#]
        default: return nil
        }
    })
    #expect(transcript.frames.map { $0["kind"] as? String } ==
        ["abort_poll", "progress", "call", "terminal"])
    #expect(transcript.frames.last?["output_json"] as? String == #"{"name":"Fixture"}"#)
}

@Test func channelsFailClosedOnBadRepliesAndResultBounds() {
    let rejected = runnerTranscript(source: #"""
    async function main({progress}) { progress("One.", 1, 1); return 1; }
    """#, responder: { frame in
        guard frame["kind"] as? String == "progress", let id = frame["id"] as? Int else { return nil }
        return ["kind": "progress_result", "id": id, "ok": false, "extra": true]
    })
    #expect(rejected.frames.last?["error"] as? String == "runtime_failed")

    let oversized = runnerTranscript(source: "function main(){ return 'long'; }", resultBytes: 2)
    #expect(oversized.frames.last?["error"] as? String == "limit_exceeded")

    let aborted = runnerTranscript(source:
        "function main({signal}) { if (signal.aborted) throw new Error('stop'); return 1; }",
        responder: { frame in
            guard frame["kind"] as? String == "abort_poll", let id = frame["id"] as? Int else { return nil }
            return ["kind": "abort_result", "id": id, "aborted": true]
        })
    #expect(aborted.frames.last?["error"] as? String == "runtime_failed")

    let malformedAbort = runnerTranscript(source:
        "function main({signal}) { return signal.aborted; }", responder: { frame in
            guard frame["kind"] as? String == "abort_poll", let id = frame["id"] as? Int else { return nil }
            return ["kind": "abort_result", "id": id, "aborted": "invalid"]
        })
    #expect(malformedAbort.frames.last?["output_json"] as? String == "true")
}

@Test func startAndParentFramesAreClosed() {
    var input = [["kind": "start", "source": "function main(){}",
                  "result_bytes": 100, "log_bytes": 0, "extra": true] as [String: Any]]
    #expect(MacProgramRunnerSession.run(arguments: ["runner", "--stdio-v1"],
        read: { input.isEmpty ? nil : input.removeFirst() }, write: { _ in }) == 64)

    var badLimits = [["kind": "start", "source": "function main(){}",
                      "result_bytes": 0, "log_bytes": 0] as [String: Any]]
    #expect(MacProgramRunnerSession.run(arguments: ["runner", "--stdio-v1"],
        read: { badLimits.isEmpty ? nil : badLimits.removeFirst() }, write: { _ in }) == 64)

    let handle = MacProgramRunnerHandle()
    let state = MacProgramProcessRunner.RunnerState(input: Pipe(), handle: handle,
        call: { _, _ in "{}" }, terminal: DispatchSemaphore(value: 0))
    state.consume(Data((#"{"kind":"call","id":1,"capability_id":"x","input_json":"{}","extra":true}"# + "\n").utf8))
    #expect(state.outcome(timedOut: false).error == "program runner protocol violation")
    #expect(!handle.isActive)

    let duplicateHandle = MacProgramRunnerHandle()
    let duplicate = MacProgramProcessRunner.RunnerState(input: Pipe(), handle: duplicateHandle,
        call: { _, _ in "{}" }, terminal: DispatchSemaphore(value: 0))
    duplicate.consume(Data((#"{"kind":"terminal","output_json":"1"}"# + "\n" +
        #"{"kind":"terminal","output_json":"2"}"# + "\n").utf8))
    #expect(duplicate.outcome(timedOut: false).error == "program runner protocol violation")
    #expect(duplicate.outcome(timedOut: false).outputJSON == nil)

    let pollingHandle = MacProgramRunnerHandle()
    let polling = MacProgramProcessRunner.RunnerState(input: Pipe(), handle: pollingHandle,
        call: { _, _ in "{}" }, terminal: DispatchSemaphore(value: 0))
    let polls = (1...257).map { "{\"kind\":\"abort_poll\",\"id\":\($0)}" }
        .joined(separator: "\n") + "\n"
    polling.consume(Data(polls.utf8))
    #expect(polling.outcome(timedOut: false).error ==
        "program runner abort channel exceeded local limit")
}
#endif
