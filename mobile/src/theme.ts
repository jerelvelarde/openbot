/**
 * The companion's palette, taken from the web app rather than invented.
 *
 * `app/src/styles.css` is a neutral greyscale shadcn theme; matching it means a person moving between
 * the two surfaces is looking at one product. The one place colour is spent is on outcome — permitted,
 * refused, failed — because that distinction is the whole point of the audit trail and it must survive
 * being glanced at on a phone.
 */
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
  muted: "#71717a",
  border: "#e4e4e7",
  primary: "#18181b",
  primaryForeground: "#fafafa",
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

export const type = {
  title: { fontSize: 30, fontWeight: "700" as const, letterSpacing: -0.7 },
  heading: { fontSize: 16.5, fontWeight: "600" as const, letterSpacing: -0.2 },
  body: { fontSize: 15, fontWeight: "400" as const },
  label: { fontSize: 13, fontWeight: "500" as const },
  small: { fontSize: 12, fontWeight: "400" as const },
  mono: {
    fontSize: 12.5,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
};
