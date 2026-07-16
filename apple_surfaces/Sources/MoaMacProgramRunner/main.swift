#if os(macOS)
import Foundation
import JavaScriptCore

@objc private protocol HostProxyExport: JSExport {
    func call(_ capabilityID: String, _ inputJSON: String) -> String
}

private final class HostProxy: NSObject, HostProxyExport {
    private var nextID = 0

    func call(_ capabilityID: String, _ inputJSON: String) -> String {
        nextID += 1
        write(["kind": "call", "id": nextID, "capability_id": capabilityID,
               "input_json": inputJSON])
        guard let response = readObject(), response["kind"] as? String == "call_result",
              response["id"] as? Int == nextID,
              let output = response["output_json"] as? String else {
            Foundation.exit(70)
        }
        return output
    }
}

private func write(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
        Foundation.exit(70)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func readObject() -> [String: Any]? {
    guard let line = readLine(), let data = line.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

private let bootstrap = #"""
"use strict";
const host = __moaMacHost;
const decode = value => {
  const result = JSON.parse(value);
  if (result && result.ok === false) throw new Error(result.error || "host operation failed");
  return result;
};
const call = (capability, input = {}) => decode(host.call(capability, JSON.stringify(input)));
const accessibility = Object.freeze({
  observe: () => call("macos.accessibility.observe"),
  find: (query = {}) => call("macos.accessibility.find", query),
  press: input => call("macos.accessibility.press", {...input, action:"press"}),
  confirm: input => call("macos.accessibility.confirm", {...input, action:"confirm"}),
  cancel: input => call("macos.accessibility.cancel", {...input, action:"cancel"}),
  increment: input => call("macos.accessibility.increment", {...input, action:"increment"}),
  decrement: input => call("macos.accessibility.decrement", {...input, action:"decrement"}),
  show_menu: input => call("macos.accessibility.show_menu", {...input, action:"show_menu"}),
  set_value: input => call("macos.accessibility.set_value", {...input, action:"set_value"})
});
globalThis.tools = Object.freeze({macos:Object.freeze({
  accessibility,
  app:Object.freeze({current:()=>call("macos.app.current")}),
  window:Object.freeze({current:()=>call("macos.window.current")})
})});
delete globalThis.__moaMacHost;
delete globalThis.fetch;
delete globalThis.XMLHttpRequest;
delete globalThis.WebSocket;
delete globalThis.require;
delete globalThis.process;
delete globalThis.eval;
delete globalThis.Function;
delete globalThis.Promise;
Object.freeze(globalThis.tools);
"""#

guard CommandLine.arguments == [CommandLine.arguments[0], "--stdio-v1"],
      let start = readObject(), start["kind"] as? String == "start",
      let source = start["source"] as? String,
      let context = JSContext(virtualMachine: JSVirtualMachine()) else {
    Foundation.exit(64)
}
var exception: String?
context.exceptionHandler = { _, value in exception = value?.toString() ?? "JavaScript exception" }
context.setObject(HostProxy(), forKeyedSubscript: "__moaMacHost" as NSString)
context.evaluateScript(bootstrap)
if let exception {
    write(["kind": "terminal", "error": exception])
    Foundation.exit(0)
}
let value = context.evaluateScript("JSON.stringify((function(){\n\(source)\n})())")
if let exception { write(["kind": "terminal", "error": exception]) }
else {
    let output = (value == nil || value?.isUndefined == true) ? "null" : (value?.toString() ?? "null")
    write(["kind": "terminal", "output_json": output])
}
#else
import Foundation
Foundation.exit(64)
#endif
