import SwiftUI
import AppKit

func referenceStatusLabel(_ status: JSON, candidate: JSON) -> String {
    if status == .null { return "正在检查本地状态…" }
    let image = status["image"].string == "cached" ? "已缓存" : "待缓存"
    let pack: String
    if status["pack"] != .null || status["archive"].string == "cached" {
        pack = "已缓存"
    } else if status["archive"].string == "not_applicable" {
        pack = "不可获取"
    } else {
        pack = "待缓存"
    }
    return "预览图：\(image) · 参考包：\(pack)"
}

struct ReferenceStateIcons: View {
    let status: JSON
    let candidate: JSON
    private var packReady: Bool { status["pack"] != .null || status["archive"].string == "cached" }
    private var color: Color {
        if packReady { return libraryGreen }
        if status["image"].string == "cached" { return .orange }
        return .secondary
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
               state["pack"]["hasCode"].bool,
               !state["pack"]["prompt"].string.isEmpty {
                prompts.append(state["pack"]["prompt"].string)
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
            if state["pack"]["hasCode"].bool { continue }
            if state["pack"] != .null { continue }
            if !candidate["materializable"].bool || state["archive"].string == "not_applicable" { continue }
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
    var pack: JSON = .null
    var message = "正在检查…"
}

@MainActor struct ReferenceCacheView: View {
    @ObservedObject var model: LibraryModel
    let candidates: [JSON]
    let resultSetId: String
    @State private var items: [ReferenceReviewItem] = []
    @State private var allowNetwork = true
    @State private var busy = true
    @State private var status = "正在检查本地参考包…"
    var pendingIndices: [Int] { items.indices.filter { items[$0].pack == .null && items[$0].candidate["materializable"].bool } }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("缓存 \(candidates.count) 个参考包").font(.title2).bold()
            Text("将把固定版本压缩包保存到图库的参考包目录。这与预览图是两类缓存，不会另存第三份展开副本，也不会启动绘图任务。").foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(items.indices, id: \.self) { index in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(items[index].candidate["title"].string).font(.headline)
                            Text(items[index].message).textSelection(.enabled)
                            if items[index].pack != .null {
                                Text(items[index].pack["target"].string).font(.caption).textSelection(.enabled)
                                HStack {
                                    Button("复制绘图提示词") { model.perform { try await model.copyReference(items[index].candidate, resultSetId: resultSetId) } }
                                    Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: items[index].pack["target"].string)]) }
                                }
                            }
                        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Color(NSColor.controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
            Toggle("缺少参考包时允许联网下载所选固定版本", isOn: $allowNetwork).disabled(busy || pendingIndices.isEmpty)
            Text(status).font(.callout)
            HStack {
                Button("关闭") { model.sheet = nil }.disabled(busy)
                Spacer()
                if !pendingIndices.isEmpty {
                    Button("确认缓存 \(pendingIndices.count) 个参考包") { Task { await apply() } }.disabled(busy)
                }
            }
        }.padding(24).frame(width: 780, height: 560).interactiveDismissDisabled(busy)
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
                if let saved = response["items"].array.first(where: { $0["candidateId"] == candidate["candidateId"] }), saved["pack"] != .null {
                    items[index].pack = saved["pack"]; items[index].message = "参考包已缓存，无需重复下载。"; continue
                }
                guard candidate["materializable"].bool else { items[index].message = "没有可获取的固定版本参考包。"; continue }
                items[index].message = "待下载固定版本参考包。"
            }
            if pendingIndices.isEmpty {
                status = "已缓存参考包可以直接复制提示词。"
                if !model.pendingCopyAfterCache.isEmpty {
                    try await model.copyReadyPrompts(model.pendingCopyAfterCache, resultSetId: resultSetId)
                    model.pendingCopyAfterCache = []
                    status += " " + model.message
                }
            } else {
                status = "确认后下载尚未缓存的固定版本参考包。"
            }
        } catch { status = friendlyNetworkError(error) }
    }
    private func apply() async {
        busy = true
        defer { busy = false }
        for index in pendingIndices {
            do {
                items[index].message = "正在缓存参考包…"
                let response = try await model.backend.request("reference-cache/ensure", object(["resultSetId": text(resultSetId), "candidateId": items[index].candidate["candidateId"], "allowNetwork": .bool(allowNetwork)]))
                items[index].pack = response["pack"]
                items[index].message = response["pack"]["hasCode"].bool ? "参考包已缓存" : "参考包已缓存；此包没有可识别的代码文件"
            } catch { items[index].message = "缓存失败：" + friendlyNetworkError(error) }
        }
        status = "\(items.filter { $0.pack != .null }.count) 个参考包可用。"
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
            status += "已缓存的参考包才能复制绘图提示词。"
        }
    }
}
