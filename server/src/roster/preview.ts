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
 * Reduce a message to one line of plain text, capped.
 *
 * A preview is rendered as text wherever a roster appears, so control characters have nothing to do
 * there: at best they are invisible, at worst a terminal escape somebody put in a message follows it
 * into a log. Newlines collapse to spaces because a preview is one line by definition.
 *
 * Counted in code points rather than UTF-16 units, so a cap never lands inside an astral character
 * and leaves half of one behind.
 */
function flatten(text: string, cap: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const flattened = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  const collapsed = flattened.replace(/\s+/g, " ");
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= cap) return collapsed;
  return `${codePoints.slice(0, cap - 1).join("")}…`;
}

export function previewOf(text: string): string {
  return flatten(text, MAX_ACTIVITY_CODE_POINTS);
}

/** What a bot chat is called, taken from the first thing the person said in it. */
export function titleOf(text: string): string {
  return flatten(text, MAX_TITLE_CODE_POINTS);
}
