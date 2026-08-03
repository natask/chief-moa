#if os(macOS)
import Foundation
import MoaMacCore

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

public enum PortableAuthStoreError: Error, Equatable, Sendable {
    case unsafePath
    case invalidCredential
    case writeFailed
}

/// A Codex-style portable credential cache. The file is a secret and must be
/// handled like a password; it is never synced or committed by Ag.
public struct FileDeviceSessionStore: DeviceSessionStoring {
    public static let maximumCredentialBytes = 16 * 1024
    public static let maximumFileBytes = 64 * 1024

    public let authFileURL: URL

    public init(directory: URL? = nil) {
        let root = directory ?? Self.defaultDirectory()
        authFileURL = root.appendingPathComponent("auth.json", isDirectory: false)
    }

    public func load() -> String {
        guard isSafeExistingDirectory(authFileURL.deletingLastPathComponent()),
              hasNoGroupOrWorldAccess(authFileURL.deletingLastPathComponent()),
              isSafeExistingFile(authFileURL),
              hasNoGroupOrWorldAccess(authFileURL),
              let attributes = try? FileManager.default.attributesOfItem(atPath: authFileURL.path),
              let size = attributes[.size] as? NSNumber,
              size.intValue <= Self.maximumFileBytes,
              let data = try? Data(contentsOf: authFileURL, options: [.mappedIfSafe]),
              data.count <= Self.maximumFileBytes,
              let credential = try? JSONDecoder().decode(Credential.self, from: data),
              credential.version == 1,
              isValid(credential.accessToken) else { return "" }
        return credential.accessToken
    }

    public func save(_ token: String) throws {
        guard isValid(token) else { throw PortableAuthStoreError.invalidCredential }
        let directory = authFileURL.deletingLastPathComponent()
        try prepareDirectory(directory)
        if FileManager.default.fileExists(atPath: authFileURL.path), !isSafeExistingFile(authFileURL) {
            throw PortableAuthStoreError.unsafePath
        }
        var data = try JSONEncoder().encode(Credential(version: 1, accessToken: token))
        data.append(0x0A)
        guard data.count <= Self.maximumFileBytes else { throw PortableAuthStoreError.invalidCredential }
        do {
            try data.write(to: authFileURL, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: authFileURL.path)
        } catch {
            throw PortableAuthStoreError.writeFailed
        }
    }

    public func clear() throws {
        guard FileManager.default.fileExists(atPath: authFileURL.path) else { return }
        guard isSafeExistingFile(authFileURL) else { throw PortableAuthStoreError.unsafePath }
        do { try FileManager.default.removeItem(at: authFileURL) }
        catch { throw PortableAuthStoreError.writeFailed }
    }

    public static func defaultDirectory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let configured = environment["AG_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !configured.isEmpty {
            return URL(fileURLWithPath: configured, isDirectory: true).standardizedFileURL
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ag", isDirectory: true)
    }

    private func prepareDirectory(_ directory: URL) throws {
        if FileManager.default.fileExists(atPath: directory.path) {
            guard isSafeExistingDirectory(directory) else { throw PortableAuthStoreError.unsafePath }
        } else {
            do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
            catch { throw PortableAuthStoreError.writeFailed }
        }
        do { try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }
        catch { throw PortableAuthStoreError.writeFailed }
    }

    private func isSafeExistingDirectory(_ url: URL) -> Bool {
        guard !isSymbolicLink(url),
              let values = try? url.resourceValues(forKeys: [.isDirectoryKey]) else { return false }
        return values.isDirectory == true
    }

    private func isSafeExistingFile(_ url: URL) -> Bool {
        guard !isSymbolicLink(url),
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey]) else { return false }
        return values.isRegularFile == true
    }

    private func isSymbolicLink(_ url: URL) -> Bool {
        (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) != nil
    }

    private func hasNoGroupOrWorldAccess(_ url: URL) -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let permissions = attributes[.posixPermissions] as? NSNumber else { return false }
        return permissions.intValue & 0o077 == 0
    }

    private func isValid(_ token: String) -> Bool {
        !token.isEmpty && token.utf8.count <= Self.maximumCredentialBytes &&
            !token.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    private struct Credential: Codable {
        let version: Int
        let accessToken: String
        enum CodingKeys: String, CodingKey { case version; case accessToken = "access_token" }
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
