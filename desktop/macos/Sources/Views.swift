import SwiftUI
import AppKit

let libraryGreen = Color(red: 0.14, green: 0.42, blue: 0.30)

@MainActor struct RootView: View {
    @ObservedObject var model: LibraryModel
    var currentSection: Section {
        model.section ?? Section(rawValue: UserDefaults.standard.string(forKey: "SFLSelectedSection") ?? "") ?? .discover
    }
    var body: some View {
        NavigationSplitView {
            List(Section.allCases, selection: $model.section) { section in Label(section.rawValue, systemImage: section.icon).tag(section) }
                .navigationTitle("Scientific Figure Library")
                .navigationSplitViewColumnWidth(min: 190, ideal: 220)
        } detail: {
            VStack(alignment: .leading, spacing: 0) {
                if !model.ready {
                    VStack(spacing: 18) { ProgressView(); Text(model.error ?? "正在启动本地知识库…"); Button("重试") { Task { await model.start() } }; if model.backend.usesSystemNode { Button("选择本机 Node…") { let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; if panel.runModal() == .OK, let url = panel.url { UserDefaults.standard.set(url.path, forKey: "SFLNodeBinary"); Task { await model.start() } } } } }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    if model.setupRequired && currentSection != .settings {
                        HStack { Label("先选择全局图库和本地工作区", systemImage: "folder.badge.gearshape"); Spacer(); Button("设置目录") { model.section = .settings } }.padding().background(libraryGreen.opacity(0.10))
                    }
                    if !model.message.isEmpty { Text(model.message).font(.callout).foregroundStyle(.secondary).padding(.horizontal).padding(.top, 8) }
                    switch currentSection {
                    case .discover: DiscoverView(model: model)
                    case .library: KnowledgeView(model: model)
                    case .galleries: GalleriesView(model: model)
                    case .add: ImportView(model: model)
                    case .integrations: IntegrationsView(model: model)
                    case .settings: SettingsView(model: model)
                    }
                }
            }
            .background(Color(NSColor.windowBackgroundColor))
            .navigationTitle(currentSection.rawValue)
            .toolbar { if model.busy { ProgressView().controlSize(.small) }; Button { model.perform { try await model.status(); if currentSection == .library { try await model.loadLibrary() } else if currentSection == .discover { try await model.gallery() } } } label: { Image(systemName: "arrow.clockwise") }.help("刷新").disabled(!model.ready || model.busy) }
        }
        .tint(libraryGreen)
        .frame(minWidth: 850, minHeight: 620)
        .onChange(of: model.section) { section in
            if let section {
                UserDefaults.standard.set(section.rawValue, forKey: "SFLSelectedSection")
                if section == .library && model.ready { model.perform { try await model.loadLibrary() } }
            } else {
                model.section = Section(rawValue: UserDefaults.standard.string(forKey: "SFLSelectedSection") ?? "") ?? .discover
            }
        }
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .candidate(let value): CandidateView(model: model, candidate: value)
            case .library(let value): LibraryDetailView(model: model, detail: value)
            case .plan(let value): PlanView(model: model, plan: value)
            case .code(let title, let source): VStack { HStack { Text(title).font(.headline); Spacer(); Button("关闭") { model.sheet = nil } }; ScrollView([.horizontal, .vertical]) { Text(source).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } }.padding(24).frame(width: 800, height: 600)
            }
        }
        .alert("操作未完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("知道了") { model.error = nil } } message: { Text(model.error ?? "") }
    }
}

