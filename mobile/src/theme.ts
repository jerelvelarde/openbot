/**
 * The companion's palette, taken from the web app rather than invented.
 *
 * `app/src/styles.css` is a neutral greyscale shadcn theme; matching it means a person moving between
 * the two surfaces is looking at one product. The one place colour is spent is on outcome — permitted,
 * refused, failed — because that distinction is the whole point of the audit trail and it must survive
 * being glanced at on a phone.
 */
import { Platform } from "react-native";

export type Scheme = "light" | "dark";

type Palette = {
  background: string;
  card: string;
  cardMuted: string;
  foreground: string;
  muted: string;
  border: string;
  primary: string;
  primaryForeground: string;
  /**
   * What goes ON one of the outcome colours below.
   *
   * Not a literal white. In the dark palette the accents are pastels — white on `allow` is 1.74:1,
   * which is the two buttons that answer a security question becoming unreadable at the moment they
   * matter. Dark text on those same pastels is 11.4:1.
   */
  accentForeground: string;
  /** Permitted, and the affirmative action on an approval. */
  allow: string;
  /** Refused by a boundary. Final: nothing the Bot does differently will help. */
  refuse: string;
  /** Permitted, attempted, did not work. A different request might. */
  fail: string;
  /** Waiting on a person. */
  pending: string;
};

const light: Palette = {
  background: "#fafafa",
  card: "#ffffff",
  cardMuted: "#f4f4f5",
  foreground: "#18181b",
  /**
   * Secondary text, dark enough to read on the darkest surface it lands on.
   *
   * zinc-500 (#71717a) is 4.40:1 on `cardMuted`, which fails AA at the 11-13px it is used at — and
   * the places it is used are the connection bar that answers "is this real?", the quiet badges and
   * the approval's Details card. This is 5.75:1 there and still inside the same greyscale.
   */
  muted: "#5f5f68",
  border: "#e4e4e7",
  primary: "#18181b",
  primaryForeground: "#fafafa",
  accentForeground: "#ffffff",
  allow: "#15803d",
  refuse: "#b91c1c",
  fail: "#b45309",
  pending: "#1d4ed8",
};

const dark: Palette = {
  background: "#09090b",
  card: "#18181b",
  cardMuted: "#232327",
  foreground: "#fafafa",
  muted: "#a1a1aa",
  border: "#27272a",
  primary: "#fafafa",
  primaryForeground: "#18181b",
  accentForeground: "#09090b",
  allow: "#4ade80",
  refuse: "#f87171",
  fail: "#fbbf24",
  pending: "#93c5fd",
};

export const palettes: Record<Scheme, Palette> = { light, dark };

/**
 * Corner radii, as a scale rather than one number.
 *
 * Three sizes because three things need corners and they are not the same thing: a control, a card,
 * and a bubble. One value made bubbles look like buttons.
 */
export const radius = {
  sm: 10,
  md: 16,
  lg: 20,
  /** A composer, a chip, a badge: anything whose height is its radius. */
  pill: 999,
};

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

/**
 * The type scale, with its leading.
 *
 * `lineHeight` belongs in the token rather than at the call site. Without it each platform picks its
 * own leading from the font metrics, so the same row is a different height on iOS and in the browser
 * and a two-line clamp crops in a different place — which matters here because the recordings are
 * made from the browser and the product runs on the phone.
 */
export const type = {
  title: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "700" as const,
    letterSpacing: -0.7,
  },
  heading: {
    fontSize: 16.5,
    lineHeight: 23,
    fontWeight: "600" as const,
    letterSpacing: -0.2,
  },
  body: { fontSize: 15, lineHeight: 21, fontWeight: "400" as const },
  label: { fontSize: 13, lineHeight: 16, fontWeight: "500" as const },
  small: { fontSize: 12, lineHeight: 16, fontWeight: "400" as const },
  mono: {
    fontSize: 12.5,
    lineHeight: 18,
    /**
     * A family name, not a CSS stack.
     *
     * React Native hands this string to the platform as one font family: iOS logs "Unrecognized font
     * family" and falls back to the system face, Android's `Typeface.create` returns default sans. So
     * a CSS stack renders proportional on every phone while looking correct in every browser
     * recording — and monospacing is the ONLY thing distinguishing an inline `code` span from prose,
     * and the thing that makes a CEL rule readable enough to go and find in Boundaries.
     */
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "ui-monospace, SFMono-Regular, Menlo, monospace",
    }),
  },
};
