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

/**
 * Surrogates with no other half: both ends of the high range, both ends of the low range.
 *
 * Not characters, and not typos in this file either — `JSON.parse` accepts `"\ud800"` and hands back
 * a string of one, so a request body is all it takes to put one of these in a message.
 */
const LONE_SURROGATES = ["\u{d800}", "\u{dbff}", "\u{dc00}", "\u{dfff}"];

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

  test("strips a lone surrogate, which is not a character at all", () => {
    /*
     * `JSON.parse('"\\ud800"')` yields exactly this, so a request body reaches here with one. Passed
     * through, it made three strings out of one value: this function returned the surrogate, the
     * Postgres driver substituted U+FFFD storing it, and the JSON response carried the original — and
     * the row rendered the replacement glyph the strip exists to prevent.
     */
    for (const lone of LONE_SURROGATES) {
      expect(previewOf(`a${lone}b`)).toBe("a b");
      expect(titleOf(`a${lone}b`)).toBe("a b");
    }
    // A pair in the wrong order is two lone surrogates, not a character between them. Written low
    // then high on purpose: `\u{d800}\u{dfff}` the other way round is the valid pair U+103FF, and a
    // real character is exactly what must NOT be stripped.
    expect(previewOf("a\u{dc00}\u{d800}b")).toBe("a b");
    // And a message of nothing else has nothing to show, like any other run of invisibles.
    expect(previewOf("\u{d800}\u{d801}")).toBeNull();
    expect(titleOf("\u{d800}")).toBeNull();
  });

  test("leaves a well-formed astral character alone", () => {
    // The point of naming `Cs` rather than the code range: a surrogate *pair* is one code point in
    // `So`, so stripping the category cannot cost an emoji the message really contained.
    expect(previewOf("a\u{1f600}b")).toBe("a\u{1f600}b");
    expect(titleOf("a\u{1f600}b")).toBe("a\u{1f600}b");
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
    // 200 astral code points is 400 UTF-16 units, so a window counted in units has to carry slack for
    // them: the first read is 1,600, and this sits well inside it. That is what the multiplier buys —
    // one read for an ordinary message, whatever its characters cost. A smaller one would still show
    // this message whole, because the reads widen; it would take two of them to do it.
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

/*
 * The window is how much is read at a time, not how much may be shown.
 *
 * These are the tests of that distinction. It used to be a bound instead: a message whose leading
 * units were invisible answered from them and lost the rest of itself, with no ellipsis on the row to
 * say so, which is a message able to make its own preview say whatever it likes. The window has no
 * visible edge by design, so what is asserted here is the absence of one.
 */
describe("the input window", () => {
  /**
   * A message that hides 400 visible characters behind 1,599 invisible units.
   *
   * 1,599 is the number that matters: `previewOf`'s first read is 200 code points × 8 units, so this
   * puts the first visible character on the last unit of that read and all 399 others past the end of
   * it. `titleOf`'s first read is 640 units, so the run buries every visible character there.
   */
  function hiddenBehind(invisible: string): string {
    return `${invisible.repeat(1599)}${"x".repeat(400)}`;
  }

  test.each([
    ["\u{200b}", "a zero-width space, which `Cf` strips"],
    [" ", "an ordinary space, which the collapse folds away"],
  ])("shows a message hidden behind a run of %p: %s", (invisible: string) => {
    // The measured failure: this previewed as `x` — one code point of the 400, and no ellipsis, so
    // the row read as though that were the whole message. A title is worse than a row, because a
    // bot chat is titled once and never again.
    const text = hiddenBehind(invisible);
    expect(previewOf(text)).toBe(`${"x".repeat(199)}…`);
    expect(titleOf(text)).toBe(`${"x".repeat(79)}…`);
  });

  test("reads past a run of whitespace far wider than the first window", () => {
    // Three million units of nothing between two words, which no first read covers and only a dozen
    // doublings reach. The answer is still both words, because the reading stops on having something
    // to show rather than on a number.
    expect(previewOf(`a${" ".repeat(3_000_000)}b`)).toBe("a b");
    expect(titleOf(`a${" ".repeat(3_000_000)}b`)).toBe("a b");
  });

  test("has no ellipsis when the unread part was nothing anyway", () => {
    // The other direction, and the reason the widening is not simply "signal a cut": a message whose
    // tail is whitespace is not truncated, and a row claiming it continues would be its own small
    // lie.
    expect(previewOf(`hello${" ".repeat(3_000_000)}`)).toBe("hello");
    expect(titleOf(`hello${" ".repeat(3_000_000)}`)).toBe("hello");
  });

  test("still truncates correctly at the far end of a huge message", () => {
    const preview = previewOf("x".repeat(3_000_000)) ?? "";
    expect(Array.from(preview)).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("has nothing to show for a huge message that renders as nothing", () => {
    // `null` says the whole message renders as nothing, which is a claim about the message and not
    // about the first window of it — so it costs reading all of this to make.
    expect(previewOf("\u{200b}".repeat(3_000_000))).toBeNull();
    expect(titleOf(" ".repeat(3_000_000))).toBeNull();
  });

  test("never cuts a surrogate pair in half, wherever a read ends", () => {
    // A read ends on a UTF-16 unit, so it can land between the halves of an astral character and
    // leave a lone surrogate — which is not a character, and which the strip would turn into a space
    // in the middle of the line. The padding collapses to one space, so whichever pad length in this
    // sweep puts the astral character exactly on a read boundary also leaves it within reach of the
    // cap.
    for (let pad = 1; pad <= 3000; pad++) {
      const text = `a${" ".repeat(pad)}\u{1f600}`;
      for (const line of [previewOf(text), titleOf(text)]) {
        expect(line ?? "").not.toMatch(/[\u{d800}-\u{dfff}]/u);
        expect(line).toBe(`a \u{1f600}`);
      }
    }
  });

  test("lets no lone surrogate through, wherever a read ends", () => {
    // The sweep above is about a whole character split by a read. This one is about a half character
    // that arrived that way: it is `Cs` that has to catch this, at every offset relative to a read
    // boundary, and the surviving line is the message without it.
    for (let pad = 1; pad <= 3000; pad++) {
      const text = `a${" ".repeat(pad)}\u{d800}b`;
      for (const line of [previewOf(text), titleOf(text)]) {
        expect(line ?? "").not.toMatch(/[\u{d800}-\u{dfff}]/u);
        expect(line).toBe("a b");
      }
    }
  });
});
