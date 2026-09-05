import { JSDOM } from "jsdom";

// Use a browser-compatible parser for the DOMPurify security tests. Scripts and
// resource loading remain disabled. jsdom does not implement dialog interaction.
export function createTestWindow() {
  const window = new JSDOM("<!doctype html><html><body></body></html>").window;
  const prototype = window.HTMLDialogElement.prototype;
  prototype.showModal ??= function () { this.setAttribute("open", ""); };
  prototype.close ??= function () {
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
  return window;
}
