/**
 * Deterministic, 100% local detectors for "hard" identifiers.
 * These run without any model and are also used as the last-line guard
 * before anything is sent to the cloud.
 */

export type EntityType =
  | "PERSON"
  | "ADDRESS"
  | "HEALTH"
  | "ORG"
  | "DATE"
  | "ID"
  | "CNP"
  | "EMAIL"
  | "PHONE"
  | "IBAN"
  | "CARD"
  | "OTHER";

export interface Span {
  start: number;
  end: number;
  type: EntityType;
  /** Where the detection came from. */
  source: "rule" | "model" | "manual";
}

/** Romanian personal numeric code (CNP): 13 digits with a mod-11 control digit. */
export function isValidCnp(value: string): boolean {
  if (!/^[1-9]\d{12}$/.test(value)) return false;
  const month = Number(value.slice(3, 5));
  const day = Number(value.slice(5, 7));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const key = "279146358279";
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * Number(key[i]);
  const control = sum % 11 === 10 ? 1 : sum % 11;
  return control === Number(value[12]);
}

/** IBAN mod-97 check (ISO 13616). Input may contain spaces. */
export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Luhn check for payment card numbers. Input may contain spaces or dashes. */
export function isValidCard(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

interface Rule {
  type: EntityType;
  pattern: RegExp;
  validate?: (match: string) => boolean;
}

const RULES: Rule[] = [
  { type: "EMAIL", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { type: "IBAN", pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, validate: isValidIban },
  { type: "CNP", pattern: /(?<!\d)[1-9]\d{12}(?!\d)/g, validate: isValidCnp },
  { type: "CARD", pattern: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, validate: isValidCard },
  // Romanian phone numbers: +40 / 0040 / 0 prefix, mobile (7xx) and landline (2xx, 3xx).
  { type: "PHONE", pattern: /(?<![\dA-Za-z])(?:\+40|0040|0)[ .-]?[237]\d{2}(?:[ .-]?\d{3}){2}(?!\d)/g },
  // Generic international numbers written with a leading +.
  { type: "PHONE", pattern: /(?<![\dA-Za-z])\+\d{1,3}(?:[ .-]?\d{2,4}){2,4}(?!\d)/g },
];

/** Find all rule-based spans in `text`. Overlaps are resolved by the caller. */
export function detectWithRules(text: string): Span[] {
  const spans: Span[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      if (rule.validate && !rule.validate(m[0])) continue;
      spans.push({ start: m.index, end: m.index + m[0].length, type: rule.type, source: "rule" });
    }
  }
  return spans;
}
