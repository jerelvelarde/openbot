import { describe, expect, test } from "bun:test";
import { previewOf, titleOf } from "../src/roster/preview";

/*
 * Written as escapes throughout, because the characters under test are invisible: a literal one in
 * this file would be a test nobody reviewing it could see.
 */

/** Every bidi control: the five embeddings and overrides, then the four isolates. */
const BIDI_CONTROLS = [
  "\u{202a}",
  "\u{202b}",
  "\u{202c}",
  "\u{202d}",
  "\u{202e}",
  "\u{2066}",
  "\u{2067}",
  "\u{2068}",
  "\u{2069}",
];

/**
 * Format characters that render as nothing at all: soft hyphen, zero-width space, the two joiners,
 * the two directional marks, word joiner, byte order mark.
 *
 * The last is a tag character, which lives nowhere near the others in the code space and is the
 * usual way invisible text is smuggled into a line that looks ordinary.
 */
const INVISIBLE_FORMATS = [
  "\u{ad}",
  "\u{200b}",
  "\u{200c}",
  "\u{200d}",
  "\u{200e}",
  "\u{200f}",
  "\u{2060}",
  "\u{feff}",
  "\u{e0041}",
];

describe("previewOf", () => {
  test("collapses a message to one line", () => {
    expect(previewOf("first\nsecond   third")).toBe("first second third");
    // A line separator is neither a control nor a format character, so the whitespace collapse is
    // the only thing standing between it and a preview rendered on two lines.
    expect(previewOf("first\u{2028}second\u{2029}third")).toBe(
      "first second third",
    );
  });

  test("strips control characters rather than rendering them", () => {
    // A terminal escape somebody put in a message must not follow it into a log. The escape byte
    // goes and the run collapses to a space; the printable tail it introduced is left alone, which
    // is what the existing regex already does.
    expect(previewOf("before\u{1b}[31mafter")).toBe("before [31mafter");
  });

  test("strips the bidi controls, which make a row render as something else", () => {
    // An override reverses the visual order of everything after it, so a message can make the row
    // it is previewed in read as text the message does not contain.
    for (const bidi of BIDI_CONTROLS) {
      expect(previewOf(`before${bidi}after`)).toBe("before after");
    }
  });

  test("strips invisible format characters rather than passing them through", () => {
    // A zero-width character inside a word renders as the word without it, so a preview reading
    // `admin` need not contain it. Stripping to a space is what makes the difference visible.
    for (const invisible of INVISIBLE_FORMATS) {
      expect(previewOf(`ad${invisible}min`)).toBe("ad min");
    }
  });

  test("has no preview at all when nothing renderable is left", () => {
    // `""` is the dangerous answer: a caller's `?? fallback` does not fire on it, so an empty
    // string becomes the preview a row shows. Every one of these passes the route's `.trim()`
    // non-empty check, so they do arrive here.
    expect(previewOf("")).toBeNull();
    expect(previewOf("   ")).toBeNull();
    expect(previewOf("\u{1}\u{2}")).toBeNull();
    expect(previewOf("\u{200b}\u{200b}")).toBeNull();
    expect(previewOf("\u{202e}")).toBeNull();
  });

  test("truncates to 200 code points with an ellipsis", () => {
    const preview = previewOf("a".repeat(500)) ?? "";
    expect(Array.from(preview)).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("counts code points, not UTF-16 units", () => {
    // 199 plain characters plus one astral character is 200 code points, and must survive whole.
    const text = `${"a".repeat(199)}\u{1f600}`;
    expect(previewOf(text)).toBe(text);
  });

  test("leaves a message that fits alone, however wide its characters", () => {
    // 200 astral code points is 400 UTF-16 units, so a bound counted in units has to carry slack
    // for them. A bound of the cap itself would cut this in half.
    const text = "\u{1f600}".repeat(200);
    expect(previewOf(text)).toBe(text);
  });
});

describe("titleOf", () => {
  test("is shorter than a preview, because a roster row is not a transcript", () => {
    const title = titleOf("a".repeat(500)) ?? "";
    expect(Array.from(title)).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  test("leaves a short first message alone", () => {
    expect(titleOf("  What is our refund policy?  ")).toBe(
      "What is our refund policy?",
    );
  });

  test("leaves a title that fits alone, however wide its characters", () => {
    const text = "\u{1f600}".repeat(80);
    expect(titleOf(text)).toBe(text);
  });

  test("has no title at all when nothing renderable is left", () => {
    // A bot chat is titled once, from the first message, and never again. A title of `""` or of two
    // zero-width spaces is a conversation named nothing for good, because the code that would name
    // it only runs while the title is still null.
    expect(titleOf("\u{1}")).toBeNull();
    expect(titleOf("\u{200b}\u{200b}")).toBeNull();
    expect(titleOf("   ")).toBeNull();
  });
});

describe("the input bound", () => {
  test("keeps a multi-megabyte message from being walked in full", () => {
    // Nothing caps the reported text at the route, so this is what arrives. The visible edge of the
    // bound: the first word is inside it and the second is not, so the second is not in the line.
    expect(previewOf(`a${" ".repeat(3_000_000)}b`)).toBe("a");
    expect(titleOf(`a${" ".repeat(3_000_000)}b`)).toBe("a");
  });

  test("still truncates correctly at the far end of a huge message", () => {
    const preview = previewOf("x".repeat(3_000_000)) ?? "";
    expect(Array.from(preview)).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("never cuts a surrogate pair in half, wherever the bound falls", () => {
    // The bound is in UTF-16 units, so it can land between the halves of an astral character and
    // leave a lone surrogate, which is not a character and renders as the replacement glyph. The
    // padding collapses to one space, so whichever pad length in this sweep puts the astral
    // character exactly on the bound also leaves its surviving half within reach of the cap.
    for (let pad = 1; pad <= 3000; pad++) {
      const text = `a${" ".repeat(pad)}\u{1f600}`;
      for (const line of [previewOf(text), titleOf(text)]) {
        expect(line ?? "").not.toMatch(/[\u{d800}-\u{dfff}]/u);
      }
    }
  });
});