@MainActor struct DiscoverView: View {
    @ObservedObject var model: LibraryModel
    var candidates: [JSON] { model.result["candidates"].array }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack { TextField("搜索图片、图形类型或应用场景", text: $model.query).textFieldStyle(.roundedBorder).onSubmit { model.perform { try await model.search() } }; Button("搜索") { model.perform { try await model.search() } }.buttonStyle(.borderedProminent).disabled(model.busy || model.query.isEmpty) }
                HStack { Picker("来源", selection: $model.provider) {
                    Text("全部默认来源").tag("")
                    ForEach(model.providers.indices, id: \.self) { index in
                        let source = model.providers[index]
                        if source["enabled"] != .bool(false) { Text(source["sourceLabel"].string.isEmpty ? source["providerId"].string : source["sourceLabel"].string).tag(source["providerId"].string) }
                    }
                }.frame(maxWidth: 330); TextField("数据特征（可选）", text: $model.dataProfile).textFieldStyle(.roundedBorder) }
                HStack { ForEach(["火山图", "热图", "UMAP", "细胞比例", "富集分析"], id: \.self) { label in Button(label) { model.query = ["火山图": "volcano differential expression", "热图": "heatmap expression", "UMAP": "UMAP single cell", "细胞比例": "cell proportion barplot", "富集分析": "GO enrichment"][label]!; model.perform { try await model.search() } }.disabled(model.busy) } }
                Text("打开图库即浏览图片。在线图库不会在安装时下载；请到「外部图库」或设置的「图片缓存」中对某个图库执行「缓存图片」。已缓存的图片可离线查看。").font(.callout).foregroundStyle(.secondary)
                HStack { Text(model.query.isEmpty && model.result != .null ? "图库" : "候选图片").font(.headline); Spacer(); if model.result != .null { Text("\(model.result["total"].int) 个结果").foregroundStyle(.secondary) } }
                galleryPager
                if model.syncingGallery && candidates.isEmpty {
                    VStack(spacing: 16) { ProgressView(); Text("正在同步图库…").foregroundStyle(.secondary) }.frame(maxWidth: .infinity).padding(.vertical, 80)
                } else if candidates.isEmpty { VStack(spacing: 12) { Image(systemName: "photo.on.rectangle.angled").font(.system(size: 40)).foregroundStyle(.secondary); Text("图片与代码，成为下一次研究的起点").font(.headline); Text("打开图库即浏览全部图片。可用搜索或常见图形筛选。自己的资产在「我的图库」，也可以「创建参考图」。").foregroundStyle(.secondary) }.frame(maxWidth: .infinity).padding(.vertical, 80) }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 230, maximum: 360))], spacing: 20) {
                    ForEach(candidates.indices, id: \.self) { index in
                        let candidate = candidates[index]
                        Button { model.sheet = .candidate(candidate) } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                Group { if let image = model.thumbnail(candidate) { Image(nsImage: image).resizable().scaledToFit() } else { Image(systemName: "photo").font(.largeTitle).foregroundStyle(.secondary) } }.frame(maxWidth: .infinity).frame(height: 170).background(Color.white)
                                Text(candidate["title"].string).font(.headline).lineLimit(3)
                                Text(candidate["sourceLabel"].string).font(.caption).foregroundStyle(libraryGreen)
                                Text(candidate["application"].string).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                            }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Color(NSColor.controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.plain).contextMenu { Button("复制精确引用") { copyText(object(["title": candidate["title"], "providerId": candidate["providerId"], "exactSelector": candidate["exactSelector"]]).pretty) } }
                    }
                }
                galleryPager
            }.padding(28)
        }
        .onChange(of: model.provider) { _ in model.perform { try await model.search() } }
    }
    var galleryPager: some View {
        let total = model.result["total"].int
        let size = max(1, model.result["pagination"]["pageSize"].int)
        let pages = max(1, Int(ceil(Double(total) / Double(size))))
        return Group {
            if model.result != .null && total > 0 {
                HStack {
                    Button("上一页") { model.previousPage() }.disabled(model.result["pageIndex"].int <= 1)
                    Spacer()
                    Text("第 \(model.result["pageIndex"].int) / \(pages) 页")
                    Spacer()
                    Button("下一页") { model.perform { try await model.nextPage() } }.disabled(model.result["pagination"]["nextCursor"].string.isEmpty || model.busy)
                }
            }
        }
    }
}

func jsonStrings(_ value: JSON) -> [String] {
    value.array.map(\.string).filter { !$0.isEmpty }
}
func candidateIdentityLines(_ candidate: JSON) -> [String] {
    let selector = candidate["exactSelector"]
    let identity = selector["identity"]
    let archive = identity["archive"]
    let digest = archive["digest"].string.isEmpty ? archive["sha256"].string : archive["digest"].string
    var lines = [
        "来源：\(candidate["sourceLabel"].string.isEmpty ? candidate["providerId"].string : candidate["sourceLabel"].string)",
        "providerId：\(candidate["providerId"].string)",
    ]
    if !candidate["templateId"].string.isEmpty { lines.append("templateId：\(candidate["templateId"].string)") }
    if !selector["kind"].string.isEmpty { lines.append("选择器：\(selector["kind"].string)") }
    if !identity["moduleId"].string.isEmpty { lines.append("模块：\(identity["moduleId"].string)") }
    if !identity["mode"].string.isEmpty { lines.append("物化模式：\(identity["mode"].string)") }
    let modes = jsonStrings(candidate["materializationModes"])
    if !modes.isEmpty { lines.append("可选物化模式：\(modes.joined(separator: ", "))") }
    if !identity["sourceCommit"].string.isEmpty { lines.append("源码 commit：\(identity["sourceCommit"].string)") }
    if !identity["archiveCommit"].string.isEmpty { lines.append("归档 commit：\(identity["archiveCommit"].string)") }
    if !archive["repository"].string.isEmpty { lines.append("归档仓库：\(archive["repository"].string)") }
    if !archive["path"].string.isEmpty { lines.append("归档路径：\(archive["path"].string)") }
    if !digest.isEmpty { lines.append("ZIP SHA-256：\(digest)") }
    if archive["bytes"].int > 0 { lines.append("归档大小：\(formatBytes(archive["bytes"].int))") }
    if !identity["catalogSha256"].string.isEmpty { lines.append("目录 SHA-256：\(identity["catalogSha256"].string)") }
    return lines.filter { !$0.hasSuffix("：") }
}
func candidateProviderLines(_ candidate: JSON) -> [String] {
    var lines = ["来源：\(candidate["sourceLabel"].string)"]
    if !candidate["upstreamStatus"].string.isEmpty { lines.append("上游状态：\(candidate["upstreamStatus"].string)") }
    if !candidate["publisherReviewStatus"].string.isEmpty { lines.append("发布者审核状态：\(candidate["publisherReviewStatus"].string)") }
    if !candidate["publisherExecutionStatus"].string.isEmpty {
        let scope = candidate["publisherExecutionScope"].string
        lines.append("发布者执行状态：\(candidate["publisherExecutionStatus"].string)" + (scope.isEmpty ? "" : "（\(scope)）"))
    }
    if !candidate["reviewStatus"].string.isEmpty { lines.append("SFL Local review：\(candidate["reviewStatus"].string)") }
    if !candidate["executionStatus"].string.isEmpty { lines.append("SFL execution：\(candidate["executionStatus"].string)") }
    if candidate["codeExecutedBySflClient"] != .null { lines.append("SFL code execution：\(candidate["codeExecutedBySflClient"].bool)") }
    return lines
}
func candidateValidationLines(_ candidate: JSON) -> [String] {
    let state = candidate["validationState"]
    let plot = state["plotExecution"]
    let upstream = state["upstreamWorkflow"]
    let science = state["scientificValidation"]
    if state == .null { return [] }
    var lines = ["绘图执行：\(plot["status"].string.isEmpty ? candidate["executionStatus"].string : plot["status"].string)"]
    if !plot["scope"].string.isEmpty { lines[0] += "（范围：\(plot["scope"].string)）" }
    if !upstream["status"].string.isEmpty {
        lines.append("上游流程：\(upstream["status"].string)" + (upstream["scope"].string.isEmpty ? "" : "（范围：\(upstream["scope"].string)）"))
    }
    if !science["status"].string.isEmpty {
        lines.append("科学验证：\(science["status"].string)" + (science["decisionSource"].string.isEmpty ? "" : "（来源：\(science["decisionSource"].string)）"))
    }
    return lines
}

