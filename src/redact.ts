/**
 * Span merging, placeholder substitution and local re-hydration.
 * Pure functions, no I/O — the placeholder map never leaves this module's caller.
 */
import { detectWithRules, type EntityType, type Span } from "./detectors";

export interface Redaction {
  /** Text with every span replaced by a placeholder such as [PERSON_1]. */
  text: string;
  /** placeholder -> original value. Kept in memory on the device only. */
  map: Map<string, string>;
  /** Spans actually applied, sorted, non-overlapping. */
  spans: Span[];
}

const PLACEHOLDER = /\[([A-Z]+)_(\d+)\]/g;

/** Locate every occurrence of the strings a model reported, as spans. */
export function spansFromStrings(
  text: string,
  found: Array<{ text: string; type: EntityType }>,
  source: Span["source"] = "model",
): Span[] {
  const spans: Span[] = [];
  for (const item of found) {
    const needle = item.text.trim();
    // Ignore empty/very short strings: they over-match and are usually model noise.
    if (needle.length < 2) continue;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      spans.push({ start: idx, end: idx + needle.length, type: item.type, source });
      from = idx + needle.length;
    }
  }
  return spans;
}

/**
 * Resolve overlaps: manual > rule > model, then longer span wins.
 * Returns sorted, non-overlapping spans.
 */
export function mergeSpans(spans: Span[]): Span[] {
  const rank = { manual: 0, rule: 1, model: 2 } as const;
  const ordered = [...spans]
    .filter((s) => s.end > s.start)
    .sort(
      (a, b) =>
        rank[a.source] - rank[b.source] || b.end - b.start - (a.end - a.start) || a.start - b.start,
    );
  const kept: Span[] = [];
  for (const s of ordered) {
    if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Replace spans with stable placeholders; the same value always gets the same placeholder. */
export function redact(text: string, spans: Span[]): Redaction {
  const merged = mergeSpans(spans);
  const map = new Map<string, string>();
  const byValue = new Map<string, string>();
  const counters = new Map<EntityType, number>();
  let out = "";
  let cursor = 0;
  for (const s of merged) {
    const value = text.slice(s.start, s.end);
    const key = `${s.type}:${value.toLowerCase().replace(/\s+/g, " ")}`;
    let placeholder = byValue.get(key);
    if (!placeholder) {
      const n = (counters.get(s.type) ?? 0) + 1;
      counters.set(s.type, n);
      placeholder = `[${s.type}_${n}]`;
      byValue.set(key, placeholder);
      map.set(placeholder, value);
    }
    out += text.slice(cursor, s.start) + placeholder;
    cursor = s.end;
  }
  out += text.slice(cursor);
  return { text: out, map, spans: merged };
}

/** Put the original values back into a model answer. Runs locally. */
export function rehydrate(text: string, map: Map<string, string>): string {
  return text.replace(PLACEHOLDER, (token) => map.get(token) ?? token);
}

/**
 * Last-line guard run on the exact payload before it leaves the device.
 * Returns the hard identifiers still present (empty array = safe to send).
 */
export function findLeaks(redactedText: string): Array<{ type: EntityType; value: string }> {
  return detectWithRules(redactedText).map((s) => ({
    type: s.type,
    value: redactedText.slice(s.start, s.end),
  }));
}

/** Split long input into chunks that fit the on-device context, on paragraph/sentence edges. */
export function chunk(text: string, max = 2500): Array<{ offset: number; text: string }> {
  const chunks: Array<{ offset: number; text: string }> = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + max, text.length);
    if (end < text.length) {
      const window = text.slice(offset, end);
      const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "));
      if (cut > max / 2) end = offset + cut + 1;
    }
    chunks.push({ offset, text: text.slice(offset, end) });
    offset = end;
  }
  return chunks;
}
