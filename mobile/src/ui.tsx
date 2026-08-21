/**
 * The small set of pieces every screen is built from.
 *
 * Kept in one file because there are seven of them and a folder of seven one-component files is
 * harder to read than this. They take colours from the active scheme rather than closing over one,
 * so the whole app follows the phone's appearance setting.
 */
import type { ReactElement, ReactNode } from "react";
import { createContext, useContext } from "react";
import { Pressable, Text, View } from "react-native";
import type { ApprovalSubject } from "./data/types";
import { palettes, radius, type Scheme, space, type as type_ } from "./theme";

const SchemeContext = createContext<Scheme>("light");
export const SchemeProvider = SchemeContext.Provider;
export const useScheme = () => useContext(SchemeContext);
export const useColors = () => palettes[useContext(SchemeContext)];

/**
 * One sentence out of several fields, for the accessibility tree.
 *
 * Joins with a full stop unless the piece already ends in one, because a screen reader reads "run..
 * one waiting" as a pause long enough to sound like a fault.
 */
export function sentence(...parts: (string | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.trim())
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(" ");
}

/**
 * What a Bot wants to do, as a verb somebody reads rather than an enum.
 *
 * `intent` is the policy engine's own vocabulary, and five of its nine values are snake_case — so
 * interpolating it raw produced "Risk Analyst wants to write_file controls/august.csv" in the middle
 * of the sentence a person is being asked to approve.
 */
const INTENTS: Record<string, string> = {
  activate: "activate",
  type: "type into",
  navigate: "open",
  read: "read",
  read_file: "read the file",
  write_file: "write to the file",
  list_files: "list the files in",
  read_tool: "read from",
  write_tool: "change something in",
};

export function intentPhrase(intent: string): string {
  return INTENTS[intent] ?? intent.replace(/_/g, " ");
}

/**
 * What is about to be acted on, as the SERVER named it.
 *
 * The `page` kind is not "a page": the gateway returns it when it could not match the action to
 * anything in the snapshot it took, and puts the bare tool name in the label. That is the one case
 * worth being loud about — a Bot about to click something nobody can identify — and it used to be
 * signalled only by the absence of quotation marks, so "wants to activate click" read as a typo.
 */
export function subjectPhrase(subject: ApprovalSubject): string {
  const where = subject.host ? ` on ${subject.host}` : "";
  if (subject.kind === "page") {
    return `something this deployment could not identify${where}`;
  }
  if (subject.kind === "file") return subject.label;
  if (subject.kind === "mcp") return `${subject.label}${where}`;
  return `“${subject.label}”${where}`;
}

/**
 * What each outcome is called, in one place.
 *
 * One vocabulary because the same event is drawn on three surfaces — a tool line in a transcript, a
 * row in the trail, a dot with no text at all — and a deployment that calls the same thing "Refused"
 * here and "Blocked" there teaches nobody anything.
 */
export const OUTCOME_WORDS: Record<string, string> = {
  allowed: "Permitted",
  refused: "Refused",
  failed: "Failed",
  asked: "Asked for approval",
  answered: "Answered",
  expired: "Nobody answered",
  running: "Waiting",
};

/**
 * The colour an outcome is drawn in.
 *
 * Exported so the dot and the word beside it cannot disagree. They did: the trail coloured only
 * refusals and failures, so every permitted row put a grey word next to a green dot.
 */
export function outcomeColor(
  colors: ReturnType<typeof useColors>,
  outcome: string,
): string {
  if (outcome === "refused" || outcome === "expired") return colors.refuse;
  if (outcome === "failed") return colors.fail;
  if (outcome === "asked" || outcome === "running") return colors.pending;
  return colors.allow;
}

/**
 * An outcome, in the one place colour is spent.
 *
 * It carries its own name. An 8px dot is the entire difference between a call that worked and one
 * that did not on a bare tool line, and a dot is nothing at all to a screen reader.
 */
export function OutcomeDot({ outcome }: { outcome: string }) {
  const colors = useColors();
  return (
    <View
      accessibilityLabel={OUTCOME_WORDS[outcome] ?? outcome}
      accessibilityRole="image"
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: outcomeColor(colors, outcome),
      }}
    />
  );
}

