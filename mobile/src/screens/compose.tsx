/**
 * Starting a conversation.
 *
 * Without this the app could only ever answer: it read the channels a deployment already had and had
 * no way to make one, so on a deployment with none it was permanently read-only and said "No channels
 * yet" with nothing to do about it.
 *
 * The server mints the thread. This screen never invents an id — it posts the Bot it was given and
 * opens whatever comes back, which is the same thing the web app's compose flow does.
 */
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { BotAvatar } from "../avatar";
import { useLiveResult, useSource } from "../store";
import { radius, space } from "../theme";
import { Body, Card, Divider, Label, Row, sentence, useColors } from "../ui";
import { Screen, TopBar } from "./chrome";

export function ComposeScreen({
  onBack,
  onOpenChannel,
}: {
  onBack: () => void;
  onOpenChannel: (channelId: string) => void;
}) {
  const colors = useColors();
  const source = useSource();
  const { value: bots, error } = useLiveResult((s) => s.bots());
  /** Which Bot is being started with, so the row says so and a second tap cannot double it. */
  const [starting, setStarting] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const start = (botId: string) => {
    if (starting) return;
    setStarting(botId);
    setFailure(null);
    void source.createChannel(botId).then(
      (channel) => {
        setStarting(null);
        onOpenChannel(channel.id);
      },
      (cause: unknown) => {
        setStarting(null);
        setFailure(
          cause instanceof Error
            ? cause.message
            : "That conversation could not be started.",
        );
      },
    );
  };

  return (
    <Screen>
      <TopBar onBack={onBack} title="New conversation" />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.lg,
          paddingTop: space.md,
          paddingBottom: space.xl,
          gap: space.lg,
        }}
      >
        <Body muted>
          {error
            ? "Could not reach this deployment."
            : bots === undefined
              ? "Checking…"
              : "Who do you want to talk to?"}
        </Body>

        {error ? (
          <Card muted>
            <Label>Offline</Label>
            <Body muted>{error}</Body>
          </Card>
        ) : null}

        {failure ? (
          <Card muted>
            <Label>Did not start</Label>
            <Body>{failure}</Body>
          </Card>
        ) : null}

        {(bots ?? []).length > 0 ? (
          <View
            style={{
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.md,
              paddingHorizontal: space.lg,
            }}
          >
            {(bots ?? []).map((bot, index) => (
              <View key={bot.id}>
                {index > 0 ? <Divider inset={52} /> : null}
                <Row
                  detail={
                    starting === bot.id
                      ? "Starting…"
                      : (bot.title ?? "A Bot on this deployment")
                  }
                  label={sentence(bot.name, bot.title ?? undefined)}
                  leading={<BotAvatar seed={bot.id} size={40} />}
                  lines={2}
                  onPress={() => start(bot.id)}
                  title={bot.name}
                />
              </View>
            ))}
          </View>
        ) : null}

        {bots !== undefined && bots.length === 0 && !error ? (
          <Body muted>
            This deployment has no Bots you can talk to. An administrator adds
            them in Coworkers.
          </Body>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
