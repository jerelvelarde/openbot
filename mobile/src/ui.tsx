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
import { palettes, radius, type Scheme, space, type as type_ } from "./theme";

const SchemeContext = createContext<Scheme>("light");
export const SchemeProvider = SchemeContext.Provider;
export const useScheme = () => useContext(SchemeContext);
export const useColors = () => palettes[useContext(SchemeContext)];

/** An outcome, in the one place colour is spent. */
export function OutcomeDot({ outcome }: { outcome: string }) {
  const colors = useColors();
  const color =
    outcome === "refused"
      ? colors.refuse
      : outcome === "failed"
        ? colors.fail
        : outcome === "asked" || outcome === "running"
          ? colors.pending
          : colors.allow;
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        marginTop: 6,
      }}
    />
  );
}

export function Card({
  children,
  onPress,
  muted,
  accent,
}: {
  children: ReactNode;
  onPress?: () => void;
  muted?: boolean;
  /** A card that is the reason the screen exists. Used once per screen at most. */
  accent?: boolean;
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
            }}
          >
            {title}
          </Text>
          {trailing}
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
    <Text style={{ ...type_.heading, color: colors.foreground }}>
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
        lineHeight: 21,
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
      <Text style={{ ...type_.mono, color: colors.foreground }} selectable>
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
        : "#ffffff";
  return (
    <Pressable
      accessibilityRole="button"
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
        borderRadius: 999,
        paddingVertical: 3,
        paddingHorizontal: 9,
      }}
    >
      <Text
        style={{
          ...type_.small,
          fontWeight: "600",
          color: tone === "pending" ? "#ffffff" : colors.muted,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

/** Time as somebody glancing at a phone reads it. */
export function when(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
