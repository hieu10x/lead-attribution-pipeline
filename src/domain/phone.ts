/**
 * Normalize a North American phone number to E.164 (+1XXXXXXXXXX).
 * Call platforms, AI screeners and CRMs all format numbers differently; this is the join key for leads.
 * Returns null when the input can't be confidently normalized (unknown stays unknown).
 */
export function normalizeUsPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  let national: string;
  if (digits.length === 10) national = digits;
  else if (digits.length === 11 && digits.startsWith("1")) national = digits.slice(1);
  else return null;
  // NANP: area code and exchange can't start with 0 or 1
  if (/^[01]/.test(national) || /^[01]/.test(national.slice(3))) return null;
  return `+1${national}`;
}
