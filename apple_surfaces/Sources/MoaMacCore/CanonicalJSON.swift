import Foundation

/// The protocol's restricted RFC 8785 profile. It accepts the JSON shapes used
/// by V1 wire objects and tool schemas: objects, arrays, strings, booleans,
/// null, and safe integers. Fractional/exponential numbers are rejected rather
/// than canonicalized with a platform-dependent formatter.
public enum MacCanonicalJSON: Equatable, Sendable {
    case object([String: Self])
    case array([Self])
    case string(String)
    case integer(Int64)
    case boolean(Bool)
    case null

    public static func parse(_ data: Data) throws -> Self {
        var parser = Parser(bytes: Array(data))
        let value = try parser.value()
        parser.space()
        guard parser.index == parser.bytes.count else { throw LocalProgramError.invalidInput }
        return value
    }

    public var canonicalData: Data { Data(canonicalString.utf8) }
    public var stringValue: String? { if case .string(let value) = self { value } else { nil } }

    public var canonicalString: String {
        switch self {
        case .null: "null"
        case .boolean(let value): value ? "true" : "false"
        case .integer(let value): String(value)
        case .string(let value): Self.quote(value)
        case .array(let values): "[" + values.map(\.canonicalString).joined(separator: ",") + "]"
        case .object(let values):
            "{" + values.keys.sorted(by: Self.utf16Less).map {
                Self.quote($0) + ":" + values[$0]!.canonicalString
            }.joined(separator: ",") + "}"
        }
    }

    private static func quote(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x08: result += "\\b"
            case 0x09: result += "\\t"
            case 0x0a: result += "\\n"
            case 0x0c: result += "\\f"
            case 0x0d: result += "\\r"
            case 0x22: result += "\\\""
            case 0x5c: result += "\\\\"
            case 0x00...0x1f: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }

    private static func utf16Less(_ lhs: String, _ rhs: String) -> Bool {
        Array(lhs.utf16).lexicographicallyPrecedes(Array(rhs.utf16))
    }

    private struct Parser {
        let bytes: [UInt8]
        var index = 0

        mutating func space() {
            while index < bytes.count, [0x20, 0x09, 0x0a, 0x0d].contains(bytes[index]) { index += 1 }
        }

        mutating func value() throws -> MacCanonicalJSON {
            space()
            guard index < bytes.count else { throw LocalProgramError.invalidInput }
            switch bytes[index] {
            case 0x7b: return try object()
            case 0x5b: return try array()
            case 0x22: return .string(try string())
            case 0x74: try literal("true"); return .boolean(true)
            case 0x66: try literal("false"); return .boolean(false)
            case 0x6e: try literal("null"); return .null
            case 0x2d, 0x30...0x39: return .integer(try integer())
            default: throw LocalProgramError.invalidInput
            }
        }

        mutating func object() throws -> MacCanonicalJSON {
            index += 1; space()
            var result: [String: MacCanonicalJSON] = [:]
            if take(0x7d) { return .object(result) }
            while true {
                space(); guard index < bytes.count, bytes[index] == 0x22 else { throw LocalProgramError.invalidInput }
                let key = try string()
                guard result[key] == nil else { throw LocalProgramError.invalidInput }
                space(); guard take(0x3a) else { throw LocalProgramError.invalidInput }
                result[key] = try value(); space()
                if take(0x7d) { return .object(result) }
                guard take(0x2c) else { throw LocalProgramError.invalidInput }
            }
        }

        mutating func array() throws -> MacCanonicalJSON {
            index += 1; space()
            var result: [MacCanonicalJSON] = []
            if take(0x5d) { return .array(result) }
            while true {
                result.append(try value()); space()
                if take(0x5d) { return .array(result) }
                guard take(0x2c) else { throw LocalProgramError.invalidInput }
            }
        }

        mutating func string() throws -> String {
            let start = index
            index += 1
            var escaped = false
            while index < bytes.count {
                let byte = bytes[index]
                if byte < 0x20 { throw LocalProgramError.invalidInput }
                index += 1
                if escaped { escaped = false; continue }
                if byte == 0x5c { escaped = true; continue }
                if byte == 0x22 {
                    let token = Data(bytes[start..<index])
                    guard let decoded = try? JSONDecoder().decode(String.self, from: token) else {
                        throw LocalProgramError.invalidInput
                    }
                    return decoded
                }
            }
            throw LocalProgramError.invalidInput
        }

        mutating func integer() throws -> Int64 {
            let start = index
            if take(0x2d), index == bytes.count { throw LocalProgramError.invalidInput }
            if take(0x30) {
                if index < bytes.count, (0x30...0x39).contains(bytes[index]) { throw LocalProgramError.invalidInput }
            } else {
                guard index < bytes.count, (0x31...0x39).contains(bytes[index]) else { throw LocalProgramError.invalidInput }
                while index < bytes.count, (0x30...0x39).contains(bytes[index]) { index += 1 }
            }
            guard index == bytes.count || ![UInt8(0x2e), 0x45, 0x65].contains(bytes[index]),
                  let text = String(bytes: bytes[start..<index], encoding: .utf8),
                  let value = Int64(text),
                  value >= -9_007_199_254_740_991, value <= 9_007_199_254_740_991 else {
                throw LocalProgramError.invalidInput
            }
            return value
        }

        mutating func literal(_ literal: String) throws {
            let expected = Array(literal.utf8)
            guard index + expected.count <= bytes.count,
                  Array(bytes[index..<(index + expected.count)]) == expected else {
                throw LocalProgramError.invalidInput
            }
            index += expected.count
        }

        mutating func take(_ byte: UInt8) -> Bool {
            guard index < bytes.count, bytes[index] == byte else { return false }
            index += 1; return true
        }
    }
}