export function Card({
  children,
  onPress,
  muted,
  accent,
  label,
  hint,
}: {
  children: ReactNode;
  onPress?: () => void;
  muted?: boolean;
  /** A card that is the reason the screen exists. Used once per screen at most. */
  accent?: boolean;
  /**
   * What this card says, in one sentence, for somebody who cannot see it.
   *
   * A card built from four separate Texts is announced as four unrelated fragments, and the sentence
   * a person actually needs — who wants to do what — is spread across them.
   */
  label?: string;
  hint?: string;
}) {
  const colors = useColors();
  const body = (
    <View
      style={{
        backgroundColor: muted ? colors.cardMuted : colors.card,
        borderColor: accent ? colors.pending : colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: space.lg,
        gap: space.sm,
      }}
    >
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      // Without a role this is an inert div on web: not focusable, not announced, and Space does
      // nothing. It is the tap target for every approval on the home screen.
      accessibilityRole="button"
      // What a tap looks like on Android, where an opacity dip is not the platform's language.
      android_ripple={{ color: colors.border }}
      {...(label ? { accessibilityLabel: label } : {})}
      {...(hint ? { accessibilityHint: hint } : {})}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.72 : 1,
        transform: [{ scale: pressed ? 0.994 : 1 }],
      })}
    >
      {body}
    </Pressable>
  );
}

/** A row in a list: a picture, then words, then when. The shape of every list in the app. */
export function Row({
  leading,
  title,
  detail,
  meta,
  onPress,
  trailing,
  lines = 1,
  label,
}: {
  leading?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  /** When it happened. Sits with the name, so the detail gets the full width. */
  meta?: string;
  onPress?: () => void;
  trailing?: ReactNode;
  /** How much of the detail to show. Two where the detail IS the news, one where it is context. */
  lines?: number;
  /** The whole row as one sentence, so it is not announced as five fragments. */
  label?: string;
}) {
  const colors = useColors();
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingVertical: 11,
      }}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}
        >
          <Text
            numberOfLines={1}
            style={{
              ...type_.heading,
              color: colors.foreground,
              flexShrink: 1,
              // Without this a flex child refuses to shrink below its content, so at large text sizes
              // the badge keeps its full width and the Bot's name is what disappears.
              minWidth: 0,
            }}
          >
            {title}
          </Text>
          {/* The badge yields before the name does: "1 waiting" is meaningless without whose. */}
          {trailing ? <View style={{ flexShrink: 1 }}>{trailing}</View> : null}
          {/* The time sits with the name rather than in its own column, so the sentence underneath
              gets the full width. A truncated "was allowed to activate “Submi…" says nothing. */}
          {meta ? (
            <Text
              style={{
                ...type_.small,
                color: colors.muted,
                marginLeft: "auto",
              }}
            >
              {meta}
            </Text>
          ) : null}
        </View>
        {detail !== undefined ? (
          <Text
            numberOfLines={lines}
            style={{
              ...type_.body,
              fontSize: 14,
              lineHeight: 19,
              color: colors.muted,
            }}
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      android_ripple={{ color: colors.border }}
      {...(label ? { accessibilityLabel: label } : {})}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {body}
    </Pressable>
  );
}

