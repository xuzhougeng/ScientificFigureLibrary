import type { CustomTagEntry, CustomTagSnapshot } from "../../src/local/custom-tags.ts";
import { bindModalScrollLock } from "../view.ts";
export const LOCAL_TAG_PROVIDER = "org.scientificfigurelibrary.local";
type Identity = Pick<CustomTagEntry, "providerId" | "templateId">;
type Target = { resultSetId: string; candidateId: string } | { templateId: string };
export const splitCustomTags = (text: string) => text.split(/[,，\n]/u).map(tag => tag.trim()).filter(Boolean);

export function createCustomTagUI(document: Document, api: <T>(route: string, body?: unknown) => Promise<T>, onSaved: () => Promise<void>) {
  let state: CustomTagSnapshot = { libraryContext: "", entries: [], tags: [] };
  const widgets = new Map<HTMLElement, Identity>();
  function tagsFor(identity: Identity) { return state.entries.find(entry => entry.providerId === identity.providerId && entry.templateId === identity.templateId)?.tags ?? []; }
  function render() {
    for (const [widget, identity] of widgets) {
      if (!widget.isConnected) { widgets.delete(widget); continue; }
      const labels = widget.querySelector(".custom-tag-labels")!;
      labels.replaceChildren(...tagsFor(identity).map(tag => {
        const chip = document.createElement("span"); chip.className = "custom-tag-chip"; chip.textContent = tag; return chip;
      }));
    }
    for (const id of ["search-custom-tag", "library-custom-tag"]) {
      const select = document.getElementById(id) as HTMLSelectElement;
      const selected = select.value;
      const tags = [...state.tags];
      if (selected && !tags.includes(selected)) tags.push(selected);
      select.replaceChildren(...["", ...tags].map(tag => {
        const option = document.createElement("option"); option.value = tag; option.textContent = tag || "全部自定义标签"; return option;
      }));
      select.value = selected;
    }
  }
  async function refresh() { state = await api<CustomTagSnapshot>("custom-tags"); render(); }
  function widget(identity: Identity, target: Target, title: string) {
    for (const element of widgets.keys()) if (!element.isConnected) widgets.delete(element);
    const container = document.createElement("div"); container.className = "custom-tags";
    container.addEventListener("click", event => event.stopPropagation());
    const labels = document.createElement("div"); labels.className = "custom-tag-labels"; labels.setAttribute("aria-label", "自定义标签");
    for (const tag of tagsFor(identity)) { const chip = document.createElement("span"); chip.className = "custom-tag-chip"; chip.textContent = tag; labels.append(chip); }
    const button = document.createElement("button"); button.type = "button"; button.className = "quiet"; button.textContent = "编辑标签"; button.setAttribute("aria-label", `编辑 ${title} 的自定义标签`);
    button.onclick = () => { void edit(identity, target, title); };
    container.append(labels, button); widgets.set(container, identity); return container;
  }
  async function edit(identity: Identity, target: Target, title: string) {
    const dialog = document.createElement("dialog"); dialog.className = "local-dialog custom-tag-editor";
    const heading = document.createElement("h2"); heading.textContent = `自定义标签 · ${title}`;
    const label = document.createElement("label"); label.textContent = "标签（逗号分隔）";
    const input = document.createElement("input"); input.placeholder = "单细胞, 待使用"; label.append(input);
    const help = document.createElement("p"); help.textContent = "最多 20 个标签，每个最多 40 字符；清空后保存可移除全部个人标签。模板原有标签不变。";
    const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = "正在读取标签…";
    const save = document.createElement("button"); save.textContent = "保存标签"; save.disabled = true;
    const cancel = document.createElement("button"); cancel.textContent = "取消"; cancel.className = "quiet"; cancel.onclick = () => dialog.close();
    dialog.append(heading, label, help, status, save, cancel);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal(); bindModalScrollLock(document, dialog);
    let original: string[] = [], libraryContext = "";
    try {
      await refresh(); original = [...tagsFor(identity)]; libraryContext = state.libraryContext;
      input.value = original.join(", "); save.disabled = false; status.textContent = ""; input.focus();
    } catch (error) { status.textContent = String(error); }
    save.onclick = async () => {
      save.disabled = true;
      try {
        state = await api<CustomTagSnapshot>("custom-tags", { target, tags: splitCustomTags(input.value), expectedTags: original, libraryContext });
        render(); dialog.close(); await onSaved();
      } catch (error) { status.textContent = String(error); }
      finally { save.disabled = false; }
    };
  }
  return { refresh, tagsFor, widget };
}
