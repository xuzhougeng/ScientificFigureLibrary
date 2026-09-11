type ToolCall = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Figure = { id: string; title: string; revision: number; directory: string; label: { figure: number; panel: string } | null; artworkLabelPending: boolean };

export function mountProjectFigures(document: Document, parent: HTMLElement, call: ToolCall, prepare: (figure: Figure, locale: string) => Promise<void>) {
  const section = document.createElement("details"); section.className = "plotting-tips";
  const summary = document.createElement("summary"); summary.textContent = "我的项目图 · 归档与投稿包";
  const hint = document.createElement("p"); hint.textContent = "这里显示已绑定工作区的项目图，可用自然语言规划 Figure 1 A–H、继续子图、改名或交换编号。每幅图分别保存数据、脚本和修订；已规划不代表已生成。";
  const load = document.createElement("button"); load.type = "button"; load.textContent = "刷新项目图";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const list = document.createElement("div");
  section.append(summary, hint, load, status, list); parent.append(section);
  load.addEventListener("click", async () => {
    load.disabled = true; status.textContent = "正在读取已绑定工作区…";
    try {
      const result = await call("figure_library_list_project_figures", {});
      const figures = result.figures as Figure[]; list.replaceChildren();
      for (const figure of figures) {
        const row = document.createElement("p");
        row.append(document.createTextNode(`${figure.label ? `Figure ${figure.label.figure}${figure.label.panel} · ` : ""}${figure.title} · ${figure.revision ? `修订 ${figure.revision}` : "计划中，未归档"}${figure.artworkLabelPending ? " · 图内编号待更新" : ""} `));
        const button = document.createElement("button"); button.type = "button"; button.textContent = "导出投稿包"; button.disabled = !figure.revision;
        button.addEventListener("click", () => openSubmissionDialog(document, figure, call, prepare, button));
        row.append(button); list.append(row);
      }
      status.textContent = figures.length ? `共 ${figures.length} 幅项目图` : "暂无项目图。可在对话中说“先规划 Figure 1 的 A、B 两幅子图”。";
    } catch (error) { status.textContent = String(error); }
    finally { load.disabled = false; }
  });
  return section;
}

export function openSubmissionDialog(document: Document, figure: Figure, call: ToolCall, prepare: (figure: Figure, locale: string) => Promise<void>, opener: HTMLButtonElement) {
  const dialog = document.createElement("dialog"); dialog.className = "submission-dialog";
  dialog.setAttribute("aria-label", `导出 ${figure.title} 投稿包`);
  const title = document.createElement("h2"); title.textContent = `导出投稿包 · ${figure.title}`;
  const languageLabel = document.createElement("label"); languageLabel.textContent = "导出语言 ";
  const language = document.createElement("select");
  for (const [value, text] of [["zh-CN", "中文版"], ["en", "English version"]]) {
    const option = document.createElement("option"); option.value = value!; option.textContent = text!; language.append(option);
  }
  languageLabel.append(language);
  const scope = document.createElement("p");
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const inventory = document.createElement("pre"); inventory.className = "submission-inventory";
  const preview = document.createElement("button"); preview.type = "button"; preview.textContent = "检查并预览文件清单";
  const preparation = document.createElement("button"); preparation.type = "button"; preparation.textContent = "让 Agent 准备所选语言";
  const submit = document.createElement("button"); submit.type = "button"; submit.textContent = "导出"; submit.disabled = true;
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "取消";
  let planDigest: string | undefined; let busy = false; let generation = 0;
  const updateScope = () => {
    generation++; planDigest = undefined; submit.disabled = true; inventory.textContent = "";
    scope.textContent = language.value === "en"
      ? "英文版：生成的说明、代码注释及图中展示文字使用英文。原始数据、原始作者脚本、许可证、引用和真实标识保持原貌。需要翻译的图由 Agent 重绘并验证。"
      : "中文版：README 和配套说明使用中文，生成/适配代码使用英文注释与标识。图中文字保留当前语言。";
    scope.textContent += " 导出副本存入工作区 exports，不覆盖工作文件；不会自动上传或提交期刊。";
  };
  updateScope(); language.addEventListener("change", updateScope);
  const setBusy = (value: boolean) => { busy = value; language.disabled = value; preview.disabled = value; preparation.disabled = value; submit.disabled = value || !planDigest; };
  preview.addEventListener("click", async () => {
    const request = ++generation; planDigest = undefined; setBusy(true); status.textContent = "正在检查归档与所选语言…";
    try {
      const plan = await call("figure_library_plan_submission_export", { figureId: figure.id, locale: language.value });
      if (!dialog.open || request !== generation) return;
      planDigest = plan.digest as string;
      inventory.textContent = `目标：${plan.destination}\n\n${(plan.files as Array<{ path: string; bytes: number }>).map((f) => `${f.path} (${f.bytes} bytes)`).join("\n")}\nmanifest.json（导出时记录时间、语言、来源修订及文件校验值）\n\n保留原貌：${(plan.exceptions as string[]).join("; ")}`;
      status.textContent = "检查通过。请审阅文件清单，然后点击“导出”。";
    } catch (error) { if (dialog.open) status.textContent = String(error); }
    finally { setBusy(false); }
  });
  preparation.addEventListener("click", async () => {
    setBusy(true);
    try { await prepare(figure, language.value); status.textContent = "已将语言准备请求交给 Agent。完成后重新检查文件清单。"; }
    catch (error) { status.textContent = String(error); }
    finally { setBusy(false); }
  });
  submit.addEventListener("click", async () => {
    if (busy || !planDigest) return;
    setBusy(true); cancel.disabled = true; status.textContent = "正在打包…";
    try {
      const result = await call("figure_library_apply_submission_export", { planDigest });
      status.textContent = `已导出：${result.path}`; planDigest = undefined; cancel.textContent = "关闭";
    } catch (error) { status.textContent = String(error); planDigest = undefined; }
    finally { setBusy(false); cancel.disabled = false; }
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (cancel.disabled) event.preventDefault(); });
  dialog.addEventListener("close", () => { generation++; dialog.remove(); opener.focus(); });
  dialog.append(title, languageLabel, scope, preparation, preview, inventory, status, submit, cancel);
  document.body.append(dialog); dialog.showModal(); return dialog;
}
