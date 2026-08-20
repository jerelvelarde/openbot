/**
 * The frame every screen sits in: background, title, and the bar above a pushed screen.
 */
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { space, type as type_ } from "../theme";
import { Body, useColors } from "../ui";

export function Screen({ children }: { children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {children}
    </View>
  );
}

export function Title({
  text,
  detail,
  right,
}: {
  text: string;
  detail?: string;
  right?: ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 5, paddingTop: space.sm, paddingBottom: space.xs }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text style={{ ...type_.title, color: colors.foreground }}>{text}</Text>
        {right}
      </View>
      {detail ? <Body muted>{detail}</Body> : null}
    </View>
  );
}

/** The chevron on a back button. Drawn, because a "‹" is a different weight in every font. */
function Chevron({ color }: { color: string }) {
  return (
    <View style={{ width: 11, height: 18, justifyContent: "center" }}>
      <View
        style={{
          width: 9,
          height: 9,
          borderLeftWidth: 2,
          borderBottomWidth: 2,
          borderColor: color,
          transform: [{ rotate: "45deg" }],
        }}
      />
    </View>
  );
}

/**
 * The bar above a pushed screen.
 *
 * The back target is deliberately large. One-handed reach on a phone is the bottom of the screen and
 * this sits at the top; making it small as well would be unkind.
 */
export function TopBar({
  title,
  onBack,
  leading,
  right,
}: {
  title: string;
  onBack: () => void;
  /** Usually the Bot's avatar, so a conversation is identified by picture before it is read. */
  leading?: ReactNode;
  right?: ReactNode;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingLeft: space.sm,
        paddingRight: space.md,
        paddingVertical: 10,
        borderBottomColor: colors.border,
        borderBottomWidth: 1,
        backgroundColor: colors.card,
      }}
    >
      <Pressable
        accessibilityLabel="Back"
        accessibilityRole="button"
        hitSlop={14}
        onPress={onBack}
        style={({ pressed }) => ({
          paddingVertical: 8,
          paddingHorizontal: 8,
          opacity: pressed ? 0.5 : 1,
        })}
      >
        <Chevron color={colors.foreground} />
      </Pressable>
      {leading}
      <Text
        numberOfLines={1}
        style={{ ...type_.heading, color: colors.foreground, flex: 1 }}
      >
        {title}
      </Text>
      {right}
    </View>
  );
}

export const isWeb = Platform.OS === "web";
