/**
 * The audit trail, read-only.
 *
 * Permitted, refused and failed are three different things and are drawn as three different things:
 * a trail that only shows successes cannot answer whether the Bot tried, and one that renders a
 * refusal like a failure sends somebody to debug a container when what happened is that the policy
 * worked.
 */
import { ScrollView, View } from "react-native";
import { useLive } from "../store";
import { space } from "../theme";
import { Body, Card, Label, OutcomeDot, Rule, useColors, when } from "../ui";
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
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Title
          text="Activity"
          detail="What was permitted, what was refused, and the rule that decided."
        />
        {(rows ?? []).map((row) => (
          <Card key={row.id} muted>
            <View style={{ flexDirection: "row", gap: space.md }}>
              <OutcomeDot outcome={row.outcome} />
              <View style={{ flex: 1, gap: space.xs }}>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    gap: space.sm,
                  }}
                >
                  <Label>{WORDS[row.outcome] ?? row.outcome}</Label>
                  <Body muted>{when(row.at)}</Body>
                </View>
                <Body>{row.summary}</Body>
                <Body muted>
                  {row.botName}
                  {row.actor ? ` · ${row.actor}` : ""}
                </Body>
                {/* Every refusal carries the rule that caused it. */}
                {row.rule ? <Rule>{row.rule}</Rule> : null}
              </View>
            </View>
          </Card>
        ))}
        <View
          style={{ height: space.xl, backgroundColor: colors.background }}
        />
      </ScrollView>
    </Screen>
  );
}
