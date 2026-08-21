/**
 * Strict Semantic Versioning 2.0.0 grammar.
 *
 * Numeric core and prerelease identifiers reject leading zeroes, prerelease
 * and build identifiers are non-empty, and build metadata remains part of the
 * immutable public release identity.
 */
export const STRICT_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isStrictSemVer(value: unknown): value is string {
  return typeof value === "string" && STRICT_SEMVER.test(value);
}
