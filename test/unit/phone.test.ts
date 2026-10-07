import { describe, expect, it } from "vitest";
import { normalizeUsPhone } from "../../src/domain/phone";

describe("normalizeUsPhone", () => {
  it.each([
    ["(512) 555-0134", "+15125550134"],
    ["512-555-0134", "+15125550134"],
    ["5125550134", "+15125550134"],
    ["+1 512 555 0134", "+15125550134"],
    ["1-512-555-0134", "+15125550134"],
    ["+1 (512) 555-0134 ", "+15125550134"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeUsPhone(input)).toBe(expected);
  });

  it.each([
    [null],
    [""],
    ["555-0134"], // too short
    ["+44 20 7946 0958"], // not North American
    ["(012) 555-0134"], // invalid area code
    ["(512) 155-0134"], // invalid exchange
  ])("returns null for %s", (input) => {
    expect(normalizeUsPhone(input)).toBeNull();
  });
});
