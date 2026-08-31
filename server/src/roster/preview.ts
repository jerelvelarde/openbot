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
 * How much of a message `flatten` reads, as a multiple of its cap in UTF-16 units.
 *
 * Nothing upstream guarantees the size of what arrives: Hono applies no body limit, and a length
 * cap at a route is that route's promise rather than this function's. Unbounded, a multi-megabyte
 * message costs two whole-string passes and then an array holding one entry per code point of it,
 * all to keep the first `cap`. Bounded here because this is the code that does the work, and it
 * does it for every activity report.
 *
 * A multiple of the cap rather than the cap itself, because the cap counts code points and this
 * counts UTF-16 units: an astral character is two units, and a character that is stripped or
 * collapsed is units that produce no output at all. Eight leaves room for both. It takes a message
 * whose first `cap * 8` units are seven-eighths whitespace and invisible characters to lose
 * anything it would otherwise have shown, and such a message has nothing to show.
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
 * goes with the cut: half of a character is not a character, and renders as the replacement glyph
 * rather than as anything the message contained.
 */
function boundedInput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
  return text.slice(0, end);
}

/**
 * Reduce a message to one line of plain text, capped. `null` when nothing is left to show.
 *
 * A preview is rendered as text wherever a roster appears, so control and format characters have
 * nothing to do there: at best they are invisible, at worst a bidi override reverses the visual
 * order of the row and the title beside it, or a terminal escape somebody put in a message follows
 * it into a log. Both categories go, written as Unicode categories rather than as ranges so that
 * what this says and what it strips cannot drift apart: `Cc` is the C0 and C1 controls, `Cf` is
 * every format character — the bidi overrides and isolates, the zero-width space, the joiners, the
 * tag characters. Newlines collapse to spaces because a preview is one line by definition.
 *
 * Taking the whole category costs something real: an emoji ZWJ sequence renders as the emoji it is
 * built from, and Persian loses a zero-width non-joiner that belonged there. That is the price of
 * the property a roster needs, which is that a row cannot render as something other than what it
 * contains. It is also what leaves a message of nothing but invisible characters with nothing at
 * all, rather than with a name that renders blank.
 *
 * `null` rather than `""` for that nothing, because `""` is an answer a caller cannot see through:
 * `?? fallback` does not fire on it, so it is stored and shown as a preview the row has. A bot chat
 * is titled once and never again, so an empty title is a conversation called nothing for good.
 *
 * The cap counts code points rather than UTF-16 units, so it never lands inside an astral character
 * and leaves half of one behind. It is not grapheme-aware: a combining mark can still be cut off
 * the letter it belongs to, or one half of a flag off the other, which renders as an unaccented
 * letter or a lone regional indicator rather than as a broken character.
 */
function flatten(text: string, cap: number): string | null {
  const bounded = boundedInput(text, cap * INPUT_UNITS_PER_CODE_POINT);
  const stripped = bounded.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  const collapsed = stripped.replace(/\s+/g, " ");
  if (collapsed === "") return null;
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= cap) return collapsed;
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
