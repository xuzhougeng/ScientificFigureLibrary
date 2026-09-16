import SwiftUI
import AppKit

enum Section: String, CaseIterable, Identifiable, Hashable {
    case discover = "图库", library = "我的图库", galleries = "外部图库", add = "创建参考图", integrations = "连接外部工具", settings = "设置"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .discover: return "square.grid.2x2"
        case .library: return "books.vertical"
        case .galleries: return "photo.on.rectangle"
        case .add: return "plus.square.on.square"
        case .integrations: return "link"
        case .settings: return "gearshape"
        }
    }
}
func friendlyNetworkError(_ error: Error) -> String {
    let raw = error.localizedDescription
    if raw.contains("timed out") { return "访问 GitHub 超时。请在设置打开系统代理并保存，或在外部图库关闭自动刷新。" }
    if raw.contains("ECONNRESET") { return "与 GitHub 的连接被重置。请检查网络或系统代理。" }
    if raw.contains("Provider source change plan failed") { return "图库来源更新失败。请检查网络或系统代理后，在外部图库重试。" }
    return raw
}

struct PendingPlan: Identifiable {
    let id = UUID()
    let title: String
    let value: JSON
    let operation: String
    let arguments: [String: JSON]
    var after: (() async throws -> Void)? = nil
}
enum Sheet: Identifiable {
    case candidate(JSON), library(JSON), plan(PendingPlan), code(String, String)
    var id: String { switch self { case .candidate(let v): return "candidate-" + v["candidateId"].string; case .library(let v): return "library-" + v["templateId"].string; case .plan(let p): return p.id.uuidString; case .code(let name, _): return "code-" + name } }
}

@MainActor final class LibraryModel: ObservableObject {
    let backend = Backend()
    @Published var section: Section? = Section(rawValue: UserDefaults.standard.string(forKey: "SFLSelectedSection") ?? "") ?? .discover {
        didSet { if let section { UserDefaults.standard.set(section.rawValue, forKey: "SFLSelectedSection") } }
    }
    @Published var ready = false
    @Published var busy = false
    @Published var message = ""
    @Published var error: String?
    @Published var sheet: Sheet?
    @Published var query = ""
    @Published var dataProfile = ""
    @Published var provider = ""
    @Published var result: JSON = .null
    @Published var thumbnails: JSON = .null
    @Published var library: [JSON] = []
    @Published var libraryDirectory = ""
    @Published var workspaceDirectory = ""
    @Published var setupRequired = true
    @Published var connectionConfiguration = ""
    @Published var integrations: JSON = .null
    @Published var previewCache: JSON = .null
    @Published var networkAccess: JSON = .null
    @Published var providers: [JSON] = []
    @Published var syncingGallery = false
    @Published var failedPrefetchIds: Set<String> = []
    private var pages: [Int: (JSON, JSON)] = [:]
    private var starting = false

