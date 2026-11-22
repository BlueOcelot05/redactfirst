import { describe, expect, it } from "vitest";
import { buildTaskPrompt, parseEntities } from "../src/ai-pure";
import { detectWithRules, isValidCard, isValidCnp, isValidIban } from "../src/detectors";
import { chunk, findLeaks, mergeSpans, redact, rehydrate, spansFromStrings } from "../src/redact";

const CNP = "1800101050014"; // synthetic, valid checksum
const IBAN = "RO49 AAAA 1B31 0075 9384 0000";

describe("validators", () => {
  it("accepts a valid CNP and rejects a wrong control digit / bad date", () => {
    expect(isValidCnp(CNP)).toBe(true);
    expect(isValidCnp("1800101050015")).toBe(false);
    expect(isValidCnp("1801301050014")).toBe(false); // month 13
    expect(isValidCnp("0800101050014")).toBe(false);
    expect(isValidCnp("123")).toBe(false);
  });
  it("validates IBAN with mod-97", () => {
    expect(isValidIban(IBAN)).toBe(true);
    expect(isValidIban("RO49 AAAA 1B31 0075 9384 0001")).toBe(false);
  });
  it("validates cards with Luhn", () => {
    expect(isValidCard("4111 1111 1111 1111")).toBe(true);
    expect(isValidCard("4111 1111 1111 1112")).toBe(false);
  });
});

describe("rule detectors", () => {
  const text = `Mail a.b@example.com, tel 0712 345 678 or +40712345678, CNP ${CNP}, IBAN ${IBAN}.`;
  const types = detectWithRules(text).map((s) => s.type);
  it("finds each hard identifier", () => {
    for (const t of ["EMAIL", "PHONE", "CNP", "IBAN"]) expect(types).toContain(t);
  });
  it("does not flag ordinary numbers", () => {
    expect(detectWithRules("Invoice 2026 for 1500 lei, order 1234567890123.")).toEqual([]);
  });
});

describe("redaction", () => {
  const text = `Ana Pop wrote. Call Ana Pop on 0712 345 678. CNP ${CNP}.`;
  const spans = [...detectWithRules(text), ...spansFromStrings(text, [{ text: "Ana Pop", type: "PERSON" }])];
  const r = redact(text, spans);

  it("uses one stable placeholder per value", () => {
    expect(r.text).toBe("[PERSON_1] wrote. Call [PERSON_1] on [PHONE_1]. CNP [CNP_1].");
    expect(r.map.get("[PERSON_1]")).toBe("Ana Pop");
  });
  it("leaves no hard identifiers behind", () => {
    expect(findLeaks(r.text)).toEqual([]);
    expect(findLeaks(text).length).toBeGreaterThan(0);
  });
  it("rehydrates a model answer locally and keeps unknown tokens", () => {
    expect(rehydrate("Dear [PERSON_1], we will call [PHONE_1]. [PERSON_9]", r.map)).toBe(
      "Dear Ana Pop, we will call 0712 345 678. [PERSON_9]",
    );
  });
  it("prefers rule spans over overlapping model spans", () => {
    const merged = mergeSpans([
      { start: 0, end: 20, type: "OTHER", source: "model" },
      { start: 5, end: 10, type: "CNP", source: "rule" },
    ]);
    expect(merged).toEqual([{ start: 5, end: 10, type: "CNP", source: "rule" }]);
  });
  it("ignores model strings that are too short or absent", () => {
    expect(spansFromStrings("abc", [{ text: "a", type: "PERSON" }, { text: "zzz", type: "PERSON" }])).toEqual([]);
  });
  it("chunks without losing text", () => {
    const long = "Sentence one. ".repeat(600);
    const parts = chunk(long, 1000);
    expect(parts.map((p) => p.text).join("")).toBe(long);
    expect(Math.max(...parts.map((p) => p.text.length))).toBeLessThanOrEqual(1000);
  });
});

describe("model I/O", () => {
  it("parses fenced / noisy JSON and normalises unknown types", () => {
    const raw = 'Sure:\n```json\n{"entities":[{"text":"Ana","type":"person"},{"text":"x","type":"WEIRD"},{"text":""}]}\n```';
    expect(parseEntities(raw)).toEqual([
      { text: "Ana", type: "PERSON" },
      { text: "x", type: "OTHER" },
    ]);
  });
  it("returns nothing for garbage", () => {
    expect(parseEntities("no json here")).toEqual([]);
    expect(parseEntities('{"entities":"nope"}')).toEqual([]);
  });
  it("leak guard also catches identifiers typed into a custom instruction", () => {
    const payload = buildTaskPrompt("custom", "[PERSON_1] wrote.", `Email the answer to x@example.com`);
    expect(findLeaks(payload).map((l) => l.type)).toEqual(["EMAIL"]);
  });
});
