import Foundation
import AppKit

func nativeSmokeLog(_ stage: String) {
    if ProcessInfo.processInfo.environment["SFL_NATIVE_SMOKE"] == "1" { fputs("Native smoke: \(stage)\n", stderr) }
}

@MainActor func runNativeSmoke(model: LibraryModel) async {
    let environment = ProcessInfo.processInfo.environment
    guard let rawRoot = environment["SFL_SMOKE_ROOT"], URL(fileURLWithPath: rawRoot).lastPathComponent.hasPrefix("sfl-native-smoke-"),
          environment["FIGURE_LIBRARY_DIR"] == rawRoot + "/library",
          environment["XDG_CONFIG_HOME"] == rawRoot + "/config" else {
        fputs("Native smoke requires isolated test directories\n", stderr); exit(1)
    }
    let root = URL(fileURLWithPath: rawRoot)
    func require(_ condition: Bool, _ message: String) throws { if !condition { throw LocalError(message: message) } }
    do {
        try require(model.ready, model.error ?? "Native backend did not start")
        nativeSmokeLog("connection guide and bindings")
        let backend = model.backend
        let connection = try await backend.request("connection")
        model.integrations = try await backend.request("integrations")
        try require(model.integrations["schema"].string == "figure-library.local-integration-guide.v1", "Native connection guide is missing")
        try require(FileManager.default.fileExists(atPath: model.integrations["skillPath"].string), "Installation guide has an invalid Skill path")
        try require(model.integrations["command"] == connection["mcpServers"]["figure-library"]["command"], "Installation guide uses a different runtime")
        let activeNode = connection["mcpServers"]["figure-library"]["command"].string
        if environment["SFL_RUNTIME_MODE"] == "system" {
            try require(URL(fileURLWithPath: activeNode).resolvingSymlinksInPath() == URL(fileURLWithPath: environment["SFL_NODE_BINARY"]!).resolvingSymlinksInPath(), "App did not use selected system Node")
        } else {
            try require(activeNode.contains("/Resources/sfl/runtime/darwin-"), "App did not use private Node")
        }
        let global = try await backend.call("figure_library_plan_bind_global", ["libraryDirectory": text(rawRoot + "/library"), "migrationMode": text("none")])
        _ = try await backend.call("figure_library_apply_bind_global", ["planDigest": global["plan"]["planDigest"], "operationId": text("native-smoke-bind")], approve: true)
        let workspace = try await backend.call("figure_library_plan_bind_workspace", ["workspaceDirectory": text(rawRoot + "/workspace")])
        _ = try await backend.call("figure_library_apply_bind_workspace", ["planDigest": workspace["plan"]["planDigest"], "operationId": text("native-smoke-workspace")], approve: true)
        nativeSmokeLog("on-demand preview manifests")
        guard let assets = Bundle.main.resourceURL?.appendingPathComponent("sfl/assets") else {
            throw LocalError(message: "Installer is missing the bundled assets directory")
        }
        for relative in ["preview-downloads.json", "personal-modules/preview-downloads.json"] {
            let file = assets.appendingPathComponent(relative)
            try require(FileManager.default.fileExists(atPath: file.path), "Installer is missing on-demand preview manifest: \(relative)")
            let manifest = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: file))
            try require(manifest["schema"].string == "figure-library.preview-downloads.v1", "On-demand preview manifest schema is invalid: \(relative)")
            try require(manifest["commit"].string.count == 40, "On-demand preview manifest is not pinned to a commit: \(relative)")
            try require(!manifest["files"].array.isEmpty, "On-demand preview manifest has no files: \(relative)")
        }
        nativeSmokeLog("import and publish")
        let imageURL = root.appendingPathComponent("reference.png")
        let codeURL = root.appendingPathComponent("plot.R")
        try Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!.write(to: imageURL)
        try Data("stop('native smoke must never execute this code')\n".utf8).write(to: codeURL)
        try await model.importAsset(title: "sflnativefixture reference", description: "Synthetic native smoke reference", application: "sflnativefixture test", dataProfile: "x y", license: "MIT", language: "R", image: imageURL, code: codeURL)
        guard case .plan(let imported)? = model.sheet else { throw LocalError(message: "Native import did not create a plan") }
        let templateID = imported.value["plan"]["templateId"].string
        try await model.apply(imported)
        try await model.lifecycle(templateID, "publish")
        guard case .plan(let publication)? = model.sheet else { throw LocalError(message: "Native publish did not create a plan") }
        try await model.apply(publication)
        model.section = .discover
        nativeSmokeLog("local search and materialization")
        model.query = "sflnativefixture"
        model.provider = "org.scientificfigurelibrary.local"
        try await model.search()
        guard let candidate = model.result["candidates"].array.first else { throw LocalError(message: "Native search did not return the published reference: query=\(model.query), provider=\(model.provider), result=\(model.result.pretty), library=\(model.library)") }
        try require(model.thumbnail(candidate) != nil, "Native thumbnail did not decode")
        let preview = try await backend.exactPreview(["resultSetId": model.result["resultSetId"], "providerId": candidate["providerId"], "exactSelector": candidate["exactSelector"]])
        try require(preview.2.size.width > 0, "Native exact preview is empty")
        try await model.materialize(candidate, preview: preview.0, image: preview.1, destination: rawRoot + "/project", network: false)
        guard case .plan(let materialization)? = model.sheet else { throw LocalError(message: "Native materialization did not create a plan") }
        let target = materialization.value["plan"]["target"].string
        try await model.apply(materialization)
        try require(FileManager.default.fileExists(atPath: target + "/template.lock.json"), "Materialization lock is missing")
        let replay = try await backend.call(materialization.operation, materialization.arguments, approve: true)
        try require(replay["envelope"]["outcome"].string == "replayed", "Native materialization did not replay")
        try await model.status()
        await Task.yield()
        guard let window = NSApplication.shared.windows.first(where: { $0.isVisible }), let view = window.contentView else { throw LocalError(message: "SwiftUI window was not created") }
        func capture(_ name: String) throws {
            view.layoutSubtreeIfNeeded()
            guard let image = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
                throw LocalError(message: "Native window capture failed: \(name)")
            }
            view.cacheDisplay(in: view.bounds, to: image)
            guard let png = image.representation(using: .png, properties: [:]) else {
                throw LocalError(message: "Native window PNG encoding failed: \(name)")
            }
            try png.write(to: root.appendingPathComponent(name))
        }
        try capture("native-window.png")
        nativeSmokeLog("capture settings page")
        model.section = .settings
        try await Task.sleep(nanoseconds: 200_000_000)
        try capture("settings-window.png")
        nativeSmokeLog("capture integration page")
        model.section = .integrations
        try await Task.sleep(nanoseconds: 200_000_000)
        try capture("integrations-window.png")
        let report = object(["status": text("passed"), "nativeWindow": .bool(true), "privateRuntime": .bool(environment["SFL_RUNTIME_MODE"] != "system"), "runtimeMode": text(environment["SFL_RUNTIME_MODE"] ?? "bundled"), "syntheticUserActions": .bool(true), "flows": .array(["integrationGuide", "onDemandPreviewManifests", "binding", "upload", "import", "publish", "search", "imageDecode", "localConfirmation", "materialize", "replay", "settings"].map(text))])
        try Data(report.pretty.utf8).write(to: root.appendingPathComponent("native-smoke.json"))
        nativeSmokeLog("shutdown")
        _ = await backend.shutdown()
        nativeSmokeLog("terminate application")
        exit(0)
    } catch {
        let report = object(["status": text("failed"), "error": text(error.localizedDescription)])
        try? Data(report.pretty.utf8).write(to: root.appendingPathComponent("native-smoke.json"))
        fputs("Native smoke failed: \(error.localizedDescription)\n", stderr)
        _ = await model.backend.shutdown()
        exit(1)
    }
}