    func perform(_ task: @escaping () async throws -> Void) {
        if busy { return }
        busy = true
        Task {
            defer { busy = false }
            do { try await task() } catch { self.error = friendlyNetworkError(error) }
        }
    }
    func start() async {
        if starting || ready { return }
        starting = true
        defer { starting = false }
        do {
            try await backend.start()
            syncingGallery = section == .discover
            ready = true
            try await status()
            if section == .discover {
                do { try await gallery() } catch { self.error = friendlyNetworkError(error) }
            } else if section == .library {
                do { try await loadLibrary() } catch { self.error = friendlyNetworkError(error) }
            }
            syncingGallery = false
        } catch { self.error = friendlyNetworkError(error); syncingGallery = false }
    }
    func status() async throws {
        let value = try await backend.call("figure_library_source_status")
        setupRequired = value["setup"]["required"].bool
        if value["library"]["directorySource"].string != "legacy-default" { libraryDirectory = value["library"]["root"].string }
        workspaceDirectory = value["workspace"]["root"].string
        if let connection = try? await backend.request("connection") { connectionConfiguration = connection.pretty }
        if let cache = try? await backend.request("preview-cache") { previewCache = cache }
        if let network = try? await backend.request("network-access") { networkAccess = network }
        let listed = try await backend.call("figure_library_list_provider_sources")
        let sources = listed["result"]["sources"].array
        providers = sources.isEmpty ? listed["sources"].array : sources
    }
    func changeProvider(title: String, _ arguments: [String: JSON]) async throws {
        let value = try await backend.call("figure_library_plan_provider_source_change", arguments)
        if value["envelope"]["outcome"].string == "ok" {
            message = value["envelope"]["summary"].string.isEmpty ? "来源已是最新，无需确认。" : value["envelope"]["summary"].string
            try await status()
            return
        }
        let plan = value["plan"]
        sheet = .plan(PendingPlan(title: title, value: value, operation: "figure_library_apply_provider_source_change", arguments: [
            "planDigest": plan["planDigest"],
            "operationId": text(UUID().uuidString),
            "expectedAction": arguments["action"] ?? plan["action"],
            "expectedProviderId": arguments["expectedProviderId"] ?? arguments["providerId"] ?? plan["providerId"],
        ], after: { [weak self] in try await self?.status(); self?.message = "来源配置已更新。" }))
    }
    func clearPreviewCache() async throws {
        previewCache = try await backend.request("preview-cache", object(["action": text("clear")]))
        message = "已清除 \(previewCache["removed"].int) 张缓存图片。"
    }
    func prefetchPreviewCache(_ providerId: String) async throws {
        previewCache = try await backend.request("preview-cache", object(["action": text("prefetch"), "providerId": text(providerId)]))
        let prefetch = previewCache["prefetch"]
        let label = previewCache["galleries"].array.first { $0["providerId"].string == providerId }?["sourceLabel"].string ?? providerId
        if prefetch["failed"].int > 0 {
            failedPrefetchIds.insert(providerId)
            message = "「\(label)」已下载 \(prefetch["downloaded"].int) 张，已有 \(prefetch["alreadyCached"].int) 张，失败 \(prefetch["failed"].int) 张。可检查系统代理后重试。"
        } else if prefetch["downloaded"].int > 0 {
            failedPrefetchIds.remove(providerId)
            message = "「\(label)」已缓存 \(prefetch["downloaded"].int + prefetch["alreadyCached"].int) 张预览图。"
        } else {
            failedPrefetchIds.remove(providerId)
            message = "「\(label)」的预览图已在缓存中。"
        }
    }
    func cacheGallery(_ providerId: String) -> JSON? {
        previewCache["galleries"].array.first { $0["providerId"].string == providerId }
    }
    func saveNetworkAccess(useSystemProxy: Bool, httpsProxy: String) async throws {
        networkAccess = try await backend.request("network-access", object(["useSystemProxy": .bool(useSystemProxy), "httpsProxy": text(httpsProxy)]))
        let active = networkAccess["activeProxy"].string
        message = useSystemProxy
            ? (active.isEmpty ? "已启用系统代理，但未检测到本机回环代理。" : "已启用系统代理：\(active)")
            : "已关闭系统代理，将直连 GitHub。"
    }
    func revealPreviewCache() {
        let directory = previewCache["directory"].string
        guard !directory.isEmpty else { return }
        if FileManager.default.fileExists(atPath: directory) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory)])
        } else {
            message = "缓存目录尚未创建；请先对某个图库执行「缓存图片」。"
        }
    }
    func display(_ response: JSON) throws {
        let next = try backend.check(response)
        if result["resultSetId"] != next["resultSetId"] { pages.removeAll() }
        result = next
        thumbnails = response["_meta"]["candidatePreviews"]
        pages[next["pageIndex"].int] = (next, thumbnails)
    }
    func gallery() async throws {
        query = ""
        let showSync = result == .null || result["candidates"].array.isEmpty
        if showSync { syncingGallery = true }
        defer { if showSync { syncingGallery = false } }
        var arguments: [String: JSON] = ["limit": .integer(12)]
        if !provider.isEmpty { arguments["providerIds"] = .array([text(provider)]) }
        try display(await backend.request("gallery", object(arguments)))
    }
    func search() async throws {
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { try await gallery(); return }
        let showSync = result == .null || result["candidates"].array.isEmpty
        if showSync { syncingGallery = true }
        defer { if showSync { syncingGallery = false } }
        var arguments: [String: JSON] = ["query": text(query), "limit": .integer(12)]
        if !provider.isEmpty { arguments["providerIds"] = .array([text(provider)]) }
        if !dataProfile.isEmpty { arguments["dataProfile"] = text(dataProfile) }
        try display(await backend.request("call", object(["name": text("figure_library_search"), "arguments": object(arguments)])))
    }
    func nextPage() async throws {
        let cursor = result["pagination"]["nextCursor"]
        guard !cursor.string.isEmpty else { return }
        try display(await backend.request("call", object(["name": text("figure_library_search_page"), "arguments": object(["resultSetId": result["resultSetId"], "cursor": cursor]) ])))
    }
    func previousPage() {
        if let previous = pages[result["pageIndex"].int - 1] { result = previous.0; thumbnails = previous.1 }
    }
    func thumbnail(_ candidate: JSON) -> NSImage? {
        let value = thumbnails[candidate["candidateId"].string]["previewDataUrl"].string
        guard let payload = value.split(separator: ",", maxSplits: 1).last, let data = Data(base64Encoded: String(payload)) else { return nil }
        return NSImage(data: data)
    }
    func loadLibrary() async throws { library = try backend.check(await backend.request("library"))["items"].array }
    func inspect(_ templateID: String) async throws { sheet = .library(try await backend.call("figure_library_review_open", ["templateId": text(templateID)])) }
    func chooseDirectory() -> String? {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
        return panel.runModal() == .OK ? panel.url?.path : nil
    }
    func chooseFile(_ types: [String]) -> URL? {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.canChooseFiles = true; panel.allowedFileTypes = types
        return panel.runModal() == .OK ? panel.url : nil
    }
    func bind() async throws {
        let workspace = workspaceDirectory
        let value = try await backend.call("figure_library_plan_bind_global", ["libraryDirectory": text(libraryDirectory), "migrationMode": text("none")])
        let plan = value["plan"]
        sheet = .plan(PendingPlan(title: "绑定全局图库", value: value, operation: "figure_library_apply_bind_global", arguments: ["planDigest": plan["planDigest"], "operationId": text(UUID().uuidString)], after: { [weak self] in
            guard let self = self else { return }
            let value = try await self.backend.call("figure_library_plan_bind_workspace", ["workspaceDirectory": text(workspace)])
            self.sheet = .plan(PendingPlan(title: "绑定本地工作区", value: value, operation: "figure_library_apply_bind_workspace", arguments: ["planDigest": value["plan"]["planDigest"], "operationId": text(UUID().uuidString)], after: { [weak self] in
                try await self?.status(); self?.message = "本机目录已绑定。"
            }))
        }))
    }
    func apply(_ plan: PendingPlan) async throws {
        _ = try await backend.call(plan.operation, plan.arguments, approve: true)
        sheet = nil
        try await status()
        if section == .library { try await loadLibrary() }
        await Task.yield()
        try await plan.after?()
    }
    func lifecycle(_ templateID: String, _ action: String) async throws {
        let names: [String: (String, String)] = ["publish": ("publish_working_revision", "发布不可变版本"), "discard": ("discard_working_revision", "丢弃当前草稿")]
        guard let config = names[action] else { return }
        let value = try await backend.call("figure_library_plan_" + config.0, ["templateId": text(templateID)])
        let plan = value["plan"]
        sheet = .plan(PendingPlan(title: config.1, value: value, operation: "figure_library_apply_" + config.0, arguments: ["planDigest": plan["planDigest"], "operationId": text(UUID().uuidString), "expectedTemplateId": text(templateID), "expectedSeriesDigest": plan["expectedSeriesDigest"]], after: { [weak self] in try await self?.loadLibrary() }))
    }
    func materialize(_ candidate: JSON, preview: JSON, image: Data, destination: String, network: Bool) async throws {
        let confirmed = try await backend.confirm(preview, image: image)
        let value = try await backend.call("figure_library_plan_materialize", ["providerId": candidate["providerId"], "exactSelector": candidate["exactSelector"], "previewReceipt": confirmed["previewReceipt"], "destination": text(destination), "allowNetwork": .bool(network)])
        let plan = value["plan"]
        sheet = .plan(PendingPlan(title: "保存精确模板到项目", value: value, operation: "figure_library_apply_materialize", arguments: ["planDigest": plan["planDigest"], "operationId": text(UUID().uuidString), "expectedProviderId": candidate["providerId"], "expectedTarget": plan["target"]], after: { [weak self] in self?.message = "模板已保存。未执行绘图代码。" }))
    }
    func importAsset(title: String, description: String, application: String, dataProfile: String, license: String, language: String, image: URL, code: URL?) async throws {
        let imagePath = try await backend.upload(image)
        let codePath = try await code.asyncMap { try await self.backend.upload($0) }
        var arguments: [String: JSON] = [
            "mode": text("create"), "title": text(title), "description": text(description), "application": text(application), "dataProfile": text(dataProfile), "license": text(license), "language": text(language),
            "assetKind": text(codePath == nil ? "visual_reference" : "plot_template"), "codeStatus": text(codePath == nil ? "none" : "scaffold"), "executionStatus": text("not_run"),
            "visualAssets": .array([object(["assetId": text("reference"), "sourcePath": text(imagePath), "visualRole": text("source_reference")])]),
            "confirmations": object(["createOrUpdate": .bool(true), "figureUnitBoundary": .bool(true), "multiImageGrouping": .bool(true), "primaryPreview": .bool(true), "assetKind": .bool(true), "canonicalImplementation": .bool(true), "codeRelationships": .bool(true), "codeOrigin": .bool(true), "executionClaim": .bool(true), "duplicateDecision": text("create_new")])
        ]
        if let codePath = codePath {
            arguments["codeAssets"] = .array([object(["assetId": text("code"), "sourcePath": text(codePath), "codeOrigin": text("user_supplied"), "language": text(language)])])
            arguments["canonicalCodeAssetId"] = text("code")
            arguments["figureCodeLinks"] = .array([object(["visualAssetId": text("reference"), "codeAssetIds": .array([text("code")]), "relationship": text("user_supplied_pair"), "confirmedBy": text("user"), "evidence": text("用户在本地客户端提供图片与代码并明确确认关联。")])])
        }
        let value = try await backend.call("figure_library_plan_working_revision", arguments)
        let plan = value["plan"]
        sheet = .plan(PendingPlan(title: "创建参考图", value: value, operation: "figure_library_apply_working_revision", arguments: ["planDigest": plan["planDigest"], "operationId": text(UUID().uuidString), "expectedAction": plan["action"], "expectedTemplateId": plan["templateId"], "expectedSeriesDigest": plan["expectedSeriesDigest"]], after: { [weak self] in self?.section = .library; try await self?.loadLibrary(); self?.message = "已保存为草稿，审阅后可发布。" }))
    }
}

extension Optional {
    func asyncMap<T>(_ transform: (Wrapped) async throws -> T) async rethrows -> T? {
        if let value = self { return try await transform(value) }; return nil
    }
}