@MainActor struct CandidateMetaSection: View {
    let title: String
    let lines: [String]
    var monospaced = false
    var body: some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline)
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line).font(monospaced ? .system(.body, design: .monospaced) : .body).textSelection(.enabled)
                }
            }
        }
    }
}

@MainActor struct CandidateView: View {
    @ObservedObject var model: LibraryModel
    let candidate: JSON
    @State private var preview: JSON?
    @State private var bytes: Data?
    @State private var exactImage: NSImage?
    @State private var displayed = false
    @State private var destination = ""
    @State private var allowNetwork = false
    @State private var showTechnical = false
    var chips: [String] {
        [candidate["sourceLabel"].string, candidate["assetKind"].string, candidate["language"].string, candidate["plotFamily"].string].filter { !$0.isEmpty }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(candidate["title"].string).font(.title2).bold()
                Spacer()
                Button(showTechnical ? "收起技术信息" : "技术与验证信息") { showTechnical.toggle() }
                Button("关闭") { model.sheet = nil }
            }
            HStack(alignment: .top, spacing: 18) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let image = exactImage { Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 360).onAppear { displayed = true } }
                        else if let image = model.thumbnail(candidate) { Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 300) }
                        if !candidate["titleEn"].string.isEmpty { Text(candidate["titleEn"].string).foregroundStyle(.secondary).textSelection(.enabled) }
                        if !chips.isEmpty {
                            HStack(spacing: 8) {
                                ForEach(chips, id: \.self) { chip in Text(chip).font(.caption).padding(.horizontal, 8).padding(.vertical, 4).background(Color(NSColor.controlBackgroundColor)).clipShape(Capsule()) }
                            }
                        }
                        Text(formatCatalogProse(candidate["description"].string)).textSelection(.enabled)
                        if !candidate["application"].string.isEmpty { Text("适用场景").font(.headline); Text(formatCatalogProse(candidate["application"].string)).textSelection(.enabled) }
                        if !candidate["dataProfile"].string.isEmpty { Text("数据特征").font(.headline); Text(formatCatalogProse(candidate["dataProfile"].string)).textSelection(.enabled) }
                        CandidateMetaSection(title: "代码文件", lines: jsonStrings(candidate["codeFiles"]), monospaced: true)
                        CandidateMetaSection(title: "输入文件", lines: jsonStrings(candidate["inputFiles"]), monospaced: true)
                        CandidateMetaSection(title: "依赖包", lines: jsonStrings(candidate["packages"]), monospaced: true)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                if showTechnical {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("技术与验证信息").font(.headline)
                            CandidateMetaSection(title: "来源与版本", lines: candidateIdentityLines(candidate), monospaced: true)
                            CandidateMetaSection(title: "来源与执行边界", lines: candidateProviderLines(candidate))
                            CandidateMetaSection(title: "验证状态", lines: candidateValidationLines(candidate))
                            CandidateMetaSection(title: "检索原因", lines: jsonStrings(candidate["reasons"]))
                            CandidateMetaSection(title: "警告", lines: jsonStrings(candidate["warnings"]))
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }.frame(width: 280).background(Color(NSColor.controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            Text(displayed ? "请核对上方精确图片，确认后保存到项目。" : "保存到项目前会先加载精确图片。请核对你看到的就是将要保存的文件。").font(.callout).foregroundStyle(.secondary)
            Divider()
            HStack { TextField("保存到项目的目标父目录", text: $destination).textFieldStyle(.roundedBorder); Button("选择目录") { if let path = model.chooseDirectory() { destination = path } } }
            Toggle("允许下载所选模板的固定版本归档", isOn: $allowNetwork).font(.callout)
            HStack {
                Button("仅查看精确图片") { model.perform {
                    displayed = false
                    let result = try await model.backend.exactPreview(["resultSetId": model.result["resultSetId"], "providerId": candidate["providerId"], "exactSelector": candidate["exactSelector"]])
                    preview = result.0; bytes = result.1; exactImage = result.2
                } }.disabled(model.busy || !candidate["previewAvailable"].bool)
                Spacer()
                Button(displayed ? "确认并保存到项目" : "加载精确图片并保存") {
                    if displayed {
                        guard let preview = preview, let bytes = bytes else { return }
                        model.perform { try await model.materialize(candidate, preview: preview, image: bytes, destination: destination, network: allowNetwork) }
                    } else {
                        model.perform {
                            displayed = false
                            let result = try await model.backend.exactPreview(["resultSetId": model.result["resultSetId"], "providerId": candidate["providerId"], "exactSelector": candidate["exactSelector"]])
                            preview = result.0; bytes = result.1; exactImage = result.2
                        }
                    }
                }.buttonStyle(.borderedProminent).disabled(model.busy || !candidate["previewAvailable"].bool || (displayed && destination.isEmpty))
            }
        }.padding(26).frame(width: showTechnical ? 1080 : 780, height: 730)
    }
}

