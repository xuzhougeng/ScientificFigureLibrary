import SwiftUI
import AppKit

func referenceStatusLabel(_ status: JSON, candidate: JSON) -> String {
    if status == .null { return "正在检查本地状态…" }
    let image: String
    switch status["image"].string {
    case "preview_cached": image = "已缓存"
    case "bundled": image = "可本地读取"
    default: image = "待缓存"
    }
    let pack: String
    switch status["reference"].string {
    case "ready": pack = status["cached"]["hasCode"].bool ? "已缓存 · 含代码" : "已缓存 · 无代码"
    case "invalid": pack = "需重新获取"
    case "unavailable": pack = "不可获取"
    default: pack = candidate["codeStatus"].string == "none" ? "仅图片 · 待缓存" : "待缓存"
    }
    return "预览图：\(image) · 参考包：\(pack)"
}

struct ReferenceStateIcons: View {
    let status: JSON
    let candidate: JSON
    private var ready: Bool { status["reference"].string == "ready" && status["cached"]["hasCode"].bool }
    private var color: Color {
        if ready { return libraryGreen }
        switch status["image"].string {
        case "preview_cached": return .orange
        case "bundled": return Color(red: 0.31, green: 0.47, blue: 0.66)
        default: return .secondary
        }
    }
    var body: some View {
        Circle().fill(color).frame(width: 9, height: 9)
            .padding(4).background(color.opacity(0.08)).clipShape(Circle())
            .frame(width: 30, height: 30)
            .help(referenceStatusLabel(status, candidate: candidate))
            .accessibilityLabel(referenceStatusLabel(status, candidate: candidate))
    }
}

extension LibraryModel {
    func refreshReferenceStates() async throws {
        let candidates = result["candidates"].array
        guard !candidates.isEmpty else { return }
        let resultSetId = result["resultSetId"]
        let response = try await backend.request("reference-cache/status", object(["resultSetId": resultSetId, "candidateIds": .array(candidates.map { $0["candidateId"] })]))
        guard result["resultSetId"] == resultSetId else { return }
        for state in response["items"].array { referenceStates[state["candidateId"].string] = state }
    }
    func copyReadyPrompts(_ candidates: [JSON], resultSetId: String) async throws {
        guard !candidates.isEmpty else { throw LocalError(message: "请选择要复制的参考。") }
        let response = try await backend.request("reference-cache/status", object(["resultSetId": text(resultSetId), "candidateIds": .array(candidates.map { $0["candidateId"] })]))
        var prompts: [String] = []
        for candidate in candidates {
            if let state = response["items"].array.first(where: { $0["candidateId"] == candidate["candidateId"] }),
               state["reference"].string == "ready",
               state["cached"]["hasCode"].bool,
               !state["cached"]["prompt"].string.isEmpty {
                prompts.append(state["cached"]["prompt"].string)
            }
        }
        guard !prompts.isEmpty else { throw LocalError(message: "没有可复制的绘图提示词。请选择有配套代码的参考。") }
        copyText(prompts.joined(separator: "\n\n————\n\n"))
        message = "已复制 \(prompts.count) 条绘图提示词。AI 无法访问本机文件时，请上传提示词列出的材料。"
    }
    func copyReference(_ candidate: JSON, resultSetId: String) async throws {
        try await copyReadyPrompts([candidate], resultSetId: resultSetId)
    }
    func copyOrCache(_ candidates: [JSON], resultSetId: String) async throws {
        guard !candidates.isEmpty, candidates.count <= 12 else { throw LocalError(message: "请选择 1–12 个参考。") }
        let response = try await backend.request("reference-cache/status", object(["resultSetId": text(resultSetId), "candidateIds": .array(candidates.map { $0["candidateId"] })]))
        var needsCache: [JSON] = []
        for candidate in candidates {
            let state = response["items"].array.first(where: { $0["candidateId"] == candidate["candidateId"] }) ?? .null
            if state["reference"].string == "ready" { continue }
            if !candidate["materializable"].bool || state["reference"].string == "unavailable" { continue }
            needsCache.append(candidate)
        }
        if !needsCache.isEmpty {
            pendingCopyAfterCache = candidates
            sheet = .references(needsCache, resultSetId)
            return
        }
        try await copyReadyPrompts(candidates, resultSetId: resultSetId)
    }
}

private struct ReferenceReviewItem: Identifiable {
    let candidate: JSON
    var id: String { candidate["candidateId"].string }
    var preview: JSON = .null
    var bytes: Data?
    var image: NSImage?
    var displayed = false
    var plan: JSON = .null
    var cached: JSON = .null
    var message = "正在检查…"
}

