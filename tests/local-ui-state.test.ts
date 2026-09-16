import assert from "node:assert/strict";
import test from "node:test";
import {
  galleryMissingCount,
  pageHash,
  prefetchButtonLabel,
  readSavedPage,
} from "../app/local/ui-state.ts";

test("saved page prefers hash, then session storage, then gallery", () => {
  assert.equal(readSavedPage("#connect=ticket", "galleries"), "galleries");
  assert.equal(readSavedPage("#page=settings", "galleries"), "settings");
  assert.equal(readSavedPage("#connect=ticket&page=library", null), "library");
  assert.equal(readSavedPage("", "integrations"), "integrations");
  assert.equal(readSavedPage("", "unknown"), "discover");
  assert.equal(readSavedPage("", null), "discover");
});

test("page hash keeps the tab and drops the one-use connect ticket", () => {
  assert.equal(pageHash("#connect=ticket", "galleries"), "#page=galleries");
  assert.equal(pageHash("#page=settings", "discover"), "");
  assert.equal(pageHash("#page=settings", "library"), "#page=library");
});

test("partial cache failure still counts as missing and offers continue", () => {
  const gallery = { declared: 316, cached: 240, missing: 76 };
  assert.equal(galleryMissingCount(gallery), 76);
  assert.equal(prefetchButtonLabel(gallery), "继续缓存");
  assert.equal(prefetchButtonLabel({ declared: 316, cached: 0, missing: 316 }), "缓存图片");
  assert.equal(prefetchButtonLabel({ declared: 316, cached: 316, missing: 0 }), undefined);
  assert.equal(prefetchButtonLabel({ declared: 316, cached: 240 }, true), "继续缓存");
  assert.equal(galleryMissingCount({ declared: 316, cached: 240 }), 76);
  assert.equal(prefetchButtonLabel(undefined, true), "继续缓存");
});
