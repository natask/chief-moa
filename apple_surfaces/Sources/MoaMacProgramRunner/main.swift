#if os(macOS)
import Foundation
import MoaMacProgramRunnerCore

private func readObject() -> [String: Any]? {
    guard let line = readLine(), let data = line.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}
private func writeObject(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data + Data([0x0a]))
}
Foundation.exit(MacProgramRunnerSession.run(arguments: CommandLine.arguments,
    read: readObject, write: writeObject))
#else
import Foundation
Foundation.exit(64)
#endif
