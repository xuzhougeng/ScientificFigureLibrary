import SwiftUI
import AppKit

let libraryGreen = Color(red: 0.14, green: 0.42, blue: 0.30)

@MainActor struct RootView: View {
    @ObservedObject var model: LibraryModel
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
                    if model.setupRequired && model.section != .settings {
                        HStack { Label("先选择全局图库和本地工作区", systemImage: "folder.badge.gearshape"); Spacer(); Button("设置目录") { model.section = .settings } }.padding().background(libraryGreen.opacity(0.10))
                    }
                    if !model.message.isEmpty { Text(model.message).font(.callout).foregroundStyle(.secondary).padding(.horizontal).padding(.top, 8) }
                    switch model.section ?? .discover {
                    case .discover: DiscoverView(model: model)
                    case .library: KnowledgeView(model: model)
                    case .add: ImportView(model: model)
                    case .settings: SettingsView(model: model)
                    case .integrations: IntegrationsView(model: model)
                    }
                }
            }
            .background(Color(NSColor.windowBackgroundColor))
            .navigationTitle((model.section ?? .discover).rawValue)
            .toolbar { if model.busy { ProgressView().controlSize(.small) }; Button { model.perform { try await model.status(); if model.section == .library { try await model.loadLibrary() } } } label: { Image(systemName: "arrow.clockwise") }.help("刷新").disabled(!model.ready || model.busy) }
        }
        .tint(libraryGreen)
        .frame(minWidth: 850, minHeight: 620)
        .onChange(of: model.section) { section in if section == .library && model.ready { model.perform { try await model.loadLibrary() } } }
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
                HStack { Picker("来源", selection: $model.provider) { Text("全部默认来源").tag(""); Text("我的已发布图片").tag("org.scientificfigurelibrary.local"); Text("FigureYa").tag("org.figureya.module"); Text("Open Figure Modules").tag("io.github.jarxunlai.personal-figures") }.frame(maxWidth: 330); TextField("数据特征（可选）", text: $model.dataProfile).textFieldStyle(.roundedBorder) }
                HStack { ForEach(["火山图", "热图", "UMAP", "细胞比例", "富集分析"], id: \.self) { label in Button(label) { model.query = ["火山图": "volcano differential expression", "热图": "heatmap expression", "UMAP": "UMAP single cell", "细胞比例": "cell proportion barplot", "富集分析": "GO enrichment"][label]!; model.perform { try await model.search() } }.disabled(model.busy) } }
                Text("在线图库图片首次查看时下载，已缓存的图片可离线查看。").font(.callout).foregroundStyle(.secondary)
                HStack { Text("候选图片").font(.headline); Spacer(); if model.result != .null { Text("\(model.result["total"].int) 个结果").foregroundStyle(.secondary) } }
                if candidates.isEmpty { VStack(spacing: 12) { Image(systemName: "photo.on.rectangle.angled").font(.system(size: 40)).foregroundStyle(.secondary); Text("图片与代码，成为下一次研究的起点").font(.headline); Text("搜索可复用的模板，或导入自己的图片与代码。").foregroundStyle(.secondary) }.frame(maxWidth: .infinity).padding(.vertical, 80) }
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
                if model.result != .null { HStack { Button("上一页") { model.previousPage() }.disabled(model.result["pageIndex"].int <= 1); Spacer(); Text("第 \(model.result["pageIndex"].int) 页"); Spacer(); Button("下一页") { model.perform { try await model.nextPage() } }.disabled(model.result["pagination"]["nextCursor"].string.isEmpty || model.busy) } }
            }.padding(28)
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
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text(candidate["title"].string).font(.title2).bold(); Spacer(); Button("关闭") { model.sheet = nil } }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let image = exactImage { Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 360).onAppear { displayed = true } }
                    else if let image = model.thumbnail(candidate) { Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 300) }
                    Text(candidate["description"].string).textSelection(.enabled)
                    if !candidate["application"].string.isEmpty { Text("适用场景").font(.headline); Text(candidate["application"].string).textSelection(.enabled) }
                    if !candidate["dataProfile"].string.isEmpty { Text("数据要求").font(.headline); Text(candidate["dataProfile"].string).textSelection(.enabled) }
                    DisclosureGroup("代码、来源与版本") { Text(object(["providerId": candidate["providerId"], "exactSelector": candidate["exactSelector"], "codeFiles": candidate["codeFiles"], "inputFiles": candidate["inputFiles"]]).pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack { TextField("保存到项目的目标父目录", text: $destination).textFieldStyle(.roundedBorder); Button("选择目录") { if let path = model.chooseDirectory() { destination = path } } }
            Toggle("允许下载所选模板的固定版本归档", isOn: $allowNetwork).font(.callout)
            HStack {
                Button("查看精确预览") { model.perform {
                    displayed = false
                    let result = try await model.backend.exactPreview(["resultSetId": model.result["resultSetId"], "providerId": candidate["providerId"], "exactSelector": candidate["exactSelector"]])
                    preview = result.0; bytes = result.1; exactImage = result.2
                } }.disabled(model.busy || !candidate["previewAvailable"].bool)
                Spacer()
                Button("确认图片并生成保存计划") { guard let preview = preview, let bytes = bytes else { return }; model.perform { try await model.materialize(candidate, preview: preview, image: bytes, destination: destination, network: allowNetwork) } }.buttonStyle(.borderedProminent).disabled(model.busy || !displayed || destination.isEmpty)
            }
        }.padding(26).frame(width: 780, height: 730)
    }
}