@MainActor struct PlanView: View {
    @ObservedObject var model: LibraryModel
    let plan: PendingPlan
    var target: String { let value = plan.value["plan"]; return [value["target"], value["libraryDirectory"], value["workspaceDirectory"]].first(where: { !$0.string.isEmpty })?.string ?? "" }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(plan.title).font(.title2).bold()
            if !plan.value["plan"]["providerId"].string.isEmpty { LabeledContent("图库来源", value: plan.value["plan"]["providerId"].string).textSelection(.enabled) }
            if !plan.value["plan"]["manifestUrl"].string.isEmpty { LabeledContent("清单地址", value: plan.value["plan"]["manifestUrl"].string).textSelection(.enabled) }
            if !target.isEmpty { LabeledContent("目标目录", value: target).textSelection(.enabled) }
            Text(plan.value["envelope"]["summary"].string).foregroundStyle(.secondary).textSelection(.enabled)
            DisclosureGroup("完整计划与校验信息") { ScrollView { Text(plan.value.pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 260) }
            HStack { Button("取消") { model.sheet = nil }; Spacer(); Button("确认执行") { model.perform { try await model.apply(plan) } }.buttonStyle(.borderedProminent).disabled(model.busy) }
        }.padding(30).frame(width: 650)
    }
}

@MainActor struct KnowledgeView: View {
    @ObservedObject var model: LibraryModel
    var body: some View {
        VStack {
            if model.library.isEmpty { VStack(spacing: 16) { Image(systemName: "books.vertical").font(.system(size: 40)).foregroundStyle(.secondary); Text("我的图库还没有资产").font(.title3); Button("创建参考图") { model.section = .add } }.frame(maxWidth: .infinity, maxHeight: .infinity) }
            else { List(model.library.indices, id: \.self) { index in let value = model.library[index]; HStack { VStack(alignment: .leading, spacing: 7) { Text(value["title"].string).font(.headline); Text(value["workingHead"] == .null ? "已发布" : "有待审阅草稿").font(.caption).foregroundStyle(.secondary) }; Spacer(); Button("查看与管理") { model.perform { try await model.inspect(value["templateId"].string) } }.disabled(model.busy) }.padding(.vertical, 8) } }
        }.padding(16)
    }
}

@MainActor struct LibraryDetailView: View {
    @ObservedObject var model: LibraryModel
    let detail: JSON
    @State private var image: NSImage?
    var content: JSON { detail["workingContent"] == .null ? detail["publishedContent"] : detail["workingContent"] }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text(content["title"].string).font(.title2).bold(); Spacer(); Button("关闭") { model.sheet = nil } }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let image = image { Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 320) }
                    Text(content["description"].string).textSelection(.enabled)
                    Text(content["application"].string).foregroundStyle(.secondary).textSelection(.enabled)
                    let assets = content["assets"].array.filter { $0["role"].string == "code" }
                    ForEach(assets.indices, id: \.self) { index in let asset = assets[index]; Button("查看代码：" + asset["logicalPath"].string) { model.perform {
                        let value = try model.backend.check(await model.backend.request("asset", object(["templateId": detail["templateId"], "revisionId": content["revisionId"], "contentDigest": content["contentDigest"], "logicalPath": asset["logicalPath"]])))
                        guard let bytes = Data(base64Encoded: value["data"].string) else { return }
                        model.sheet = .code(asset["logicalPath"].string, String(decoding: bytes, as: UTF8.self))
                    } } }
                    DisclosureGroup("审阅与版本历史") { Text(object(["workingReview": detail["workingReview"], "publishedReview": detail["publishedReview"], "history": detail["history"]]).pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if detail["workingContent"] != .null { HStack { Button("丢弃草稿", role: .destructive) { model.perform { try await model.lifecycle(detail["templateId"].string, "discard") } }; Spacer(); Button("发布草稿") { model.perform { try await model.lifecycle(detail["templateId"].string, "publish") } }.buttonStyle(.borderedProminent) }.disabled(model.busy) }
        }.padding(26).frame(width: 750, height: 670)
        .task {
            do {
                if !content["primaryPreview"].string.isEmpty {
                    let value = try model.backend.check(await model.backend.request("asset", object(["templateId": detail["templateId"], "revisionId": content["revisionId"], "contentDigest": content["contentDigest"], "logicalPath": content["primaryPreview"]])))
                    if let data = Data(base64Encoded: value["data"].string) { image = NSImage(data: data) }
                }
            } catch { model.error = error.localizedDescription }
        }
    }
}

