import { describe, expect, test } from "bun:test";
import { previewOf, titleOf } from "../src/roster/preview";

describe("previewOf", () => {
  test("collapses a message to one line", () => {
    expect(previewOf("first\nsecond   third")).toBe("first second third");
  });

  test("strips control characters rather than rendering them", () => {
    // A terminal escape somebody put in a message must not follow it into a log. The escape byte
    // goes and the run collapses to a space; the printable tail it introduced is left alone, which
    // is what the existing regex already does.
    expect(previewOf(`before\u001b[31mafter`)).toBe("before [31mafter");
  });

  test("truncates to 200 code points with an ellipsis", () => {
    const preview = previewOf("a".repeat(500));
    expect(Array.from(preview)).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("counts code points, not UTF-16 units", () => {
    // 199 plain characters plus one astral character is 200 code points, and must survive whole.
    const text = `${"a".repeat(199)}\u{1f600}`;
    expect(previewOf(text)).toBe(text);
  });
});

describe("titleOf", () => {
  test("is shorter than a preview, because a roster row is not a transcript", () => {
    const title = titleOf("a".repeat(500));
    expect(Array.from(title)).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  test("leaves a short first message alone", () => {
    expect(titleOf("  What is our refund policy?  ")).toBe(
      "What is our refund policy?",
    );
  });
});