@MainActor struct ReferenceCacheView: View {
    @ObservedObject var model: LibraryModel
    let candidates: [JSON]
    let resultSetId: String
    @State private var items: [ReferenceReviewItem] = []
    @State private var allowNetwork = true
    @State private var busy = true
    @State private var phase = 0
    @State private var status = "正在检查本地参考…"
    var pendingIndices: [Int] { items.indices.filter { items[$0].displayed && items[$0].cached == .null } }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("缓存 \(candidates.count) 个参考").font(.title2).bold()
            Text("查看精确图片后生成缓存计划。图片与代码按固定版本保存在本地参考目录，缓存不会启动绘图任务。").foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(items.indices, id: \.self) { index in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(items[index].candidate["title"].string).font(.headline)
                            if let image = items[index].image {
                                Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 260).onAppear { items[index].displayed = true }
                            }
                            Text(items[index].message).textSelection(.enabled)
                            if items[index].plan != .null {
                                DisclosureGroup("完整缓存计划") { Text(items[index].plan.pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                            }
                            if items[index].cached != .null {
                                Text(items[index].cached["target"].string).font(.caption).textSelection(.enabled)
                                HStack {
                                    Button("复制绘图提示词") { model.perform { try await model.copyReference(items[index].candidate, resultSetId: resultSetId) } }
                                    Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: items[index].cached["target"].string)]) }
                                }
                            }
                        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Color(NSColor.controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
            if phase == 0 { Toggle("缺少代码包时允许联网下载所选固定版本", isOn: $allowNetwork).disabled(busy) }
            Text(status).font(.callout)
            HStack {
                Button("关闭") { model.sheet = nil }.disabled(busy)
                Spacer()
                if phase == 0 {
                    Button("确认已显示图片并生成缓存计划") { Task { await prepare() } }.disabled(busy || pendingIndices.isEmpty || items.contains { $0.image != nil && !$0.displayed })
                } else if phase == 1 {
                    Button("确认缓存 \(items.filter { $0.plan != .null }.count) 个参考") { Task { await apply() } }.disabled(busy || !items.contains { $0.plan != .null })
                }
            }
        }.padding(24).frame(width: 780, height: 720).interactiveDismissDisabled(busy)
        .onDisappear { if !busy { model.pendingCopyAfterCache = [] } }
        .task { await load() }
    }
    private func load() async {
        defer { busy = false }
        items = candidates.map { ReferenceReviewItem(candidate: $0) }
        do {
            let response = try await model.backend.request("reference-cache/status", object(["resultSetId": text(resultSetId), "candidateIds": .array(candidates.map { $0["candidateId"] })]))
            for index in items.indices {
                let candidate = items[index].candidate
                if let saved = response["items"].array.first(where: { $0["candidateId"] == candidate["candidateId"] }), saved["reference"].string == "ready" {
                    items[index].cached = saved["cached"]; items[index].message = "参考已缓存，无需重复下载。"; continue
                }
                guard candidate["materializable"].bool else { items[index].message = "没有可获取的固定版本参考包。"; continue }
                do {
                    let preview = try await model.backend.exactPreview(["resultSetId": text(resultSetId), "providerId": candidate["providerId"], "exactSelector": candidate["exactSelector"]])
                    items[index].preview = preview.0; items[index].bytes = preview.1; items[index].image = preview.2
                    items[index].message = "请查看此精确图片。"
                } catch { items[index].message = friendlyNetworkError(error) }
            }
            status = "请滚动查看全部待缓存图片后生成计划；已缓存参考可以直接复制提示词。"
        } catch { status = friendlyNetworkError(error) }
    }
    private func prepare() async {
        busy = true
        defer { busy = false }
        for index in pendingIndices {
            guard let bytes = items[index].bytes else { continue }
            do {
                let confirmed = try await model.backend.confirm(items[index].preview, image: bytes)
                let response = try await model.backend.request("reference-cache/plan", object(["resultSetId": text(resultSetId), "candidateId": items[index].candidate["candidateId"], "previewReceipt": confirmed["previewReceipt"], "allowNetwork": .bool(allowNetwork)]))
                items[index].plan = response["plan"]
                items[index].message = "待写入：" + response["plan"]["target"].string + (allowNetwork ? "；缺少代码包时联网获取" : "；仅使用本地代码包")
            } catch { items[index].message = "计划失败，未缓存：" + friendlyNetworkError(error) }
        }
        phase = 1; status = "请核对写入目录和下载策略。确认后才开始缓存，失败项不会执行。"
    }
    private func apply() async {
        busy = true
        defer { busy = false }
        for index in items.indices where items[index].plan != .null {
            do {
                items[index].message = "正在缓存…"
                let response = try await model.backend.request("reference-cache/apply", object(["planDigest": items[index].plan["planDigest"], "confirmedBy": text("user")]))
                items[index].cached = response["reference"]
                items[index].message = response["reference"]["hasCode"].bool ? "图片与代码已缓存" : "参考已缓存；此包没有可识别的代码文件"
            } catch { items[index].message = "缓存失败：" + friendlyNetworkError(error) }
        }
        phase = 2; status = "\(items.filter { $0.cached != .null }.count) 个参考可用。"
        do { try await model.refreshReferenceStates() } catch { status += " 状态刷新失败：" + friendlyNetworkError(error) }
        if !model.pendingCopyAfterCache.isEmpty {
            do {
                try await model.copyReadyPrompts(model.pendingCopyAfterCache, resultSetId: resultSetId)
                model.pendingCopyAfterCache = []
                status += " " + model.message
            } catch {
                status += " " + friendlyNetworkError(error)
            }
        } else {
            status += "可用参考才能复制绘图提示词。"
        }
    }
}
