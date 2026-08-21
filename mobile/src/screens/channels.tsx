/**
 * The roster, and a way through to a conversation.
 *
 * The rail across the top exists because a deployment has several Bots and a person thinks about them
 * by picture, not by the name of the last thing one of them said. The list underneath is the same set
 * ordered by what happened most recently.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { BotAvatar, BotAvatarWithDot } from "../avatar";
import { useLiveResult, useSource } from "../store";
import { radius, space, type as type_ } from "../theme";
import {
  Badge,
  Body,
  Button,
  Card,
  Divider,
  Label,
  Row,
  sentence,
  useColors,
  when,
} from "../ui";
import { Screen, Title } from "./chrome";

export function ChannelsScreen({
  onOpenChannel,
  onCompose,
}: {
  onOpenChannel: (id: string) => void;
  onCompose: () => void;
}) {
  const colors = useColors();
  const source = useSource();
  /**
   * A failed read is not an empty deployment.
   *
   * `channels()` fans out to three endpoints in one `Promise.all`, so any one of them failing used to
   * empty the whole roster and say "No channels yet." — stranding every conversation behind a wrong
   * explanation, under a subtitle still asserting these are the Bots you work with.
   */
  const { value: channels, error } = useLiveResult((s) => s.channels());
  const rows = channels ?? [];

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingTop: space.sm,
          paddingBottom: space.xl,
          gap: space.lg,
        }}
      >
        <View style={{ paddingHorizontal: space.lg }}>
          <Title
            detail={
              error
                ? "Could not reach this deployment."
                : channels === undefined
                  ? "Checking…"
                  : "The Bots you are working with."
            }
            right={
              <Pressable
                accessibilityLabel="Start a conversation"
                accessibilityRole="button"
                android_ripple={{ color: colors.border, borderless: true }}
                hitSlop={10}
                onPress={onCompose}
                style={({ pressed }) => ({
                  width: 34,
                  height: 34,
                  borderRadius: radius.pill,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.cardMuted,
                  borderColor: colors.border,
                  borderWidth: 1,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                {/* A plus, drawn. This one is a button, unlike the mark that used to sit in the
                    composer doing nothing. */}
                <View
                  style={{ width: 15, height: 15, justifyContent: "center" }}
                >
                  <View
                    style={{
                      height: 1.8,
                      borderRadius: 1,
                      backgroundColor: colors.foreground,
                    }}
                  />
                  <View
                    style={{
                      position: "absolute",
                      left: 6.6,
                      width: 1.8,
                      height: 15,
                      borderRadius: 1,
                      backgroundColor: colors.foreground,
                    }}
                  />
                </View>
              </Pressable>
            }
            text="Channels"
          />
        </View>

        {error ? (
          <View style={{ paddingHorizontal: space.lg }}>
            <Card muted>
              <Label>Offline</Label>
              <Body muted>{error}</Body>
              <Button
                onPress={() => source.refresh()}
                title="Try again"
                tone="quiet"
              />
            </Card>
          </View>
        ) : null}

        {/* Below two Bots the rail is the row underneath it, drawn twice, sixty points apart. */}
        {rows.length > 1 ? (
          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: space.lg,
              gap: space.lg,
            }}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {rows.map((channel) => (
              <Pressable
                accessibilityLabel={
                  channel.pendingApprovals > 0
                    ? `${channel.botName}, ${channel.pendingApprovals} waiting on you`
                    : channel.botName
                }
                // It carries a 56px face and the only pending indicator in the rail, above a list of
                // identical faces that navigate. It looked exactly as tappable as they are.
                accessibilityRole="button"
                key={`rail_${channel.id}`}
                onPress={() => onOpenChannel(channel.id)}
                style={({ pressed }) => ({
                  alignItems: "center",
                  gap: 7,
                  minWidth: 68,
                  maxWidth: 84,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <BotAvatarWithDot
                  dot={
                    channel.pendingApprovals > 0 ? colors.pending : undefined
                  }
                  // The rail sits on the page, not on a card, so a white ring was visible even in
                  // the light theme.
                  ring={colors.background}
                  seed={channel.botId}
                  size={56}
                />
                <Text
                  numberOfLines={2}
                  style={{
                    ...type_.small,
                    color: colors.foreground,
                    fontWeight: "500",
                    textAlign: "center",
                  }}
                >
                  {channel.botName}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <View style={{ paddingHorizontal: space.lg }}>
          <View
            style={{
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.md,
              paddingHorizontal: space.lg,
            }}
          >
            {rows.map((channel, index) => (
              <View key={channel.id}>
                {index > 0 ? <Divider inset={52} /> : null}
                <Row
                  detail={channel.lastMessage ?? "Nothing said yet."}
                  label={sentence(
                    channel.name,
                    channel.lastMessage ?? "Nothing said yet.",
                    channel.pendingApprovals > 0
                      ? `${channel.pendingApprovals} waiting on you`
                      : undefined,
                  )}
                  leading={<BotAvatar seed={channel.botId} size={40} />}
                  lines={2}
                  meta={
                    channel.lastMessageAt
                      ? when(channel.lastMessageAt)
                      : undefined
                  }
                  onPress={() => onOpenChannel(channel.id)}
                  title={channel.name}
                  trailing={
                    channel.pendingApprovals > 0 ? (
                      <Badge tone="pending">
                        {channel.pendingApprovals} waiting
                      </Badge>
                    ) : channel.busy ? (
                      <Badge tone="quiet">Working</Badge>
                    ) : undefined
                  }
                />
              </View>
            ))}
            {rows.length === 0 ? (
              <View style={{ paddingVertical: space.lg, gap: space.md }}>
                <Body muted>
                  {channels === undefined
                    ? "Checking…"
                    : "No channels yet. Start one, or wait for a Bot to open one on this deployment."}
                </Body>
                {channels !== undefined && !error ? (
                  <Button
                    onPress={onCompose}
                    title="Start a conversation"
                    tone="quiet"
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
