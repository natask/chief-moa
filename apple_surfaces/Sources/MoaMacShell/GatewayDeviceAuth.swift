#if os(macOS)
import Foundation
import MoaMacCore
import Security

public struct DeviceAuthorization: Sendable, Equatable {
    public let deviceCode: String
    public let userCode: String
    public let verificationURL: URL
    public let expiresIn: Int
    public let interval: Int
}

public enum DeviceAuthorizationError: Error, Equatable, Sendable {
    case invalidResponse
    case expired
    case denied
    case server(String)
}

public protocol DeviceAuthorizing: Sendable {
    func begin(origin: URL) async throws -> DeviceAuthorization
    func poll(origin: URL, authorization: DeviceAuthorization) async throws -> String
}

public protocol DeviceSessionStoring: Sendable {
    func load() -> String
    func save(_ token: String) throws
    func clear() throws
}

public struct KeychainDeviceSessionStore: DeviceSessionStoring {
    private let service = "app.agee.ag.account-session"
    private let account = "owner"
    public init() {}

    public func load() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let token = String(data: data, encoding: .utf8) else { return "" }
        return token
    }

    public func save(_ token: String) throws {
        guard !token.isEmpty else { throw MoaMacError.missingToken }
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw DeviceAuthorizationError.server("keychain") }
        } else if status != errSecSuccess {
            throw DeviceAuthorizationError.server("keychain")
        }
    }

    public func clear() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DeviceAuthorizationError.server("keychain") }
    }
}

public struct URLSessionDeviceAuthorizer: DeviceAuthorizing {
    public init() {}

    public func begin(origin: URL) async throws -> DeviceAuthorization {
        let endpoint = try GatewayOrigin.endpoint(origin: origin, path: ["api", "auth", "device", "code"])
        let data = try await post(endpoint, ["client_id": "ag-macos", "scope": "openid profile email"])
        let raw = try JSONDecoder().decode(DeviceCodeResponse.self, from: data)
        guard let verificationURL = URL(string: raw.verificationURIComplete ?? raw.verificationURI) else {
            throw DeviceAuthorizationError.invalidResponse
        }
        return DeviceAuthorization(deviceCode: raw.deviceCode, userCode: raw.userCode,
            verificationURL: verificationURL, expiresIn: raw.expiresIn, interval: max(1, raw.interval ?? 5))
    }

    public func poll(origin: URL, authorization: DeviceAuthorization) async throws -> String {
        let endpoint = try GatewayOrigin.endpoint(origin: origin, path: ["api", "auth", "device", "token"])
        let deadline = Date().addingTimeInterval(TimeInterval(authorization.expiresIn))
        var interval = authorization.interval
        while Date() < deadline {
            try await Task.sleep(for: .seconds(interval))
            do {
                let data = try await post(endpoint, [
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "device_code": authorization.deviceCode,
                    "client_id": "ag-macos",
                ])
                let token = try JSONDecoder().decode(TokenResponse.self, from: data).accessToken
                guard !token.isEmpty else { throw DeviceAuthorizationError.invalidResponse }
                return token
            } catch DeviceAuthorizationError.server(let code) where code == "authorization_pending" {
                continue
            } catch DeviceAuthorizationError.server(let code) where code == "slow_down" {
                interval += 5
            } catch DeviceAuthorizationError.server(let code) where code == "access_denied" {
                throw DeviceAuthorizationError.denied
            } catch DeviceAuthorizationError.server(let code) where code == "expired_token" {
                throw DeviceAuthorizationError.expired
            }
        }
        throw DeviceAuthorizationError.expired
    }

    private func post(_ endpoint: URL, _ body: [String: String]) async throws -> Data {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DeviceAuthorizationError.invalidResponse }
        if (200..<300).contains(http.statusCode) { return data }
        let code = (try? JSONDecoder().decode(ErrorResponse.self, from: data).error) ?? "http_\(http.statusCode)"
        throw DeviceAuthorizationError.server(code)
    }

    private struct DeviceCodeResponse: Decodable {
        let deviceCode: String; let userCode: String; let verificationURI: String
        let verificationURIComplete: String?; let expiresIn: Int; let interval: Int?
        enum CodingKeys: String, CodingKey {
            case deviceCode = "device_code", userCode = "user_code", verificationURI = "verification_uri"
            case verificationURIComplete = "verification_uri_complete", expiresIn = "expires_in", interval
        }
    }
    private struct TokenResponse: Decodable {
        let accessToken: String
        enum CodingKeys: String, CodingKey { case accessToken = "access_token" }
    }
    private struct ErrorResponse: Decodable { let error: String }
}
#endif