/** A hairline between rows, inset past the picture so the column reads as one list. */
export function Divider({ inset = 0 }: { inset?: number }) {
  const colors = useColors();
  return (
    <View
      style={{
        height: 1,
        marginLeft: inset,
        backgroundColor: colors.border,
      }}
    />
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const colors = useColors();
  return (
    <Text
      accessibilityRole="header"
      style={{ ...type_.heading, color: colors.foreground }}
    >
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  const colors = useColors();
  return (
    <Text
      style={{
        ...type_.body,
        color: muted ? colors.muted : colors.foreground,
      }}
    >
      {children}
    </Text>
  );
}

export function Label({ children }: { children: ReactNode }) {
  const colors = useColors();
  return (
    <Text
      // A section label IS this screen's structure. Without the role the only way through an
      // approval is swiping past every line in order.
      accessibilityRole="header"
      style={{
        ...type_.label,
        color: colors.muted,
        textTransform: "uppercase",
        letterSpacing: 0.7,
        fontSize: 11,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * A rule, shown verbatim.
 *
 * Monospaced and never truncated in the middle: an operator has to be able to read it and go and
 * find it in /admin/boundaries, and a rule with its centre elided is not findable.
 */
export function Rule({ children }: { children: ReactNode }) {
  const colors = useColors();
  return (
    <View
      style={{
        backgroundColor: colors.cardMuted,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.sm,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
      }}
    >
      <Text
        accessibilityLabel={`Rule: ${String(children)}`}
        selectable
        style={{ ...type_.mono, color: colors.foreground }}
      >
        {children}
      </Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  tone = "default",
  disabled,
}: {
  title: string;
  onPress: () => void;
  tone?: "default" | "allow" | "refuse" | "quiet";
  disabled?: boolean;
}) {
  const colors = useColors();
  const background =
    tone === "allow"
      ? colors.allow
      : tone === "refuse"
        ? colors.refuse
        : tone === "quiet"
          ? "transparent"
          : colors.primary;
  const foreground =
    tone === "quiet"
      ? colors.foreground
      : tone === "default"
        ? colors.primaryForeground
        : colors.accentForeground;
  return (
    <Pressable
      accessibilityRole="button"
      android_ripple={{ color: colors.border }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: background,
        borderColor: tone === "quiet" ? colors.border : background,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingVertical: 13,
        paddingHorizontal: space.xl,
        alignItems: "center",
        opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ ...type_.body, fontWeight: "600", color: foreground }}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "pending" | "quiet";
}) {
  const colors = useColors();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        backgroundColor: tone === "pending" ? colors.pending : colors.cardMuted,
        borderRadius: radius.pill,
        paddingVertical: 3,
        paddingHorizontal: 9,
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          ...type_.small,
          fontWeight: "600",
          color: tone === "pending" ? colors.accentForeground : colors.muted,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

/**
 * Time as somebody glancing at a phone reads it.
 *
 * Day-aware, because this is an audit surface and the reads behind it go back days: `/api/audit`
 * asks for the last sixty events and the approval queue keeps settled rows. A bare clock time makes
 * a refusal from last Tuesday at 14:22 and one from today at 14:22 the same string, which is the one
 * thing a trail must never do.
 *
 * An unparseable value says so rather than rendering "Invalid Date": the runtime's thread history can
 * hand back an empty `createdAt`.
 */
export function when(iso: string): string {
  const date = new Date(iso);
  const at = date.getTime();
  if (Number.isNaN(at)) return "an unknown time";

  const clock = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return clock;

  // Inside the last week a weekday is how people actually refer to it; past that it needs a date.
  const days = (now.getTime() - at) / 86_400_000;
  if (days >= 0 && days < 6) {
    return `${date.toLocaleDateString([], { weekday: "short" })} ${clock}`;
  }
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock}`;
}

/**
 * A Bot's prose, with the little bit of markdown it actually writes.
 *
 * Bots write `**bold**` and `` `code` `` constantly, and rendering those literally puts asterisks and
 * backticks in front of a person — which reads as a bug in the app rather than a habit of the model.
 * A full markdown renderer is a dependency and a layout engine; this is two inline spans, which is
 * what the messages in this app contain.
 *
 * Deliberately not headings, lists, links or tables. Those belong in the web transcript, which has
 * `Streamdown` and the width for them.
 */
export function richText(text: string): (string | ReactElement)[] {
  const parts: (string | ReactElement)[] = [];
  // Bold or code, whichever comes first, and never across a line break: an unclosed marker is far
  // more likely to be a stray asterisk than the start of a span that ends three paragraphs later.
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let index = 0;
  let match = pattern.exec(text);
  let key = 0;

  while (match) {
    if (match.index > index) parts.push(text.slice(index, match.index));
    const bold = match[1];
    const code = match[2];
    key += 1;
    parts.push(
      bold !== undefined ? (
        <Text key={`b${key}`} style={{ fontWeight: "700" }}>
          {bold}
        </Text>
      ) : (
        <Text key={`c${key}`} style={type_.mono}>
          {code}
        </Text>
      ),
    );
    index = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (index < text.length) parts.push(text.slice(index));
  return parts;
}
