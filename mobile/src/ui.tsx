/**
 * The small set of pieces every screen is built from.
 *
 * Kept in one file because there are seven of them and a folder of seven one-component files is
 * harder to read than this. They take colours from the active scheme rather than closing over one,
 * so the whole app follows the phone's appearance setting.
 */
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { Pressable, Text, View } from "react-native";
import { type Scheme, palettes, radius, space, type as type_ } from "./theme";

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
}: {
  children: ReactNode;
  onPress?: () => void;
  muted?: boolean;
}) {
  const colors = useColors();
  const body = (
    <View
      style={{
        backgroundColor: muted ? colors.cardMuted : colors.card,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius,
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
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {body}
    </Pressable>
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
        borderRadius: 8,
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
        borderRadius: 10,
        paddingVertical: 13,
        paddingHorizontal: space.lg,
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
