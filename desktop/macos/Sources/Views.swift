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
                    VStack(spacing: 18) { ProgressView(); Text("正在启动本地知识库…"); Button("重试") { Task { await model.start() } } }.frame(maxWidth: .infinity, maxHeight: .infinity)
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
                    }
                }
            }
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

@MainActor struct SettingsView: View {
    @ObservedObject var model: LibraryModel
    var body: some View {
        Form {
            SwiftUI.Section("本机目录") {
                HStack { TextField("全局图库", text: $model.libraryDirectory); Button("选择") { if let value = model.chooseDirectory() { model.libraryDirectory = value } } }
                HStack { TextField("本地工作区", text: $model.workspaceDirectory); Button("选择") { if let value = model.chooseDirectory() { model.workspaceDirectory = value } } }
                Text("目录跨项目共享；更改绑定前会显示具体计划。").foregroundStyle(.secondary)
                Button("检查并确认目录") { model.perform { try await model.bind() } }.disabled(model.busy || model.libraryDirectory.isEmpty || model.workspaceDirectory.isEmpty)
            }
            SwiftUI.Section("外部调用") {
                Text("本地客户端直接管理图片、代码与版本。其他 CLI 或桌面工具可通过 MCP 和核心 Skill 使用同一知识库。")
                Button("复制 MCP 配置") { copyText(model.connectionConfiguration); model.message = "已复制 MCP 配置。" }.disabled(model.connectionConfiguration.isEmpty)
                Text("安装包内附 Node 运行时，无需另外安装。客户端不执行绘图代码。").foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
    }
}

func copyText(_ value: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string) }
