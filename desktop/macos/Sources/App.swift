import SwiftUI
import AppKit

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    var backend: Backend?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let backend = backend, backend.ready else { return .terminateNow }
        Task {
            let ended = await backend.shutdown()
            if !ended {
                let alert = NSAlert(); alert.messageText = "本地服务正在结束操作"; alert.informativeText = "请稍后再退出，避免中断正在保存的文件。"; alert.runModal()
            }
            sender.reply(toApplicationShouldTerminate: ended)
        }
        return .terminateLater
    }
}

@main @MainActor struct SFLApplication: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var model = LibraryModel()
    var body: some Scene {
        WindowGroup("Scientific Figure Library") {
            RootView(model: model).task {
                appDelegate.backend = model.backend
                await model.start()
                if ProcessInfo.processInfo.environment["SFL_NATIVE_SMOKE"] == "1" {
                    await runNativeSmoke(model: model)
                }
            }
        }
        .defaultSize(width: 1160, height: 820)
        .commands { CommandGroup(replacing: .newItem) {} }
    }
}
