import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { PROVIDER_SOURCE_PAYLOAD_LIMITS } from "../src/provider-source-fetch.ts";
// @ts-expect-error The publisher is a plain ESM script without type declarations.
import { CLIENT_PAYLOAD_LIMITS, assertWithinClientLimits, main } from "../scripts/publish-open-figure-feed.mjs";

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

/** A prepared output directory as `publish-prepare` leaves it, ready for `--mode sign`. */
async function preparedOutput(t: { after(fn: () => unknown): void }, archives: { thumbnails: Uint8Array; previews?: Uint8Array }) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-feed-sign-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const snapshot = path.join(output, "snapshots", "7");
  await fs.mkdir(snapshot, { recursive: true });
  await fs.writeFile(path.join(snapshot, "module-catalog.json"), "{}");
  await fs.writeFile(path.join(snapshot, "module-thumbnails.zip"), archives.thumbnails);
  if (archives.previews) await fs.writeFile(path.join(snapshot, "module-previews.zip"), archives.previews);
  await fs.writeFile(path.join(output, "payload.json"), JSON.stringify({
    sequence: 7,
    generatedAt: "2026-11-19T00:00:00.000Z",
    tombstones: [],
    authorizedNextKeys: [],
    ...(archives.previews ? {} : { bundledFrozen: true }),
  }));
  const previous = process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64;
  process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64 = randomBytes(32).toString("base64");
  t.after(() => {
    if (previous === undefined) delete process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64;
    else process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64 = previous;
  });
  const signedChannels = async () => {
    const present: string[] = [];
    for (const channel of ["current", "current-on-demand"]) {
      try {
        await fs.stat(path.join(output, channel, "source-manifest.json"));
        present.push(channel);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return present;
  };
  return { output, signedChannels, sign: () => main(["--mode", "sign", "--output", output, "--payload-commit", "c".repeat(40)]) };
}

const storedZip = (files: Record<string, Uint8Array>) => new Uint8Array(zipSync(files, { level: 0 }));

test("sign mode signs both channels when the archives on disk are inside the client limits", async (t) => {
  const prepared = await preparedOutput(t, {
    thumbnails: storedZip({ "thumbs/a.png": bytes(512) }),
    previews: storedZip({ "previews/a/preview.png": bytes(2048), "thumbs/a.png": bytes(512) }),
  });
  await prepared.sign();
  assert.deepEqual(await prepared.signedChannels(), ["current", "current-on-demand"]);
});

test("sign mode re-checks the bytes on disk and signs neither channel when an archive is oversized", async (t) => {
  // The bundled archive is just over 64 MiB while the payload does not mark that channel frozen,
  // as happens when the files to sign are not the ones the build step checked.
  const oversizedBundled = await preparedOutput(t, {
    thumbnails: storedZip({ "thumbs/a.png": bytes(512) }),
    previews: storedZip({ "previews/a/preview.png": bytes(CLIENT_PAYLOAD_LIMITS.previewArchiveBytes + 1024) }),
  });
  await assert.rejects(oversizedBundled.sign(), /module-previews\.zip is .* clients accept at most 64\.0 MiB/u);
  assert.deepEqual(await oversizedBundled.signedChannels(), [], "the on-demand channel is not signed on its own");

  const oversizedThumbnails = await preparedOutput(t, {
    thumbnails: storedZip({ "thumbs/a.png": bytes(CLIENT_PAYLOAD_LIMITS.previewArchiveBytes + 1024) }),
  });
  await assert.rejects(oversizedThumbnails.sign(), /module-thumbnails\.zip is .* clients accept at most 64\.0 MiB/u);
  assert.deepEqual(await oversizedThumbnails.signedChannels(), []);
});

test("sign mode signs only the on-demand channel when the bundled channel is frozen", async (t) => {
  const frozen = await preparedOutput(t, { thumbnails: storedZip({ "thumbs/a.png": bytes(512) }) });
  await frozen.sign();
  assert.deepEqual(await frozen.signedChannels(), ["current-on-demand"]);
});
