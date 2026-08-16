import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  compareCanonicalStrings,
} from "../src/canonical-json.ts";

test("RFC 8785 canonical JSON uses ECMAScript numbers and UTF-16 property ordering", () => {
  const value = {
    "\ufb33": 7,
    "😀": 6,
    "€": 5,
    "ö": 4,
    "\u0080": 3,
    "1": 2,
    "\r": 1,
    numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, -0],
  };
  assert.equal(
    canonicalJson(value),
    "{\"\\r\":1,\"1\":2,\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],\"\":3,\"ö\":4,\"€\":5,\"😀\":6,\"דּ\":7}",
  );
  assert.deepEqual(
    ["\ufb33", "😀", "€", "ö", "\u0080", "1", "\r"].sort(compareCanonicalStrings),
    ["\r", "1", "\u0080", "ö", "€", "😀", "\ufb33"],
  );
});

test("canonical JSON fails closed on values outside the I-JSON model", () => {
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/u);
  assert.throws(() => canonicalJson({ omitted: undefined }), /undefined/u);
  assert.throws(() => canonicalJson("\ud800"), /unpaired UTF-16 surrogate/u);
  assert.throws(() => canonicalJson(new Date()), /plain object/u);
  const sparse = new Array<unknown>(2);
  sparse[1] = 1;
  assert.throws(() => canonicalJson(sparse), /sparse element at index 0/u);
  const decorated = [1] as number[] & { note?: string };
  decorated.note = "not part of the JSON array model";
  assert.throws(() => canonicalJson(decorated), /unsupported enumerable properties/u);
});
