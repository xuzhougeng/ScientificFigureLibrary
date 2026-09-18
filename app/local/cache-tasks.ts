import { api } from "./api.ts";
import type { GalleryCacheTask } from "../../src/local/gallery-cache.ts";

let watching = false;
const states = new Map<string, string>();
let onCompleted: (() => Promise<void>) | undefined;
const dismissed = new Set<string>();
const panel = document.createElement("details");
panel.className = "cache-task-panel"; panel.open = true; panel.hidden = true;
const heading = document.createElement("summary"); heading.textContent = "缓存任务";
const list = document.createElement("div"); list.className = "cache-task-list";
const note = document.createElement("p"); note.textContent = "可继续浏览或刷新页面；退出本地服务会中断任务。";
panel.append(heading, note, list);
const rows = new Map<string, HTMLElement>();
function render(tasks: GalleryCacheTask[]) {
  const visible = tasks.filter(task => !dismissed.has(task.id));
  panel.hidden = visible.length === 0;
  heading.textContent = `缓存任务 · ${tasks.filter(task => task.state === "running").length} 个进行中`;
  for (const [id, row] of rows) if (!visible.some(task => task.id === id)) { row.remove(); rows.delete(id); }
  for (const task of visible) {
    let row = rows.get(task.id);
    if (!row) { row = document.createElement("article"); rows.set(task.id, row); list.append(row); }
    const title = document.createElement("strong");
    title.textContent = `${task.providerId === "org.figureya.module" ? "FigureYa" : "Open Figure Modules"} · ${task.mode === "images" ? "缓存图片" : task.mode === "code" ? "缓存代码" : "更新缓存"}`;
    const progress = document.createElement("progress"); progress.max = Math.max(task.total, 1); progress.value = task.processed;
    progress.setAttribute("aria-label", title.textContent);
    const status = document.createElement("p");
    status.textContent = `${task.state === "running" ? "进行中" : task.state === "failed" ? "已中断" : task.failures.length ? "完成，有失败项" : "已完成"} · ${task.processed}/${task.total} · 失败 ${task.failures.length}`;
    const current = document.createElement("p"); current.textContent = task.error ?? task.currentItem;
    row.replaceChildren(title, progress, status, current);
    if (task.state !== "running") {
      if (task.failures.length) { const errors = document.createElement("pre"); errors.textContent = task.failures.map(item => `${item.item}：${item.message}`).join("\n"); row.append(errors); }
      const close = document.createElement("button"); close.type = "button"; close.className = "quiet"; close.textContent = "收起此任务";
      close.onclick = () => { dismissed.add(task.id); render(tasks); }; row.append(close);
    }
  }
}
export async function refreshCacheTasks() {
  const result = await api<{ tasks: GalleryCacheTask[] }>("gallery-cache/tasks");
  render(result.tasks);
  const completed = result.tasks.some(task => task.state !== "running" && states.get(task.id) !== task.state);
  for (const task of result.tasks) states.set(task.id, task.state);
  if (completed) await onCompleted?.();
}
export function watchCacheTasks(completed?: () => Promise<void>) {
  onCompleted = completed;
  if (watching) return; watching = true; document.body.append(panel);
  const poll = async () => {
    try { await refreshCacheTasks(); note.textContent = "可继续浏览或刷新页面；退出本地服务会中断任务。"; }
    catch { note.textContent = "暂时无法更新任务进度，正在尝试重新连接…"; }
    setTimeout(() => void poll(), 1500);
  };
  void poll();
}