@MainActor struct ImportView: View {
    @ObservedObject var model: LibraryModel
    @State private var title = ""
    @State private var description = ""
    @State private var application = ""
    @State private var dataProfile = ""
    @State private var license = "仅供本地参考"
    @State private var language = "R"
    @State private var image: URL?
    @State private var code: URL?
    @State private var confirmed = false
    var body: some View {
        Form {
            SwiftUI.Section("图片与代码") {
                TextField("名称", text: $title)
                HStack { Text("参考图片"); Spacer(); Text(image?.lastPathComponent ?? "未选择").foregroundStyle(.secondary); Button("选择图片") { image = model.chooseFile(["png", "jpg", "jpeg", "webp"]) } }
                HStack { Text("对应代码（可选）"); Spacer(); Text(code?.lastPathComponent ?? "未选择").foregroundStyle(.secondary); Button("选择代码") { code = model.chooseFile(["R", "r", "py", "txt"]) }; if code != nil { Button("移除") { code = nil } } }
                Picker("代码语言", selection: $language) { Text("R").tag("R"); Text("Python").tag("Python") }
                TextField("许可与使用范围", text: $license)
            }
            SwiftUI.Section("说明") {
                TextField("图片说明", text: $description, axis: .vertical).lineLimit(3...6)
                TextField("适用场景（必填）", text: $application, axis: .vertical).lineLimit(3...6)
                TextField("数据要求", text: $dataProfile, axis: .vertical).lineLimit(2...4)
            }
            SwiftUI.Section {
                Toggle("确认这是一份完整的图片资产；附带代码由我提供，并确认与图片关联。执行与科学验证均记为未验证。", isOn: $confirmed)
                Button("预览导入计划") { guard let image = image else { return }; model.perform { try await model.importAsset(title: title, description: description, application: application, dataProfile: dataProfile, license: license, language: language, image: image, code: code) } }.buttonStyle(.borderedProminent).disabled(model.busy || !confirmed || title.isEmpty || application.isEmpty || image == nil || license.isEmpty)
            }
        }.formStyle(.grouped)
    }
}

func sourceKindLabel(_ source: JSON) -> String {
    switch source["sourceKind"].string {
    case "local-published": return "本机已发布"
    case "figureya": return "内置 FigureYa"
    case "official-signed-overlay": return "官方频道"
    case "signed-personal": return "个人来源"
    default: return source["frozen"].bool ? "冻结兼容" : (source["bundled"].bool ? "内置" : source["sourceKind"].string)
    }
}
func sourceAddress(_ source: JSON) -> String {
    let value = source["manifestUrl"].string
    return value.isEmpty ? source["details"]["manifestUrl"].string : value
}
func sourceHealth(_ source: JSON) -> String {
    if source["enabled"] == .bool(false) { return "未启用" }
    switch source["health"].string {
    case "degraded": return "降级"
    case "corrupt": return "损坏"
    case "", "ready": return "可用"
    default: return source["health"].string
    }
}

func networkAccessSummary(_ value: JSON) -> String {
    switch value["source"].string {
    case "saved": return "当前使用已保存的本机代理 \(value["activeProxy"].string)。"
    case "system": return "当前来自系统设置或环境变量 \(value["activeProxy"].string)。"
    default: return "当前未使用系统代理。"
    }
}

func formatBytes(_ value: Int) -> String {
    if value < 1024 { return "\(value) B" }
    if value < 1_048_576 { return String(format: "%.1f KB", Double(value) / 1024) }
    return String(format: "%.1f MB", Double(value) / 1_048_576)
}

func galleryMissing(_ gallery: JSON) -> Int {
    let declared = gallery["declared"].int
    let cached = gallery["cached"].int
    if gallery["missing"] != .null { return max(0, gallery["missing"].int) }
    return max(0, declared - cached)
}

func prefetchButtonLabel(_ gallery: JSON, failed: Bool = false) -> String? {
    let missing = galleryMissing(gallery)
    if missing > 0 { return gallery["cached"].int > 0 ? "继续缓存" : "缓存图片" }
    if failed { return "继续缓存" }
    return nil
}

func galleryCacheLabel(_ gallery: JSON) -> String {
    let declared = gallery["declared"].int
    let cached = gallery["cached"].int
    let missing = galleryMissing(gallery)
    if declared == 0 { return "没有可下载的预览图" }
    if missing <= 0 { return "已缓存 \(cached) / \(declared) 张 · \(formatBytes(gallery["bytesCached"].int))" }
    return "可下载 \(declared) 张 · 已缓存 \(cached) 张 · 约 \(formatBytes(gallery["bytesDeclared"].int))"
}

func prefetchConfirmText(label: String, gallery: JSON) -> String {
    let cached = gallery["cached"].int
    let missing = galleryMissing(gallery)
    if cached > 0 && missing > 0 {
        return "继续缓存「\(label)」剩余的 \(missing) 张预览图？已缓存的 \(cached) 张会跳过，不会执行代码。"
    }
    return "缓存「\(label)」的 \(gallery["declared"].int) 张预览图（约 \(formatBytes(gallery["bytesDeclared"].int))）？只下载该图库的固定图片，不会执行代码。"
}

