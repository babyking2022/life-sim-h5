import { describe, expect, it } from "vitest";
import {
  isPlainObject,
  readArray,
  readBoolean,
  readChecksum,
  readEnum,
  readExactObject,
  readInt,
  readLiteral,
  readNullableString,
  readObject,
  readString,
  readStringArray
} from "../src/schema";
import { codeOf } from "./helpers";

describe("P2-A schema primitives", () => {
  it("detects plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });

  it("reads objects and rejects wrong shapes", () => {
    expect(readObject({ a: 1 }, "p")).toEqual({ a: 1 });
    expect(codeOf(() => readObject([], "p"))).toBe("E_P2A_TYPE");
    expect(codeOf(() => readObject(null, "p"))).toBe("E_P2A_TYPE");
  });

  it("enforces exact keys", () => {
    expect(readExactObject({ a: 1, b: 2 }, "p", ["a", "b"])).toEqual({ a: 1, b: 2 });
    expect(codeOf(() => readExactObject({ a: 1 }, "p", ["a", "b"]))).toBe("E_P2A_MISSING_KEY");
    expect(codeOf(() => readExactObject({ a: 1, c: 3 }, "p", ["a"]))).toBe("E_P2A_UNKNOWN_KEY");
  });

  it("validates strings, nullables and patterns", () => {
    expect(readString("abc", "p")).toBe("abc");
    expect(codeOf(() => readString(1, "p"))).toBe("E_P2A_TYPE");
    expect(codeOf(() => readString("abc", "p", { pattern: /^\d+$/ }))).toBe("E_P2A_PATTERN");
    expect(codeOf(() => readString("a", "p", { min: 2 }))).toBe("E_P2A_RANGE");
    expect(codeOf(() => readString("abc", "p", { max: 2 }))).toBe("E_P2A_RANGE");
    expect(readNullableString(null, "p")).toBeNull();
    expect(readNullableString("x", "p")).toBe("x");
    expect(codeOf(() => readNullableString(5, "p"))).toBe("E_P2A_TYPE");
  });

  it("validates integers and ranges", () => {
    expect(readInt(5, "p", 0, 10)).toBe(5);
    expect(codeOf(() => readInt(5.5, "p", 0, 10))).toBe("E_P2A_TYPE");
    expect(codeOf(() => readInt("5", "p", 0, 10))).toBe("E_P2A_TYPE");
    expect(codeOf(() => readInt(2 ** 53, "p", 0, 2 ** 60))).toBe("E_P2A_RANGE");
    expect(codeOf(() => readInt(-1, "p", 0, 10))).toBe("E_P2A_RANGE");
    expect(codeOf(() => readInt(11, "p", 0, 10))).toBe("E_P2A_RANGE");
  });

  it("validates booleans", () => {
    expect(readBoolean(true, "p")).toBe(true);
    expect(readBoolean(false, "p")).toBe(false);
    expect(codeOf(() => readBoolean(1, "p"))).toBe("E_P2A_TYPE");
  });

  it("validates arrays and string arrays", () => {
    expect(readArray([], "p", 0, 2)).toEqual([]);
    expect(codeOf(() => readArray({}, "p", 0, 2))).toBe("E_P2A_TYPE");
    expect(codeOf(() => readArray([], "p", 1, 2))).toBe("E_P2A_RANGE");
    expect(codeOf(() => readArray([1, 2, 3], "p", 0, 2))).toBe("E_P2A_RANGE");
    expect(readStringArray(["a", "b"], "p", 0, 2)).toEqual(["a", "b"]);
    expect(codeOf(() => readStringArray([1], "p", 0, 2))).toBe("E_P2A_TYPE");
    expect(codeOf(() => readStringArray([], "p", 1, 2))).toBe("E_P2A_RANGE");
  });

  it("validates enums and literals", () => {
    expect(readEnum("a", "p", ["a", "b"] as const)).toBe("a");
    expect(codeOf(() => readEnum("c", "p", ["a", "b"] as const))).toBe("E_P2A_ENUM");
    expect(codeOf(() => readEnum(1, "p", ["a"] as const))).toBe("E_P2A_TYPE");
    expect(readLiteral("p2a-1", "p", "p2a-1")).toBe("p2a-1");
    expect(codeOf(() => readLiteral("p2a-2", "p", "p2a-1"))).toBe("E_P2A_SCHEMA_VERSION");
    expect(codeOf(() => readLiteral(1, "p", "p2a-1"))).toBe("E_P2A_TYPE");
  });

  it("validates checksums", () => {
    expect(readChecksum("a".repeat(64), "p")).toBe("a".repeat(64));
    expect(codeOf(() => readChecksum("zz", "p"))).toBe("E_P2A_PATTERN");
  });
});
