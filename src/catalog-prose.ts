export function looksStructuredMarkdown(value: string) {
  return /\n\s*\n/u.test(value) || /^(?:#{1,6}\s|[-*]\s|\d+\.\s|\|)/mu.test(value) || /```/u.test(value);
}

export function formatCatalogProse(value: string) {
  const text = value.replace(/\u00a0/gu, " ").trim();
  if (!text) return text;
  if (looksStructuredMarkdown(text)) return text;
  return reconstructCollapsedProse(text);
}

function reconstructCollapsedProse(text: string) {
  let value = text.replace(/^[a-z]\s+(?=场景)/u, "").replace(/\s+\d+$/u, "").trim();
  let code = "";
  const codeMatch = value.match(/\s+((?:[A-Za-z][\w.]*)\s*<-\s*function\b[\s\S]*)$/u);
  if (codeMatch) {
    code = codeMatch[1]!.replace(/\s+#\s*Lo$/u, "").trim();
    value = value.slice(0, codeMatch.index).trim();
  }
  const { intro, items } = splitParameterList(value);
  value = intro
    .replace(/(?<=[\u3400-\u9fff。！？；])\s+(?=场景[一二三四五六七八九十0-9]+[:：])/gu, "\n\n")
    .replace(/(?<=[\u3400-\u9fff。！？；])\s+(?=Scenario\s+\d+[:：])/gu, "\n\n")
    .replace(/(?<=[\u3400-\u9fff。！？])\s+(?=[A-Z])/gu, "\n\n")
    .replace(/\s+(From\s+https?:\/\/\S+)/gu, "\n\n$1")
    .replace(/(场景[一二三四五六七八九十0-9]+[:：])/gu, "\n\n- **$1** ")
    .replace(/(Scenario\s+\d+[:：])/gu, "\n\n- **$1** ")
    .replace(/\b(https?:\/\/[^\s)]+)/gu, "[$1]($1)")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const blocks = [value];
  if (items.length) {
    blocks.push(items.map((item) => `- \`${item.name}\`: ${item.description}`).join("\n"));
  }
  if (code) blocks.push(`\`\`\`r\n${code}\n\`\`\``);
  return blocks.filter(Boolean).join("\n\n");
}

function splitParameterList(value: string) {
  const itemRe = /(?:^|\s)#\s*([A-Za-z][\w.]*)\s*[:：]\s*/gu;
  const matches = [...value.matchAll(itemRe)];
  if (matches.length < 3) return { intro: value, items: [] as Array<{ name: string; description: string }> };
  const intro = value.slice(0, matches[0]!.index).replace(/\s+#\s*$/u, "").trim();
  const seen = new Set<string>();
  const items: Array<{ name: string; description: string }> = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const name = match[1]!;
    const key = name.toLowerCase();
    if (key === "parameters") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = match.index! + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : value.length;
    const description = value.slice(start, end).replace(/\s+#\s*$/u, "").trim();
    if (description) items.push({ name, description });
  }
  return { intro, items };
}
