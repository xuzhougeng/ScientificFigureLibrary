import Foundation
import AppKit

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
        let backend = model.backend
        let global = try await backend.call("figure_library_plan_bind_global", ["libraryDirectory": text(rawRoot + "/library"), "migrationMode": text("none")])
        _ = try await backend.call("figure_library_apply_bind_global", ["planDigest": global["plan"]["planDigest"], "operationId": text("native-smoke-bind")], approve: true)
        let workspace = try await backend.call("figure_library_plan_bind_workspace", ["workspaceDirectory": text(rawRoot + "/workspace")])
        _ = try await backend.call("figure_library_apply_bind_workspace", ["planDigest": workspace["plan"]["planDigest"], "operationId": text("native-smoke-workspace")], approve: true)
        for providerID in ["org.figureya.module", "io.github.jarxunlai.personal-figures"] {
            try model.display(await backend.request("call", object(["name": text("figure_library_search"), "arguments": object(["query": text("heatmap"), "providerIds": .array([text(providerID)]), "limit": .integer(1)])])))
            let found = model.result
            guard let candidate = found["candidates"].array.first else { throw LocalError(message: "Remote catalog returned no candidate") }
            try require(candidate["previewDelivery"].string == "download", "Installer did not use on-demand previews")
            try require(model.thumbnail(candidate) != nil, "Downloaded native thumbnail did not decode")
            let exact = try await backend.exactPreview(["resultSetId": found["resultSetId"], "providerId": text(providerID), "exactSelector": candidate["exactSelector"]])
            try require(exact.2.size.width > 0, "Downloaded native exact preview did not decode")
        }
        let cachedImages = try FileManager.default.contentsOfDirectory(atPath: environment["SFL_PREVIEW_CACHE_DIR"]!)
        try require(cachedImages.count == 3, "Only requested images should be downloaded")
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
        model.query = "sflnativefixture"
        model.provider = "org.scientificfigurelibrary.local"
        try await model.search()
        guard let candidate = model.result["candidates"].array.first else { throw LocalError(message: "Native search did not return the published reference") }
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
        view.layoutSubtreeIfNeeded()
        if let image = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: image)
            try image.representation(using: .png, properties: [:])?.write(to: root.appendingPathComponent("native-window.png"))
        }
        let report = object(["status": text("passed"), "nativeWindow": .bool(true), "privateRuntime": .bool(true), "syntheticUserActions": .bool(true), "flows": .array(["downloadedThumbnails", "downloadedExactPreviews", "onDemandCache", "binding", "upload", "import", "publish", "search", "imageDecode", "localConfirmation", "materialize", "replay"].map(text))])
        try Data(report.pretty.utf8).write(to: root.appendingPathComponent("native-smoke.json"))
        _ = await backend.shutdown()
        NSApplication.shared.terminate(nil)
    } catch {
        let report = object(["status": text("failed"), "error": text(error.localizedDescription)])
        try? Data(report.pretty.utf8).write(to: root.appendingPathComponent("native-smoke.json"))
        _ = await model.backend.shutdown()
        fputs("Native smoke failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}
