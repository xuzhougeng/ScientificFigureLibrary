import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_SOURCE_PAYLOAD_LIMITS } from "../src/provider-source-fetch.ts";
// @ts-expect-error The publisher is a plain ESM script without type declarations.
import { CLIENT_PAYLOAD_LIMITS, assertWithinClientLimits } from "../scripts/publish-open-figure-feed.mjs";

const small = { catalogBytes: 100, previewArchiveBytes: 100, previewExpandedBytes: 200, previewFileBytes: 150, previewFiles: 3 };
const bytes = (count: number) => new Uint8Array(count);

test("publisher limits match the limits clients enforce", () => {
  assert.deepEqual({ ...CLIENT_PAYLOAD_LIMITS }, { ...PROVIDER_SOURCE_PAYLOAD_LIMITS });
});

test("publisher accepts a feed inside the client limits", () => {
  assert.doesNotThrow(() => assertWithinClientLimits({
    catalogBytes: bytes(100), previewsBytes: bytes(100), previewFiles: { "previews/a/preview.png": bytes(150) },
  }, small));
});

test("publisher refuses a previews archive clients would reject and names the largest previews", () => {
  assert.throws(() => assertWithinClientLimits({
    catalogBytes: bytes(10),
    previewsBytes: bytes(101),
    previewFiles: { "previews/big/preview.png": bytes(90), "previews/small/preview.png": bytes(5) },
  }, small), (error: Error) => {
    assert.match(error.message, /module-previews\.zip is .* clients accept at most/u);
    assert.match(error.message, /Largest previews: previews\/big\/preview\.png/u);
    return true;
  });
});

test("publisher refuses oversized catalogs, expansion, file counts and single files", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ catalogBytes: bytes(101), previewsBytes: bytes(1), previewFiles: {} }, /catalog is/u],
    [{ catalogBytes: bytes(1), previewsBytes: bytes(1), previewFiles: { a: bytes(120), b: bytes(120) } }, /previews expand to/u],
    [{ catalogBytes: bytes(1), previewsBytes: bytes(1), previewFiles: { a: bytes(1), b: bytes(1), c: bytes(1), d: bytes(1) } }, /contain 4 files/u],
    [{ catalogBytes: bytes(1), previewsBytes: bytes(1), previewFiles: { a: bytes(151) } }, /a is .* per file/u],
  ];
  for (const [input, pattern] of cases) assert.throws(() => assertWithinClientLimits(input, small), pattern);
});
