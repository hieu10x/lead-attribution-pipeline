import type { Rng } from "./random.ts";

/**
 * Writes an E.164 number (+15125550134) the way a random real-world system might:
 *   (512) 555-0134 · 512-555-0134 · 512.555.0134 · 5125550134 · +1 512-555-0134 · 1 (512) 555-0134 · +15125550134
 * The pipeline must normalize all of them back to the same E.164 number (src/domain/phone.ts).
 *
 */
export function messyPhone(e164: string, rng: Rng): string {
  const messifier = (s: string) => s.replace(/\+1(\d{3})(\d{3})(\d{4})/, rng.pick([
    '($1) $2-$3',
    '$1-$2-$3',
    '$1.$2.$3',
    '$1$2$3',
    '+1 $1-$2-$3',
    '1 ($1) $2-$3',
    '+1$1$2$3',
  ]));
  return messifier(e164);
}
