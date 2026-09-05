import MarkdownIt from "markdown-it";
import createDOMPurify, { type WindowLike } from "dompurify";

const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
// Reference images must go through SFL's verified preview protocol, never through
// documentation. Render the alt text, not an <img> (even before sanitization).
parser.renderer.rules.image = (tokens, index) => parser.utils.escapeHtml(tokens[index]?.content ?? "");

export function safeDocumentationUrl(value: string): string | undefined {
  if (/\s|[\u0000-\u001f\u007f]/u.test(value) || !/^https?:\/\//iu.test(value)) return;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

export function renderMarkdown(
  document: Document,
  value: string,
  openLink?: (url: string) => Promise<void>,
): HTMLDivElement {
  const block = document.createElement("div");
  block.className = "markdown-body";
  if (!document.defaultView) {
    block.textContent = value;
    return block;
  }
  const purifier = createDOMPurify(document.defaultView as unknown as WindowLike);
  if (!purifier.isSupported) {
    block.textContent = value;
    return block;
  }
  // The only HTML parsed into the detail comes from the sanitizer, never the
  // user or Provider source directly. Raw Markdown HTML is disabled above.
  const safeHtml = purifier.sanitize(parser.render(value), {
    ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "s", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "hr", "a"],
    ALLOWED_ATTR: ["href", "title", "start"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_TRUSTED_TYPE: false,
  });
  const template = document.createElement("template");
  template.innerHTML = safeHtml;
  block.append(template.content);
  for (const anchor of Array.from(block.querySelectorAll<HTMLAnchorElement>("a"))) {
    const url = safeDocumentationUrl(anchor.getAttribute("href") ?? "");
    if (!url) {
      anchor.replaceWith(document.createTextNode(anchor.textContent ?? ""));
      continue;
    }
    anchor.href = url;
    anchor.title = url;
    // Links are explicit Host requests, never iframe navigation or fetches.
    let unavailable = !openLink;
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const fallback = () => {
        unavailable = true;
        anchor.textContent = `${anchor.textContent ?? "链接"}（请复制地址：${url}）`;
        anchor.removeAttribute("href");
      };
      if (unavailable) { if (anchor.hasAttribute("href")) fallback(); return; }
      void openLink!(url).catch(fallback);
    });
  }
  for (const table of Array.from(block.querySelectorAll("table"))) {
    const scroll = document.createElement("div");
    scroll.className = "markdown-table-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", "表格，可横向滚动");
    table.replaceWith(scroll);
    scroll.append(table);
  }
  return block;
}
