#if os(macOS)
import Foundation
import JavaScriptCore

@objc private protocol MacRunnerHostExport: JSExport {
    func call(_ capabilityID: String, _ inputJSON: String) -> String
}

private final class MacRunnerHost: NSObject, MacRunnerHostExport {
    let exchange: ([String: Any]) -> [String: Any]?
    private var nextID = 0
    init(exchange: @escaping ([String: Any]) -> [String: Any]?) { self.exchange = exchange }
    func call(_ capabilityID: String, _ inputJSON: String) -> String {
        nextID += 1
        guard let response = exchange(["kind": "call", "id": nextID,
            "capability_id": capabilityID, "input_json": inputJSON]),
              response["kind"] as? String == "call_result", response["id"] as? Int == nextID,
              let output = response["output_json"] as? String else { return #"{"error":"host unavailable","ok":false}"# }
        return output
    }
}

public enum MacProgramRunnerSession {
    public static func run(arguments: [String], read: @escaping () -> [String: Any]?,
                           write: @escaping ([String: Any]) -> Void) -> Int32 {
        guard arguments.count == 2, arguments[1] == "--stdio-v1",
              let start = read(), Set(start.keys) == ["kind", "source"],
              start["kind"] as? String == "start", let source = start["source"] as? String,
              source.utf8.count <= 64 * 1024,
              let context = JSContext(virtualMachine: JSVirtualMachine()) else { return 64 }
        let host = MacRunnerHost { request in write(request); return read() }
        var exception = false
        context.exceptionHandler = { _, _ in exception = true }
        context.setObject(host, forKeyedSubscript: "__moaMacHost" as NSString)
        context.evaluateScript(bootstrap)
        guard !exception else { write(["kind": "terminal", "error": "runtime_failed"]); return 0 }
        let value = context.evaluateScript("JSON.stringify((function(){\n\(source)\n})())")
        if exception { write(["kind": "terminal", "error": "runtime_failed"]) }
        else {
            let output = (value == nil || value?.isUndefined == true) ? "null" : (value?.toString() ?? "null")
            guard output.utf8.count <= 64 * 1024 else {
                write(["kind": "terminal", "error": "limit_exceeded"]); return 0
            }
            write(["kind": "terminal", "output_json": output])
        }
        return 0
    }

    private static let bootstrap = #"""
    "use strict";
    const host = __moaMacHost;
    const decode = value => { const result = JSON.parse(value); if (result && result.ok === false) throw new Error("host operation failed"); return result; };
    const call = (capability, input = {}) => decode(host.call(capability, JSON.stringify(input)));
    const accessibility = Object.freeze({
      observe: () => call("macos.accessibility.observe"), find: (query = {}) => call("macos.accessibility.find", query),
      press: input => call("macos.accessibility.press", {...input, action:"press"}), confirm: input => call("macos.accessibility.confirm", {...input, action:"confirm"}),
      cancel: input => call("macos.accessibility.cancel", {...input, action:"cancel"}), increment: input => call("macos.accessibility.increment", {...input, action:"increment"}),
      decrement: input => call("macos.accessibility.decrement", {...input, action:"decrement"}), show_menu: input => call("macos.accessibility.show_menu", {...input, action:"show_menu"}),
      set_value: input => call("macos.accessibility.set_value", {...input, action:"set_value"})
    });
    globalThis.tools = Object.freeze({macos:Object.freeze({accessibility,app:Object.freeze({current:()=>call("macos.app.current")}),window:Object.freeze({current:()=>call("macos.window.current")})})});
    delete globalThis.__moaMacHost; delete globalThis.fetch; delete globalThis.XMLHttpRequest; delete globalThis.WebSocket;
    delete globalThis.require; delete globalThis.process; delete globalThis.eval; delete globalThis.Function; delete globalThis.Promise;
    Object.freeze(globalThis.tools);
    """#
}
#endif
