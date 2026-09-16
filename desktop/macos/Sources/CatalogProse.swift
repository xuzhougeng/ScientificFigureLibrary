import Foundation

func looksStructuredMarkdown(_ value: String) -> Bool {
    value.contains("\n\n") || value.contains("```") || value.range(of: "^(?:#{1,6}\\s|[-*]\\s|\\d+\\.\\s|\\|)", options: .regularExpression) != nil
}

func formatCatalogProse(_ raw: String) -> String {
    let text = raw.replacingOccurrences(of: "\u{00a0}", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty || looksStructuredMarkdown(text) { return text }
    var value = text
    if let match = value.range(of: "^[a-z]\\s+(?=场景)", options: .regularExpression) { value.removeSubrange(match) }
    if let match = value.range(of: "\\s+\\d+$", options: .regularExpression) { value.removeSubrange(match) }
    var code = ""
    if let match = value.range(of: "\\s+((?:[A-Za-z][\\w.]*)\\s*<-\\s*function\\b[\\s\\S]*)$", options: .regularExpression) {
        code = String(value[match]).trimmingCharacters(in: .whitespacesAndNewlines)
        value = String(value[..<match.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    value = value.replacingOccurrences(of: "(?<=[\\u3400-\\u9fff。！？；])\\s+(?=场景[一二三四五六七八九十0-9]+[:：])", with: "\n\n", options: .regularExpression)
    value = value.replacingOccurrences(of: "(?<=[\\u3400-\\u9fff。！？；])\\s+(?=Scenario\\s+\\d+[:：])", with: "\n\n", options: .regularExpression)
    value = value.replacingOccurrences(of: "(?<=[\\u3400-\\u9fff。！？])\\s+(?=[A-Z])", with: "\n\n", options: .regularExpression)
    value = value.replacingOccurrences(of: "\\s+(From\\s+https?://\\S+)", with: "\n\n$1", options: .regularExpression)
    return [value.trimmingCharacters(in: .whitespacesAndNewlines), code.isEmpty ? nil : code].compactMap { $0 }.joined(separator: "\n\n")
}
