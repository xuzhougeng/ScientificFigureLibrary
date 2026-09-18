import SwiftUI

@MainActor struct GalleryCacheView: View {
    @ObservedObject var model: LibraryModel
    let plan: JSON
    @State private var busy = false
    @State private var finished = false
    @State private var status = "确认后允许联网下载缺失文件；不会执行代码。"
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("缓存外部图库").font(.title2).bold()
            Text("图片：\(plan["images"].int) 张 · 源码包：\(plan["archives"].int) 个")
            Text("校验并补齐当前目录中的固定版本，已有且有效的代码包会复用。不会自动切换目录版本。").foregroundStyle(.secondary)
            Text(plan["imageDirectory"].string).textSelection(.enabled)
            Text(plan["codeDirectory"].string).textSelection(.enabled)
            ScrollView { Text(status).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            if busy { ProgressView("正在校验并缓存，请保持窗口打开…") }
            HStack {
                Button(finished ? "关闭" : "取消") { model.sheet = nil }.disabled(busy)
                Spacer()
                if !finished {
                    Button("确认缓存") {
                        busy = true
                        Task {
                            do {
                                let result = try await model.backend.request("gallery-cache/apply", object(["planDigest": plan["planDigest"], "confirmedBy": text("user")]))
                                status = "本次校验可用：\(result["images"].int) 张图片、\(result["archives"].int) 个源码包；失败 \(result["failures"].array.count) 项。"
                                for failure in result["failures"].array { status += "\n" + failure["item"].string + "：" + failure["message"].string }
                            } catch { status = error.localizedDescription }
                            busy = false; finished = true
                        }
                    }.disabled(busy).buttonStyle(.borderedProminent)
                }
            }
        }.padding(26).frame(width: 620, height: 430).interactiveDismissDisabled(busy)
    }
}
