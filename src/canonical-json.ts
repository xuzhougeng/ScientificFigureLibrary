/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) serializer.
 *
 * Callers must provide JSON data. Undefined values, non-finite numbers, bigint,
 * functions, symbols, cyclic values, and unpaired UTF-16 surrogates are rejected
 * instead of being silently coerced by JSON.stringify.
 */

function assertUnicodeScalarString(value: string, label: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${label} contains an unpaired UTF-16 surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains an unpaired UTF-16 surrogate`);
    }
  }
}

function serialize(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicodeScalarString(value, "JSON string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON contains a non-finite number");
    }
    // ECMAScript number serialization is the representation required by JCS.
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error(`value of type ${typeof value} is not canonical JSON`);
  }
  if (stack.has(value)) throw new Error("canonical JSON contains a cycle");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const members: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(`canonical JSON array has a sparse element at index ${index}`);
        }
        members.push(serialize(value[index], stack));
      }
      const unexpectedKeys = Object.keys(value).filter(
        (key) => !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length,
      );
      if (unexpectedKeys.length) {
        throw new Error(
          `canonical JSON array has unsupported enumerable properties: ${unexpectedKeys.join(", ")}`,
        );
      }
      return `[${members.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical JSON value is not a plain object");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const members = keys.map((key) => {
      assertUnicodeScalarString(key, "JSON object key");
      if (record[key] === undefined) {
        throw new Error(`canonical JSON property ${JSON.stringify(key)} is undefined`);
      }
      return `${JSON.stringify(key)}:${serialize(record[key], stack)}`;
    });
    return `{${members.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

/** UTF-16 code-unit ordering used by RFC 8785; unlike localeCompare it is locale-independent. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJsonClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
