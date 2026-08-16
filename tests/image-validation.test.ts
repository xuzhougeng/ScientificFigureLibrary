import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertMcpImageBytes } from "../src/image-validation.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const ONE_PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

function expectValid(bytes: Uint8Array, mimeType: string, extension: string) {
  assert.doesNotThrow(() => assertMcpImageBytes({ bytes, mimeType, extension }));
}

function expectInvalid(bytes: Uint8Array, mimeType: string, extension: string) {
  assert.throws(() => assertMcpImageBytes({ bytes, mimeType, extension }), /valid .* structure/u);
}

test("MCP image validation accepts structurally complete PNG, GIF, and bundled WebP", async () => {
  expectValid(ONE_PIXEL_PNG, "image/png", ".png");
  expectValid(ONE_PIXEL_GIF, "image/gif", ".gif");
  const webp = await fs.readFile(
    path.resolve(import.meta.dirname, "..", "assets", "thumbs", "FigureYa59volcanoV2.webp"),
  );
  expectValid(webp, "image/webp", ".webp");
});

test("MCP image validation rejects signature-only and header-only payloads", () => {
  expectInvalid(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", ".png");
  expectInvalid(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg", ".jpg");
  expectInvalid(Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000", "binary"), "image/gif", ".gif");
  expectInvalid(
    new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]),
    "image/webp",
    ".webp",
  );
});

test("JPEG validation permits multiple progressive scans but still requires entropy data", () => {
  const progressiveMarkerSequence = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3f, 0x00, 0x02,
    0xff, 0xd9,
  ]);
  expectValid(progressiveMarkerSequence, "image/jpeg", ".jpg");
  const withoutEntropy = progressiveMarkerSequence.filter((byte, index) => index !== 26 && index !== 38);
  expectInvalid(withoutEntropy, "image/jpeg", ".jpg");
});

test("MCP image validation rejects MIME and extension disagreement", () => {
  assert.throws(
    () => assertMcpImageBytes({ bytes: ONE_PIXEL_PNG, mimeType: "image/png", extension: ".jpg" }),
    /does not match/u,
  );
});
