/**
 * The frame every screen sits in: safe area, background, title, and the back bar.
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

export function Title({ text, detail }: { text: string; detail?: string }) {
  const colors = useColors();
  return (
    <View style={{ gap: 4, paddingTop: space.sm }}>
      <Text style={{ ...type_.title, color: colors.foreground }}>{text}</Text>
      {detail ? <Body muted>{detail}</Body> : null}
    </View>
  );
}

/**
 * The bar above a pushed screen.
 *
 * A large tap target for back, because the one-handed reach on a phone is the bottom of the screen
 * and this is at the top; making it small as well would be unkind.
 */
export function TopBar({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack: () => void;
  right?: ReactNode;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.md,
        borderBottomColor: colors.border,
        borderBottomWidth: 1,
        backgroundColor: colors.card,
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onBack}
        hitSlop={12}
        style={({ pressed }) => ({
          paddingVertical: 6,
          paddingHorizontal: 8,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ ...type_.body, color: colors.muted }}>‹ Back</Text>
      </Pressable>
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
