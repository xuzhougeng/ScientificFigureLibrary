import SwiftUI

let localTagProvider = "org.scientificfigurelibrary.local"

@MainActor struct CustomTagControl: View {
    @ObservedObject var model: LibraryModel
    let providerId: String
    let templateId: String
    let title: String
    let target: JSON
    @State private var editing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            let tags = model.customTags(providerId: providerId, templateId: templateId)
            if !tags.isEmpty { Text(tags.joined(separator: " · ")).font(.caption).foregroundStyle(libraryGreen).lineLimit(2).accessibilityLabel("自定义标签：" + tags.joined(separator: "、")) }
            Button("编辑标签") { editing = true }.font(.caption).help("编辑个人标签，模板原有标签不变")
        }
        .sheet(isPresented: $editing) { CustomTagEditor(model: model, providerId: providerId, templateId: templateId, title: title, target: target) }
    }
}

@MainActor struct CustomTagEditor: View {
    @ObservedObject var model: LibraryModel
    let providerId: String
    let templateId: String
    let title: String
    let target: JSON
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var original: [String] = []
    @State private var libraryContext = ""
    @State private var error = ""
    @State private var loading = true
    @State private var saving = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("自定义标签 · " + title).font(.headline)
            TextField("标签（逗号分隔），例如：单细胞, 待使用", text: $input).textFieldStyle(.roundedBorder).disabled(loading || saving)
            Text("最多 20 个标签，每个最多 40 字符；清空后保存可移除全部个人标签。模板原有标签不变。").font(.callout).foregroundStyle(.secondary)
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("取消") { dismiss() }
                Spacer()
                Button(saving ? "保存中…" : "保存标签") { Task { await save() } }.disabled(loading || saving)
            }
        }.padding(24).frame(width: 520)
        .task {
            do {
                try await model.refreshCustomTags()
                original = model.customTags(providerId: providerId, templateId: templateId)
                libraryContext = model.customTagState["libraryContext"].string
                input = original.joined(separator: ", ")
                loading = false
            } catch { self.error = error.localizedDescription }
        }
    }
    func save() async {
        saving = true
        defer { saving = false }
        let tags = input.components(separatedBy: CharacterSet(charactersIn: ",，\n")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        do {
            model.customTagState = try await model.backend.request("custom-tags", object([
                "target": target, "tags": .array(tags.map(text)), "expectedTags": .array(original.map(text)), "libraryContext": text(libraryContext),
            ]))
            model.message = "自定义标签已保存。"
            dismiss()
            if model.section == .discover && !model.customTagFilter.isEmpty {
                model.sheet = nil
                do { try await model.search() } catch { model.error = "标签已保存，但刷新失败：" + error.localizedDescription }
            }
        } catch { self.error = error.localizedDescription }
    }
}
