import { describe, expect, it } from "vitest";
import { normalizeUsPhone } from "../../src/domain/phone";
import { messyPhone } from "../../simulator/phones";
import { createRng } from "../../simulator/random";
import { generateWorld } from "../../simulator/world";

describe("messyPhone", () => {
  it("preserves phone numbers", () => {
    const rng = createRng(42);
    const e164 = "+15125550134";
    // Each call picks a random format; 100 calls cover all 7 (the seed makes that hold every run).
    for (let i = 0; i < 100; i++) {
      const messy = messyPhone(e164, rng);
      expect(normalizeUsPhone(messy), `round trip of "${messy}"`).toEqual(e164);
    }
  });

  // A round trip alone can't tell "formatted" from "returned unchanged" (+1… normalizes to itself),
  // so check that every format is actually produced, and nothing outside the known formats.
  it("produces every format, and only known formats", () => {
    const formats: Record<string, RegExp> = {
      "(512) 555-0134": /^\(\d{3}\) \d{3}-\d{4}$/,
      "512-555-0134": /^\d{3}-\d{3}-\d{4}$/,
      "512.555.0134": /^\d{3}\.\d{3}\.\d{4}$/,
      "5125550134": /^\d{10}$/,
      "+1 512-555-0134": /^\+1 \d{3}-\d{3}-\d{4}$/,
      "1 (512) 555-0134": /^1 \(\d{3}\) \d{3}-\d{4}$/,
      "+15125550134": /^\+1\d{10}$/,
    };
    const seen = new Set<string>();
    const rng = createRng(1);

    // ~170 calls: enough that each of the 7 formats is practically certain to come up.
    for (const call of generateWorld({ days: 10 }).calls) {
      const messy = messyPhone(call.callerPhone, rng);
      const matching = Object.keys(formats).filter((name) => formats[name]!.test(messy));
      expect(matching, `"${messy}" should match exactly one known format`).toHaveLength(1);
      seen.add(matching[0]!);
    }

    expect([...seen].sort()).toEqual(Object.keys(formats).sort());
  });
});
