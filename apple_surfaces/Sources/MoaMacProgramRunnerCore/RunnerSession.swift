#if os(macOS)
import Foundation
import JavaScriptCore

@objc private protocol MacRunnerHostExport: JSExport {
    func call(_ capabilityID: String, _ inputJSON: String) -> String
    func progress(_ message: String, _ completed: Int, _ total: Int) -> Bool
    func cancelled() -> Bool
    func complete(_ outputJSON: String, _ error: String)
}

private final class MacRunnerHost: NSObject, MacRunnerHostExport {
    let exchange: ([String: Any]) -> [String: Any]?
    private var nextID = 0
    private let terminal = DispatchSemaphore(value: 0)
    private(set) var outputJSON: String?
    private(set) var error: String?

    init(exchange: @escaping ([String: Any]) -> [String: Any]?) { self.exchange = exchange }

    func call(_ capabilityID: String, _ inputJSON: String) -> String {
        nextID += 1
        guard let response = exchange(["kind": "call", "id": nextID,
            "capability_id": capabilityID, "input_json": inputJSON]),
              Set(response.keys) == ["kind", "id", "output_json"],
              response["kind"] as? String == "call_result", response["id"] as? Int == nextID,
              let output = response["output_json"] as? String else {
            return #"{"error":"host unavailable","ok":false}"#
        }
        return output
    }

    func progress(_ message: String, _ completed: Int, _ total: Int) -> Bool {
        nextID += 1
        guard let response = exchange(["kind": "progress", "id": nextID,
            "message": message, "completed": completed, "total": total]),
              Set(response.keys) == ["kind", "id", "ok"],
              response["kind"] as? String == "progress_result",
              response["id"] as? Int == nextID else { return false }
        return response["ok"] as? Bool == true
    }

    func cancelled() -> Bool {
        nextID += 1
        guard let response = exchange(["kind": "abort_poll", "id": nextID]),
              Set(response.keys) == ["kind", "id", "aborted"],
              response["kind"] as? String == "abort_result",
              response["id"] as? Int == nextID else { return true }
        return response["aborted"] as? Bool ?? true
    }

    func complete(_ outputJSON: String, _ error: String) {
        guard self.outputJSON == nil, self.error == nil else { return }
        if error.isEmpty { self.outputJSON = outputJSON } else { self.error = error }
        terminal.signal()
    }

    func waitForTerminal() { terminal.wait() }
}

public enum MacProgramRunnerSession {
    public static func run(arguments: [String], read: @escaping () -> [String: Any]?,
                           write: @escaping ([String: Any]) -> Void) -> Int32 {
        guard arguments.count == 2, arguments[1] == "--stdio-v1",
              let start = read(),
              Set(start.keys) == ["kind", "source", "result_bytes", "log_bytes"],
              start["kind"] as? String == "start", let source = start["source"] as? String,
              let resultBytes = start["result_bytes"] as? Int,
              let logBytes = start["log_bytes"] as? Int,
              (1...64 * 1024).contains(resultBytes), (0...32 * 1024).contains(logBytes),
              source.utf8.count <= 64 * 1024,
              let context = JSContext(virtualMachine: JSVirtualMachine()) else { return 64 }

        let host = MacRunnerHost { request in write(request); return read() }
        var exception = false
        context.exceptionHandler = { _, _ in exception = true }
        context.setObject(host, forKeyedSubscript: "__moaMacHost" as NSString)
        context.evaluateScript(bootstrap)
        guard !exception else { write(["kind": "terminal", "error": "runtime_failed"]); return 0 }

        exception = false
        context.evaluateScript(source)
        guard !exception,
              context.evaluateScript("typeof main === 'function'")?.toBool() == true else {
            write(["kind": "terminal", "error": "runtime_failed"]); return 0
        }

        exception = false
        context.evaluateScript("Promise.resolve(main(__moaRuntime)).then(result, result.fail)")
        guard !exception else { write(["kind": "terminal", "error": "runtime_failed"]); return 0 }
        host.waitForTerminal()

        if host.error != nil {
            write(["kind": "terminal", "error": "runtime_failed"])
        } else {
            let output = host.outputJSON ?? "null"
            guard output.utf8.count <= resultBytes else {
                write(["kind": "terminal", "error": "limit_exceeded"]); return 0
            }
            write(["kind": "terminal", "output_json": output])
        }
        return 0
    }

    private static let bootstrap = #"""
    (function(rawHost) {
      "use strict";
      const decode = value => {
        const decoded = JSON.parse(value);
        if (decoded && decoded.ok === false) throw new Error("host operation failed");
        return decoded;
      };
      const call = (capability, input = {}) => Promise.resolve().then(() =>
        decode(rawHost.call(capability, JSON.stringify(input))));
      const frozenFunction = fn => Object.freeze(fn);
      const accessibility = Object.freeze({
        observe: frozenFunction(() => call("macos.accessibility.observe")),
        find: frozenFunction((query = {}) => call("macos.accessibility.find", query)),
        press: frozenFunction(input => call("macos.accessibility.press", {...input, action:"press"})),
        confirm: frozenFunction(input => call("macos.accessibility.confirm", {...input, action:"confirm"})),
        cancel: frozenFunction(input => call("macos.accessibility.cancel", {...input, action:"cancel"})),
        increment: frozenFunction(input => call("macos.accessibility.increment", {...input, action:"increment"})),
        decrement: frozenFunction(input => call("macos.accessibility.decrement", {...input, action:"decrement"})),
        show_menu: frozenFunction(input => call("macos.accessibility.show_menu", {...input, action:"show_menu"})),
        set_value: frozenFunction(input => call("macos.accessibility.set_value", {...input, action:"set_value"}))
      });
      const tools = Object.freeze({macos:Object.freeze({
        accessibility,
        app:Object.freeze({current:frozenFunction(() => call("macos.app.current"))}),
        window:Object.freeze({current:frozenFunction(() => call("macos.window.current"))})
      })});
      const signal = Object.freeze(Object.defineProperty({}, "aborted", {
        enumerable:true, configurable:false, get:frozenFunction(() => rawHost.cancelled())
      }));
      const progress = frozenFunction((message, completed, total) => {
        if (typeof message !== "string" || message.length === 0 || message.length > 240 ||
            !Number.isSafeInteger(completed) || !Number.isSafeInteger(total) ||
            completed < 0 || total < 0 || completed > total) throw new Error("invalid progress");
        if (!rawHost.progress(message, completed, total)) throw new Error("progress rejected");
      });
      let completed = false;
      const result = value => {
        if (completed) throw new Error("result already completed");
        const encoded = JSON.stringify(value === undefined ? null : value);
        completed = true;
        rawHost.complete(encoded === undefined ? "null" : encoded, "");
      };
      Object.defineProperty(result, "fail", {value:frozenFunction(() => {
        if (completed) return;
        completed = true;
        rawHost.complete("", "runtime_failed");
      }), writable:false, enumerable:false, configurable:false});
      Object.freeze(result);
      const runtime = Object.freeze({tools, signal, progress, result});
      for (const [name, value] of Object.entries({tools, signal, progress, result, __moaRuntime:runtime})) {
        Object.defineProperty(globalThis, name, {value, writable:false, enumerable:true, configurable:false});
      }
    })(__moaMacHost);
    delete globalThis.__moaMacHost;
    delete globalThis.fetch; delete globalThis.XMLHttpRequest; delete globalThis.WebSocket;
    delete globalThis.require; delete globalThis.process; delete globalThis.eval; delete globalThis.Function;
    """#
}
#endif