@MainActor struct PlanView: View {
    @ObservedObject var model: LibraryModel
    let plan: PendingPlan
    var target: String { let value = plan.value["plan"]; return [value["target"], value["libraryDirectory"], value["workspaceDirectory"]].first(where: { !$0.string.isEmpty })?.string ?? "" }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(plan.title).font(.title2).bold()
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
            if model.library.isEmpty { VStack(spacing: 16) { Image(systemName: "books.vertical").font(.system(size: 40)).foregroundStyle(.secondary); Text("知识库还没有资产").font(.title3); Button("导入图片与代码") { model.section = .add } }.frame(maxWidth: .infinity, maxHeight: .infinity) }
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

func formatBytes(_ value: Int) -> String {
    if value < 1024 { return "\(value) B" }
    if value < 1_048_576 { return String(format: "%.1f KB", Double(value) / 1024) }
    return String(format: "%.1f MB", Double(value) / 1_048_576)
}

@MainActor struct SettingsView: View {
    @ObservedObject var model: LibraryModel
    @State private var confirmClearCache = false
    var cacheSummary: String {
        if !model.previewCache["exists"].bool { return "尚未下载过在线预览图。" }
        if model.previewCache["fileCount"].int == 0 { return "缓存目录已创建，当前没有图片。" }
        return "已缓存 \(model.previewCache["fileCount"].int) 张图片 · \(formatBytes(model.previewCache["bytes"].int))"
    }
    var body: some View {
        Form {
            SwiftUI.Section("本机目录") {
                HStack { TextField("全局图库", text: $model.libraryDirectory); Button("选择") { if let value = model.chooseDirectory() { model.libraryDirectory = value } } }
                HStack { TextField("本地工作区", text: $model.workspaceDirectory); Button("选择") { if let value = model.chooseDirectory() { model.workspaceDirectory = value } } }
                Text("目录跨项目共享；更改绑定前会显示具体计划。").foregroundStyle(.secondary)
                Button("检查并确认目录") { model.perform { try await model.bind() } }.disabled(model.busy || model.libraryDirectory.isEmpty || model.workspaceDirectory.isEmpty)
            }
            SwiftUI.Section("图片缓存") {
                LabeledContent("缓存目录") { Text(model.previewCache["directory"].string).textSelection(.enabled) }
                Text(cacheSummary).foregroundStyle(.secondary)
                Text("在线图库的缩略图和精确预览按需下载到此目录，与知识库分开。清除后下次查看会重新下载；已确认图片需重新预览再保存模板。").foregroundStyle(.secondary)
                Button("在 Finder 中显示") { model.revealPreviewCache() }.disabled(model.previewCache["directory"].string.isEmpty)
                Button("复制缓存路径") { copyText(model.previewCache["directory"].string); model.message = "已复制缓存路径。" }.disabled(model.previewCache["directory"].string.isEmpty)
                Button("清除缓存", role: .destructive) { confirmClearCache = true }.disabled(model.busy || model.previewCache["fileCount"].int == 0)
            }
            SwiftUI.Section("外部调用") {
                Text("本地客户端直接管理图片、代码与版本。其他 CLI 或桌面工具可通过 MCP 和核心 Skill 使用同一知识库。")
                Button("复制 MCP 配置") { copyText(model.connectionConfiguration); model.message = "已复制 MCP 配置。" }.disabled(model.connectionConfiguration.isEmpty)
                Button("查看安装与连接指令") { model.section = .integrations }
                Text("内置 Node 版可直接使用；no-node 版要求本机 Node.js 22+。客户端不执行绘图代码。").foregroundStyle(.secondary)
            }
            SwiftUI.Section("图片来源") {
                if model.providers.isEmpty { Text("默认检索本地已发布、FigureYa、Open Figure Modules 与已启用的个人来源。").foregroundStyle(.secondary) }
                ForEach(model.providers.indices, id: \.self) { index in
                    let source = model.providers[index]
                    LabeledContent(source["sourceLabel"].string.isEmpty ? source["providerId"].string : source["sourceLabel"].string, value: source["health"].string.isEmpty ? "可用" : source["health"].string)
                }
            }
        }.formStyle(.grouped)
        .confirmationDialog("清除已下载的在线预览图？下次查看会重新下载。已确认图片需要重新预览后再保存模板。", isPresented: $confirmClearCache) {
            Button("清除缓存", role: .destructive) { model.perform { try await model.clearPreviewCache() } }
            Button("取消", role: .cancel) {}
        }
        .task { if model.ready { model.perform { try await model.status() } } }
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