@MainActor struct GalleriesView: View {
    @ObservedObject var model: LibraryModel
    @State private var addProviderId = ""
    @State private var addManifestUrl = ""
    @State private var addPublicKey = ""
    @State private var addDefaultSearch = false
    @State private var replacementUrls: [String: String] = [:]
    @State private var removingProviderId = ""
    var body: some View {
        Form {
            SwiftUI.Section {
                Text("这里管理 FigureYa、Open Figure、社区图库和你添加的已签名图库。它们与「我的图库」分开；本机已发布的资产请到「我的图库」查看。").foregroundStyle(.secondary)
                if model.providers.filter({ $0["providerId"].string != "org.scientificfigurelibrary.local" }).isEmpty {
                    Text("绑定本机目录后可查看内置外部图库。").foregroundStyle(.secondary)
                }
                ForEach(model.providers.indices, id: \.self) { index in
                    if model.providers[index]["providerId"].string != "org.scientificfigurelibrary.local" {
                        ProviderSourceRow(model: model, source: model.providers[index], replacementUrl: Binding(
                            get: { replacementUrls[model.providers[index]["providerId"].string] ?? sourceAddress(model.providers[index]) },
                            set: { replacementUrls[model.providers[index]["providerId"].string] = $0 }
                        ), onRemove: { removingProviderId = model.providers[index]["providerId"].string })
                    }
                }
            } header: {
                Text("已安装的图库")
            }
            SwiftUI.Section {
                Button("检查信息并预览添加计划") {
                    model.perform {
                        try await model.changeProvider(title: "添加图库", [
                            "action": text("add"),
                            "expectedProviderId": text(addProviderId.trimmingCharacters(in: .whitespacesAndNewlines)),
                            "manifestUrl": text(addManifestUrl.trimmingCharacters(in: .whitespacesAndNewlines)),
                            "publicKeyBase64": text(addPublicKey.trimmingCharacters(in: .whitespacesAndNewlines)),
                            "includeInDefaultSearch": .bool(addDefaultSearch),
                        ])
                    }
                }.disabled(model.busy || addProviderId.isEmpty || addManifestUrl.isEmpty || addPublicKey.isEmpty)
            } header: {
                Text("添加图库")
            } footer: {
                Text("向作者索取三份信息：图库 ID、HTTPS 清单地址、独立公钥。公钥不要从清单文件里抄。提交后先预览计划，确认才会写入。")
            }
            SwiftUI.Section {
                TextField("例如 io.example.figures", text: $addProviderId)
                Text("必须与签名清单中的 providerId 完全一致。").font(.caption).foregroundStyle(.secondary)
                TextField("https://example.com/current/source-manifest.json", text: $addManifestUrl)
                Text("公开的 source-manifest.json 地址，必须是 https://。").font(.caption).foregroundStyle(.secondary)
                TextField("作者单独提供的 32 字节公钥", text: $addPublicKey)
                Text("标准 base64。用于校验清单签名，不要用网页或清单里的其他密钥。").font(.caption).foregroundStyle(.secondary)
                Toggle("加入默认搜索", isOn: $addDefaultSearch)
                Text("建议先添加并确认能用，再打开。未打开时只能在来源筛选里显式选择。").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
        .confirmationDialog("移除这个图库？签名图库会取消注册；内置图库只退出搜索，可随时恢复。已物化项目不会删除。", isPresented: Binding(get: { !removingProviderId.isEmpty }, set: { if !$0 { removingProviderId = "" } })) {
            Button("删除", role: .destructive) {
                let providerId = removingProviderId
                removingProviderId = ""
                model.perform { try await model.changeProvider(title: "移除图库", ["action": text("remove"), "providerId": text(providerId)]) }
            }
            Button("取消", role: .cancel) { removingProviderId = "" }
        }
        .task {
            guard model.ready else { return }
            do { try await model.status() } catch { model.error = error.localizedDescription }
        }
    }
}

@MainActor struct SettingsView: View {
    @ObservedObject var model: LibraryModel
    @State private var confirmClearCache = false
    @State private var prefetchingProviderId = ""
    @State private var useSystemProxy = false
    @State private var httpsProxy = ""
    var cacheSummary: String {
        if !model.previewCache["exists"].bool { return "尚未缓存任何在线预览图。请先选择下面的某个图库。" }
        if model.previewCache["fileCount"].int == 0 { return "缓存目录已创建，当前没有图片。" }
        return "已缓存 \(model.previewCache["fileCount"].int) 张图片 · \(formatBytes(model.previewCache["bytes"].int))"
    }
    var prefetchConfirmMessage: String {
        let gallery = model.previewCache["galleries"].array.first { $0["providerId"].string == prefetchingProviderId } ?? .null
        let label = gallery["sourceLabel"].string.isEmpty ? prefetchingProviderId : gallery["sourceLabel"].string
        return prefetchConfirmText(label: label, gallery: gallery)
    }
    var body: some View {
        Form {
            SwiftUI.Section("本机目录") {
                HStack { TextField("全局图库", text: $model.libraryDirectory); Button("选择") { if let value = model.chooseDirectory() { model.libraryDirectory = value } } }
                HStack { TextField("本地工作区", text: $model.workspaceDirectory); Button("选择") { if let value = model.chooseDirectory() { model.workspaceDirectory = value } } }
                Text("目录跨项目共享；更改绑定前会显示具体计划。").foregroundStyle(.secondary)
                Button("检查并确认目录") { model.perform { try await model.bind() } }.disabled(model.busy || model.libraryDirectory.isEmpty || model.workspaceDirectory.isEmpty)
            }
            SwiftUI.Section("系统代理") {
                Text("访问 GitHub 清单和预览图时，可走本机回环 HTTP 代理（CONNECT）。目标仍是 GitHub 的 HTTPS 地址，下载后按 SHA-256 校验。默认关闭，以免 Clash fake-ip（如 198.18.x）被当成目标地址。").foregroundStyle(.secondary)
                Toggle("使用系统代理", isOn: $useSystemProxy)
                TextField("本地 HTTPS 代理，例如 http://127.0.0.1:7897", text: $httpsProxy).disabled(!useSystemProxy)
                Text(networkAccessSummary(model.networkAccess)).foregroundStyle(.secondary)
                Button("保存代理") { model.perform { try await model.saveNetworkAccess(useSystemProxy: useSystemProxy, httpsProxy: httpsProxy) } }.disabled(model.busy)
            }
            SwiftUI.Section("图片缓存") {
                LabeledContent("缓存目录") { Text(model.previewCache["directory"].string).textSelection(.enabled) }
                Text(cacheSummary).foregroundStyle(.secondary)
                Text("安装不会下载在线图库图片。请选择下面的某个图库并缓存；搜索该图库的当前页或打开精确预览也会写入同一目录。「我的图库」不需要这一步。清除后需重新缓存或再次查看；已确认图片需重新预览再保存模板。").foregroundStyle(.secondary)
                if model.previewCache["galleries"].array.isEmpty {
                    Text("当前安装已包含图库图片，或尚未出现可下载清单。轻量安装包里的 FigureYa 与 Open Figure 需要在这里按图库下载。").foregroundStyle(.secondary)
                }
                ForEach(model.previewCache["galleries"].array.indices, id: \.self) { index in
                    let gallery = model.previewCache["galleries"].array[index]
                    VStack(alignment: .leading, spacing: 6) {
                        Text(gallery["sourceLabel"].string.isEmpty ? gallery["providerId"].string : gallery["sourceLabel"].string).font(.headline)
                        Text(galleryCacheLabel(gallery)).foregroundStyle(.secondary)
                        if let label = prefetchButtonLabel(gallery, failed: model.failedPrefetchIds.contains(gallery["providerId"].string)) {
                            Button(label) { prefetchingProviderId = gallery["providerId"].string }.disabled(model.busy)
                        } else {
                            Text("已缓存").foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 4)
                }
                Button("在 Finder 中显示") { model.revealPreviewCache() }.disabled(model.previewCache["directory"].string.isEmpty)
                Button("复制缓存路径") { copyText(model.previewCache["directory"].string); model.message = "已复制缓存路径。" }.disabled(model.previewCache["directory"].string.isEmpty)
                Button("清除缓存", role: .destructive) { confirmClearCache = true }.disabled(model.busy || model.previewCache["fileCount"].int == 0)
            }
        }.formStyle(.grouped)
        .confirmationDialog("清除已下载的在线预览图？之后需要重新对某个图库执行「缓存图片」，或再次查看当前页。已确认图片需要重新预览后再保存模板。", isPresented: $confirmClearCache) {
            Button("清除缓存", role: .destructive) { model.perform { try await model.clearPreviewCache() } }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog(prefetchConfirmMessage, isPresented: Binding(get: { !prefetchingProviderId.isEmpty }, set: { if !$0 { prefetchingProviderId = "" } })) {
            Button(prefetchButtonLabel(model.previewCache["galleries"].array.first { $0["providerId"].string == prefetchingProviderId } ?? .null, failed: model.failedPrefetchIds.contains(prefetchingProviderId)) ?? "缓存图片") {
                let providerId = prefetchingProviderId
                prefetchingProviderId = ""
                model.perform { try await model.prefetchPreviewCache(providerId) }
            }
            Button("取消", role: .cancel) { prefetchingProviderId = "" }
        }
        .onChange(of: model.networkAccess) { value in
            useSystemProxy = value["useSystemProxy"].bool
            let saved = value["httpsProxy"].string
            httpsProxy = saved.isEmpty ? value["detectedProxy"].string : saved
        }
        .task {
            guard model.ready else { return }
            do {
                try await model.status()
                useSystemProxy = model.networkAccess["useSystemProxy"].bool
                let saved = model.networkAccess["httpsProxy"].string
                httpsProxy = saved.isEmpty ? model.networkAccess["detectedProxy"].string : saved
            } catch { model.error = error.localizedDescription }
        }
    }
}

@MainActor struct ProviderSourceRow: View {
    @ObservedObject var model: LibraryModel
    let source: JSON
    @Binding var replacementUrl: String
    let onRemove: () -> Void
    @State private var confirmPrefetch = false
    var providerId: String { source["providerId"].string }
    var cacheGallery: JSON? { model.cacheGallery(providerId) }
    var personal: Bool { source["sourceKind"].string == "signed-personal" }
    var official: Bool { source["sourceKind"].string == "official-signed-overlay" }
    var local: Bool { providerId == "org.scientificfigurelibrary.local" }
    var removed: Bool { source["enabled"] == .bool(false) }
    var address: String { sourceAddress(source) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(source["sourceLabel"].string.isEmpty ? providerId : source["sourceLabel"].string).font(.headline)
            Text("\(sourceKindLabel(source)) · \(sourceHealth(source))" + (source["templateCount"] == .null ? "" : " · \(source["templateCount"].int) 个模板")).foregroundStyle(.secondary)
            Text("图库 ID：\(providerId)").font(.caption).textSelection(.enabled)
            Text(address.isEmpty ? (local ? "这是你绑定的本机知识库" : "安装包内置目录") : "清单地址：\(address)").font(.caption).textSelection(.enabled)
            if local { Text("本机知识库不能移除。").font(.caption).foregroundStyle(.secondary) }
            else if removed { Text("已从普通搜索中移除，可恢复。").font(.caption).foregroundStyle(.secondary) }
            else { Text(source["includeInDefaultSearch"].bool ? "已加入默认搜索" : "不参与默认搜索").font(.caption).foregroundStyle(.secondary) }
            if official && !removed && (source["autoRefreshEnabled"].bool || source["details"]["autoRefreshEnabled"].bool) {
                Text("官方频道自动刷新已开启").font(.caption).foregroundStyle(.secondary)
            }
            if let gallery = cacheGallery {
                Text(galleryCacheLabel(gallery)).font(.caption).foregroundStyle(.secondary)
            }
            if let label = prefetchButtonLabel(cacheGallery ?? .null, failed: model.failedPrefetchIds.contains(providerId)) {
                Button(label) { confirmPrefetch = true }.disabled(model.busy)
            }
            if personal && !removed {
                HStack {
                    Button("检查更新") { model.perform { try await model.changeProvider(title: "检查图库更新", ["action": text("update"), "providerId": text(providerId)]) } }
                    Button(source["includeInDefaultSearch"].bool ? "移出默认搜索" : "加入默认搜索") {
                        model.perform { try await model.changeProvider(title: "更改默认搜索", ["action": text("configure"), "providerId": text(providerId), "includeInDefaultSearch": .bool(!source["includeInDefaultSearch"].bool)]) }
                    }
                }.disabled(model.busy)
                HStack {
                    TextField("新的签名清单 HTTPS 地址", text: $replacementUrl)
                    Button("更换地址") {
                        let url = replacementUrl.trimmingCharacters(in: .whitespacesAndNewlines)
                        model.perform { try await model.changeProvider(title: "更换图库地址", ["action": text("configure"), "providerId": text(providerId), "manifestUrl": text(url)]) }
                    }.disabled(model.busy || replacementUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else if official && !removed {
                HStack {
                    Button("检查更新") { model.perform { try await model.changeProvider(title: "检查官方 Open Figure Modules", ["action": text("update"), "providerId": text(providerId)]) } }
                    Button((source["autoRefreshEnabled"].bool || source["details"]["autoRefreshEnabled"].bool) ? "关闭自动刷新" : "开启自动刷新") {
                        let enabled = source["autoRefreshEnabled"].bool || source["details"]["autoRefreshEnabled"].bool
                        model.perform { try await model.changeProvider(title: "更改官方自动刷新", ["action": text("configure"), "providerId": text(providerId), "autoRefresh": .bool(!enabled)]) }
                    }
                }.disabled(model.busy)
            }
            if !local {
                if removed && !personal {
                    Button("恢复") { model.perform { try await model.changeProvider(title: "恢复图库", ["action": text("configure"), "providerId": text(providerId), "enabled": .bool(true)]) } }.disabled(model.busy)
                } else {
                    Button("删除", role: .destructive) { onRemove() }.disabled(model.busy)
                }
            }
        }.padding(.vertical, 6)
        .confirmationDialog(prefetchMessage, isPresented: $confirmPrefetch) {
            Button(prefetchButtonLabel(cacheGallery ?? .null, failed: model.failedPrefetchIds.contains(providerId)) ?? "缓存图片") { model.perform { try await model.prefetchPreviewCache(providerId) } }
            Button("取消", role: .cancel) {}
        }
    }
    var prefetchMessage: String {
        let gallery = cacheGallery ?? .null
        let label = source["sourceLabel"].string.isEmpty ? providerId : source["sourceLabel"].string
        return prefetchConfirmText(label: label, gallery: gallery)
    }
}

func copyText(_ value: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string) }


@MainActor struct IntegrationsView: View {
    @ObservedObject var model: LibraryModel
    @State private var selectedHost = "codex"
    var guide: JSON { model.integrations }
    var host: JSON { guide["hosts"].array.first { $0["id"].string == selectedHost } ?? .null }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("把图库连接到你使用的 CLI 或桌面工具，获取候选图片与代码。").foregroundStyle(.secondary)
                if guide == .null { ProgressView("正在读取本机连接配置…") }
                else {
                    Button("复制 MCP 配置") { copyText(model.connectionConfiguration); model.message = "已复制 MCP 配置。" }.disabled(model.connectionConfiguration.isEmpty)
                    Text("1. 选择外部工具").font(.title2)
                    Picker("目标客户端", selection: $selectedHost) {
                        ForEach(guide["hosts"].array.indices, id: \.self) { index in Text(guide["hosts"].array[index]["title"].string).tag(guide["hosts"].array[index]["id"].string) }
                    }.frame(maxWidth: 440)
                    ForEach(host["steps"].array.indices, id: \.self) { index in Text("\(index + 1). \(host["steps"].array[index].string)") }
                    if let url = URL(string: host["documentationUrl"].string), url.scheme == "https" { Link("查看官方说明", destination: url) }
                    ForEach(guide["snippets"].array.indices, id: \.self) { index in
                        let snippet = guide["snippets"].array[index]
                        if host["snippetIds"].array.contains(snippet["id"]) {
                            Text(snippet["description"].string).font(.callout).foregroundStyle(.secondary)
                            IntegrationSnippetView(title: snippet["title"].string + " · " + snippet["format"].string, value: snippet["content"].string)
                        }
                    }
                    if selectedHost == "other" {
                        IntegrationSnippetView(title: "命令", value: guide["command"].string)
                        IntegrationSnippetView(title: "参数（JSON 数组）", value: guide["args"].pretty)
                    }
                    Divider()
                    Text("2. 加载核心 Skill").font(.title2)
                    Text(guide["skillInstructions"].string)
                    IntegrationSnippetView(title: "Skill 文件夹", value: guide["skillDirectory"].string)
                    IntegrationSnippetView(title: "SKILL.md 路径", value: guide["skillPath"].string)
                    Button("在 Finder 中显示 Skill") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: guide["skillPath"].string)]) }
                    Divider()
                    Text("3. 验证连接").font(.title2)
                    Text("在外部工具中发送下面的指令。工具连接成功和图片成功显示需要分别确认。")
                    IntegrationSnippetView(title: "验证指令", value: guide["verificationPrompt"].string)
                    ForEach(guide["notes"].array.indices, id: \.self) { index in Text(guide["notes"].array[index].string).font(.callout).foregroundStyle(.secondary) }
                }
            }.frame(maxWidth: 850, alignment: .leading).padding(28)
        }.task {
            do { model.integrations = try await model.backend.request("integrations") }
            catch { model.error = error.localizedDescription }
        }
    }
}

@MainActor struct IntegrationSnippetView: View {
    let title: String
    let value: String
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text(title).font(.headline); Spacer(); Button(copied ? "已复制" : "复制") { copyText(value); copied = true } }
            Text(value).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(16).background(Color(NSColor.controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
        .onChange(of: value) { _ in copied = false }
    }
}
