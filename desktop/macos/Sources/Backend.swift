import Foundation
import AppKit
import CryptoKit

indirect enum JSON: Codable, Equatable {
    case object([String: JSON]), array([JSON]), string(String), integer(Int64), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int64.self) { self = .integer(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .integer(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> JSON { if case .object(let value) = self { return value[key] ?? .null }; return .null }
    var object: [String: JSON] { if case .object(let value) = self { return value }; return [:] }
    var array: [JSON] { if case .array(let value) = self { return value }; return [] }
    var string: String {
        switch self { case .string(let value): return value; case .integer(let value): return String(value); case .number(let value): return String(value); default: return "" }
    }
    var bool: Bool { if case .bool(let value) = self { return value }; return false }
    var int: Int { if case .integer(let value) = self { return Int(value) }; return 0 }
    var pretty: String { let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]; return String(data: (try? encoder.encode(self)) ?? Data(), encoding: .utf8) ?? "" }
}

struct LocalError: LocalizedError { let message: String; var errorDescription: String? { message } }
func object(_ value: [String: JSON]) -> JSON { .object(value) }
func text(_ value: String) -> JSON { .string(value) }
func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

@MainActor final class Backend: ObservableObject {
    @Published var ready = false
    @Published var startupError: String?
    private var process: Process?
    private var origin: URL?
    private var token = ""
    private var errorPipe: Pipe?
    private var stopping = false

    var usesSystemNode: Bool {
        guard let file = Bundle.main.resourceURL?.appendingPathComponent("sfl/runtime-mode.json"), let data = try? Data(contentsOf: file), let value = try? JSONDecoder().decode(JSON.self, from: data) else { return false }
        return value["mode"].string == "system"
    }

    func start() async throws {
        if ready { return }
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("sfl") else { throw LocalError(message: "安装包缺少后端目录") }
        guard let launcher = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("sfl-mcp") else { throw LocalError(message: "安装包缺少启动器") }
        var resolverEnvironment = ProcessInfo.processInfo.environment
        if resolverEnvironment["SFL_NODE_BINARY"] == nil, let selected = UserDefaults.standard.string(forKey: "SFLNodeBinary") { resolverEnvironment["SFL_NODE_BINARY"] = selected }
        let launchEnvironment = resolverEnvironment
        nativeSmokeLog("resolve runtime")
        // The resolver emits only a bounded path/error. Wait off the main actor;
        // do not depend on asynchronous EOF delivery for this short-lived process.
        let resolved = try await Task.detached { () throws -> (Int32, String, String) in
            let resolver = Process()
            resolver.executableURL = launcher
            resolver.arguments = ["--sfl-node-path"]
            resolver.environment = launchEnvironment
            resolver.standardInput = FileHandle.nullDevice
            let output = Pipe(), errors = Pipe()
            resolver.standardOutput = output
            resolver.standardError = errors
            try resolver.run()
            resolver.waitUntilExit()
            return (resolver.terminationStatus,
                    String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "",
                    String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "Node.js 22+ 检查失败")
        }.value
        let nodePath = resolved.1.trimmingCharacters(in: .whitespacesAndNewlines)
        guard resolved.0 == 0, nodePath.hasPrefix("/") else { throw LocalError(message: resolved.2) }
        let node = URL(fileURLWithPath: nodePath)
        nativeSmokeLog("start backend")
        let child = Process()
        child.executableURL = node
        child.arguments = [root.appendingPathComponent("dist/index.js").path, "--local", "--no-open"]
        child.currentDirectoryURL = root
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_PATH")
        child.environment = environment
        let output = Pipe()
        let errors = Pipe()
        child.standardOutput = output
        child.standardError = errors
        child.standardInput = FileHandle.nullDevice
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        errorPipe = errors
        process = child
        try child.run()
        guard let line = try await output.fileHandleForReading.bytes.lines.first(where: { !$0.isEmpty }),
              let bytes = line.data(using: .utf8) else { throw LocalError(message: "本地服务未能启动，请检查图库目录或重新安装。") }
        let launch = try JSONDecoder().decode(JSON.self, from: bytes)
        guard launch["schema"].string == "figure-library.local-launch.v1",
              let url = URL(string: launch["origin"].string), url.host == "127.0.0.1", url.scheme == "http",
              !launch["token"].string.isEmpty else { child.terminate(); throw LocalError(message: "本地服务返回了无效的连接信息") }
        origin = url
        token = launch["token"].string
        nativeSmokeLog("backend ready")
        ready = true
        startupError = nil
    }

    func request(_ route: String, _ body: JSON? = nil) async throws -> JSON {
        guard let origin = origin, ready else { throw LocalError(message: "本地服务尚未连接") }
        let url = origin.appendingPathComponent("api").appendingPathComponent(route)
        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.timeoutInterval = 180
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body = body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (bytes, response) = try await URLSession.shared.data(for: request)
        let result = try JSONDecoder().decode(JSON.self, from: bytes)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw LocalError(message: result["error"].string.isEmpty ? "本地连接失败" : result["error"].string) }
        return result
    }

    func check(_ result: JSON) throws -> JSON {
        let envelope = result["structuredContent"]["envelope"]
        if result["isError"].bool || ["failed", "blocked", "conflict", "not_found", "needs_user_input"].contains(envelope["outcome"].string) {
            let fallback = result["content"].array.map { $0["text"].string }.joined(separator: "\n")
            throw LocalError(message: envelope["summary"].string.isEmpty ? fallback : envelope["summary"].string)
        }
        return result["structuredContent"]
    }
    func call(_ name: String, _ arguments: [String: JSON] = [:], approve: Bool = false) async throws -> JSON {
        var body: [String: JSON] = ["name": text(name), "arguments": object(arguments)]
        if approve { body["approval"] = object(["planDigest": arguments["planDigest"] ?? .null, "confirmedBy": text("user")]) }
        return try check(await request("call", object(body)))
    }
    func upload(_ url: URL) async throws -> String {
        guard let origin = origin else { throw LocalError(message: "本地服务尚未连接") }
        let bytes = try Data(contentsOf: url)
        if bytes.count > 32 * 1024 * 1024 { throw LocalError(message: "单个文件最大 32 MiB") }
        var request = URLRequest(url: origin.appendingPathComponent("api/upload"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(url.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "asset.txt", forHTTPHeaderField: "x-sfl-filename")
        let (responseData, response) = try await URLSession.shared.upload(for: request, from: bytes)
        let value = try JSONDecoder().decode(JSON.self, from: responseData)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw LocalError(message: value["error"].string) }
        return value["sourcePath"].string
    }
    func exactPreview(_ selection: [String: JSON]) async throws -> (JSON, Data, NSImage) {
        let response = try await request("preview", object(selection))
        let info = try check(response)
        guard let block = response["content"].array.first(where: { $0["type"].string == "image" }),
              let data = Data(base64Encoded: block["data"].string), let image = NSImage(data: data),
              sha256(data) == info["transportSha256"].string else { throw LocalError(message: "精确图片校验或解码失败") }
        return (info, data, image)
    }
    func confirm(_ preview: JSON, image: Data) async throws -> JSON {
        try check(await request("confirm", object(["previewChallenge": preview["previewChallenge"], "displayedImageSha256": text(sha256(image)), "imageLoaded": .bool(true), "confirmedBy": text("user")])))
    }
    func shutdown() async -> Bool {
        if stopping { return false }
        stopping = true
        if ready { _ = try? await request("shutdown", object([:])) }
        for _ in 0..<100 {
            if process?.isRunning != true { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if process?.isRunning == true { stopping = false; return false }
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        ready = false
        return true
    }
}
