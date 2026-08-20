/**
 * The audit trail, read-only.
 *
 * Permitted, refused and failed are three different things and are drawn as three different things:
 * a trail that only shows successes cannot answer whether the Bot tried, and one that renders a
 * refusal like a failure sends somebody to debug a container when what happened is that the policy
 * worked.
 */
import { ScrollView, Text, View } from "react-native";
import { BotAvatarWithDot } from "../avatar";
import { useLive } from "../store";
import { radius, space, type as type_ } from "../theme";
import { Body, Divider, Rule, useColors, when } from "../ui";
import { Screen, Title } from "./chrome";

const WORDS: Record<string, string> = {
  allowed: "Permitted",
  refused: "Refused",
  failed: "Failed",
  asked: "Asked you",
  answered: "You answered",
};

export function ActivityScreen() {
  const colors = useColors();
  const rows = useLive((source) => source.audit());

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
          paddingBottom: space.xl,
          gap: space.lg,
        }}
      >
        <Title
          detail="What was permitted, what was refused, and the rule that decided."
          text="Activity"
        />
        <View
          style={{
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.md,
            paddingHorizontal: space.lg,
          }}
        >
          {(rows ?? []).map((row, index) => (
            <View key={row.id}>
              {index > 0 ? <Divider inset={44} /> : null}
              <View
                style={{
                  flexDirection: "row",
                  gap: space.md,
                  paddingVertical: space.md,
                }}
              >
                <BotAvatarWithDot
                  dot={
                    row.outcome === "refused"
                      ? colors.refuse
                      : row.outcome === "failed"
                        ? colors.fail
                        : row.outcome === "asked"
                          ? colors.pending
                          : colors.allow
                  }
                  seed={row.botId}
                  size={32}
                />
                <View style={{ flex: 1, gap: 3 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      gap: space.sm,
                    }}
                  >
                    <Text
                      style={{
                        ...type_.small,
                        fontWeight: "600",
                        color:
                          row.outcome === "refused"
                            ? colors.refuse
                            : row.outcome === "failed"
                              ? colors.fail
                              : colors.muted,
                      }}
                    >
                      {WORDS[row.outcome] ?? row.outcome}
                    </Text>
                    <Text style={{ ...type_.small, color: colors.muted }}>
                      {when(row.at)}
                    </Text>
                  </View>
                  <Text
                    numberOfLines={2}
                    style={{ ...type_.body, color: colors.foreground }}
                  >
                    {row.summary}
                  </Text>
                  <Text style={{ ...type_.small, color: colors.muted }}>
                    {row.botName}
                    {row.actor ? ` · ${row.actor}` : ""}
                  </Text>
                  {/* Every refusal carries the rule that caused it. */}
                  {row.rule ? <Rule>{row.rule}</Rule> : null}
                </View>
              </View>
            </View>
          ))}
          {(rows ?? []).length === 0 ? (
            <View style={{ paddingVertical: space.lg }}>
              <Body muted>Nothing has happened yet.</Body>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
