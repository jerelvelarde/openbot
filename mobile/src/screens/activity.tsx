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
import { useLiveResult, useSource } from "../store";
import { radius, space, type as type_ } from "../theme";
import {
  Body,
  Button,
  Card,
  Divider,
  Label,
  OUTCOME_WORDS,
  outcomeColor,
  Rule,
  sentence,
  useColors,
  when,
} from "../ui";
import { Screen, Title } from "./chrome";

export function ActivityScreen() {
  const colors = useColors();
  const source = useSource();
  /**
   * A failed read is not an empty trail.
   *
   * "Nothing has happened yet." is a claim about a security record, and it was being made about a
   * request that never came back — on the screen whose subtitle promises what was permitted and what
   * was refused.
   */
  const { value: rows, error } = useLiveResult((s) => s.audit());

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

        {error ? (
          <Card muted>
            <Label>Offline</Label>
            <Body muted>{error}</Body>
            {(rows ?? []).length > 0 ? (
              <Body muted>
                What you can see below is the last thing this app was told.
              </Body>
            ) : null}
            <Button
              onPress={() => source.refresh()}
              title="Try again"
              tone="quiet"
            />
          </Card>
        ) : null}

        <View
          style={{
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.md,
            paddingHorizontal: space.lg,
          }}
        >
          {(rows ?? []).map((row, index) => {
            // A dry-run deployment records the refusal and lets the action through. Saying "Refused"
            // about something that happened is the trail contradicting itself.
            const shadowed = row.mode === "dry-run" && row.carriedOut === true;
            const word = shadowed
              ? "Would have been refused"
              : (OUTCOME_WORDS[row.outcome] ?? row.outcome);
            const tint = shadowed
              ? colors.fail
              : outcomeColor(colors, row.outcome);
            return (
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
                    dot={tint}
                    ring={colors.card}
                    seed={row.botId}
                    size={32}
                  />
                  <View style={{ flex: 1, gap: 3 }}>
                    {/* One sentence, not five fragments — but the rule stays outside the group, so
                        it is skippable rather than spelled out inside every row. */}
                    <View
                      accessible
                      accessibilityLabel={sentence(
                        word,
                        row.summary,
                        row.botName,
                        when(row.at),
                      )}
                      style={{ gap: 3 }}
                    >
                      <View
                        style={{
                          flexDirection: "row",
                          justifyContent: "space-between",
                          gap: space.sm,
                        }}
                      >
                        {/* The word takes the dot's colour rather than its own. They disagreed on
                          every permitted row: a grey word next to a green dot. */}
                        <Text
                          style={{
                            ...type_.small,
                            fontWeight: "600",
                            color: tint,
                            flexShrink: 1,
                          }}
                        >
                          {word}
                        </Text>
                        <Text style={{ ...type_.small, color: colors.muted }}>
                          {when(row.at)}
                        </Text>
                      </View>
                      {/* Not clamped: this row cannot be opened, tapped or expanded, so a clamp at
                        large text sizes makes the record unrecoverable. */}
                      <Text
                        selectable
                        style={{ ...type_.body, color: colors.foreground }}
                      >
                        {row.summary}
                      </Text>
                      <Text style={{ ...type_.small, color: colors.muted }}>
                        {row.botName}
                        {row.actor ? ` · ${row.actor}` : ""}
                      </Text>
                    </View>
                    {shadowed ? (
                      <Text style={{ ...type_.small, color: colors.muted }}>
                        dry-run: recorded, not enforced — it went ahead.
                      </Text>
                    ) : null}
                    {/* Every refusal carries the rule that caused it. */}
                    {row.rule ? <Rule>{row.rule}</Rule> : null}
                  </View>
                </View>
              </View>
            );
          })}
          {(rows ?? []).length === 0 ? (
            <View style={{ paddingVertical: space.lg }}>
              <Body muted>
                {rows === undefined && !error
                  ? "Checking…"
                  : error
                    ? "Nothing to show while this deployment cannot be reached."
                    : "Nothing has happened yet. Every action this deployment's policy allowed, refused or failed to carry out shows up here, with the rule that decided it."}
              </Body>
            </View>
          ) : null}
        </View>

        {/* The read asks for the sixty most recent events and then drops the ones that are not
            outcomes, so the bottom of this list is otherwise indistinguishable from the beginning of
            the deployment's history. */}
        {(rows ?? []).length > 0 ? (
          <Text
            style={{
              ...type_.small,
              color: colors.muted,
              textAlign: "center",
            }}
          >
            The most recent activity. The full trail lives on the deployment.
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
