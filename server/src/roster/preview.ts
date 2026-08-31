/**
 * What a roster row says, and how much of a list one read returns.
 *
 * Here rather than in `channels/routes.ts`, where these started, because bot chats and the roster
 * query both need them now. A second `previewOf` that stripped control characters slightly
 * differently would be a preview that rendered differently depending on which kind of row it was:
 * the same fact told two ways, which is what this module exists to prevent.
 */

const MAX_ACTIVITY_CODE_POINTS = 200;

/**
 * How long a title may be.
 *
 * Shorter than a preview because it shares a roster row with one: the title is the line a person
 * scans, and a title running to 200 characters would push the preview off the row it names.
 */
const MAX_TITLE_CODE_POINTS = 80;

/**
 * How much of a message `flatten` reads at a time, as a multiple of its cap in UTF-16 units.
 *
 * A pass over a whole message is not free: the strip and the collapse are a pass each over whatever
 * was read, and the code-point array after them holds one entry per code point of it. Every activity
 * report pays that, so the first read is a window rather than the message.
 *
 * A multiple of the cap rather than the cap itself, because the cap counts code points and this
 * counts UTF-16 units: an astral character is two units, and a character that is stripped or
 * collapsed is units that produce no output at all. Eight leaves room for both in one read.
 *
 * A WINDOW, NOT A CEILING, and that is the whole of the difference. An earlier version bounded the
 * input and answered from whatever the bound left, so a message whose first `cap * 8` units were
 * invisible lost the rest of itself and said nothing about it: 1,599 zero-width spaces followed by
 * 400 `x`s previewed as `x` — one code point, no ellipsis, a row rendering as though that were the
 * whole message — and a bot chat is titled once and never again, so a first message shaped that way
 * named the conversation for good. `flatten` now widens the window until it has more than `cap` code
 * points or has read the message to its end, so this number decides how many reads a message costs
 * and never what it says. A message that hides its content behind a great deal of nothing pays for
 * the reads it forces, in proportion to how much it hid.
 *
 * That cost is bounded from outside as well, today: every caller arrives through an activity route,
 * and `parseActivityInput` in `channels/routes.ts` refuses a message longer than
 * `MAX_ACTIVITY_TEXT_UNITS` rather than truncating it. But that cap is that route's promise and not
 * this function's, which is why the window is here at all.
 */
const INPUT_UNITS_PER_CODE_POINT = 8;

/**
 * How many conversations one page holds.
 *
 * The sidebar asked for all of them on every render and nothing removed a channel, so somebody who
 * talks to their Bot daily accumulates thousands: a query that is instant in a demo returns
 * thousands of rows on every page load for every employee, and grows monotonically. A page is what a
 * sidebar can show anyway.
 */
export const DEFAULT_ROSTER_PAGE = 50;

/** The most a caller may ask for, so the endpoint cannot be talked back into reading everything. */
export const MAX_ROSTER_PAGE = 200;

/**
 * The first `limit` UTF-16 units of a message, never half a character.
 *
 * A cut in units can land between the halves of an astral character, so a high surrogate on the end
 * goes with the cut: half of a character is not a character. `flatten` strips a lone surrogate to a
 * space rather than rendering it, so without this a message long enough to be shown truncated here
 * would show a space where an astral character was; backing off leaves that character whole for the
 * next read instead.
 */
function boundedInput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
  return text.slice(0, end);
}

/**
 * Everything a window of a message goes through: strip what cannot be rendered, then make one line.
 *
 * Its own function because `flatten` runs it once per read, and because the two halves have to stay
 * in this order — stripping produces spaces, and the collapse is what folds them into the whitespace
 * around them instead of leaving a run of them in the middle of the line.
 */
function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Reduce a message to one line of plain text, capped. `null` when nothing is left to show.
 *
 * A preview is rendered as text wherever a roster appears, so control and format characters have
 * nothing to do there: at best they are invisible, at worst a bidi override reverses the visual
 * order of the row and the title beside it, or a terminal escape somebody put in a message follows
 * it into a log. Those categories go, written as Unicode categories rather than as ranges so that
 * what this says and what it strips cannot drift apart: `Cc` is the C0 and C1 controls, `Cf` is
 * every format character — the bidi overrides and isolates, the zero-width space, the joiners, the
 * tag characters — and `Cs` is the surrogates. Newlines collapse to spaces because a preview is one
 * line by definition.
 *
 * `Cs` is here because a lone surrogate arrives in a request body as easily as anything else:
 * `JSON.parse('"\\ud800"')` is exactly one, and it is not a character. Passing it through made three
 * strings out of one value — the one this returned, the one on the row (the Postgres driver
 * substitutes U+FFFD when it encodes UTF-8), and the one the JSON response carried — and the row
 * rendered the replacement glyph the rest of this docblock exists to keep off it.
 *
 * Taking the whole category costs something real: an emoji ZWJ sequence renders as the emoji it is
 * built from, and Persian loses a zero-width non-joiner that belonged there. That is the price of
 * the property a roster needs, which is that a row cannot render as something other than what it
 * contains. It is also what leaves a message of nothing but invisible characters with nothing at
 * all, rather than with a name that renders blank.
 *
 * `null` rather than `""` for that nothing, because `""` is an answer a caller cannot see through:
 * `?? fallback` does not fire on it, so it is stored and shown as a preview the row has. A bot chat
 * is titled once and never again, so an empty title is a conversation called nothing for good. It
 * says the whole message renders as nothing, not that the part of it that was read did: the loop
 * below stops only when it has more than `cap` code points or has reached the end of the message, so
 * an empty line is only ever the whole of one.
 *
 * The cap counts code points rather than UTF-16 units, so it never lands inside an astral character
 * and leaves half of one behind. It is not grapheme-aware: a combining mark can still be cut off
 * the letter it belongs to, or one half of a flag off the other, which renders as an unaccented
 * letter or a lone regional indicator rather than as a broken character.
 */
function flatten(text: string, cap: number): string | null {
  const read = (limit: number) =>
    Array.from(oneLine(boundedInput(text, limit)));

  let limit = cap * INPUT_UNITS_PER_CODE_POINT;
  let codePoints = read(limit);
  /*
   * A line shorter than the cap with input still unread means the reading stopped early, not that
   * the message is short — so read further rather than answer for a message from a window it hid
   * itself behind. Doubling, so the work is at worst twice the window an adversarial message forces
   * and the ordinary message costs the one read. See `INPUT_UNITS_PER_CODE_POINT`.
   */
  while (codePoints.length <= cap && limit < text.length) {
    limit *= 2;
    codePoints = read(limit);
  }

  if (codePoints.length === 0) return null;
  if (codePoints.length <= cap) return codePoints.join("");
  return `${codePoints.slice(0, cap - 1).join("")}…`;
}

/** One line of what was said, for the roster row it belongs to. `null` when it said nothing. */
export function previewOf(text: string): string | null {
  return flatten(text, MAX_ACTIVITY_CODE_POINTS);
}

/**
 * What a bot chat is called, taken from the first thing the person said in it.
 *
 * `null` when that message renders as nothing, which leaves the chat untitled: the write that names
 * a chat runs only while the title is null, so the next thing the person says gets to name it.
 */
export function titleOf(text: string): string | null {
  return flatten(text, MAX_TITLE_CODE_POINTS);
}
