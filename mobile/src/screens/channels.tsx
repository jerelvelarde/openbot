/**
 * The roster, and a way through to a conversation.
 *
 * The rail across the top exists because a deployment has several Bots and a person thinks about them
 * by picture, not by the name of the last thing one of them said. The list underneath is the same set
 * ordered by what happened most recently.
 */
import { ScrollView, Text, View } from "react-native";
import { BotAvatar, BotAvatarWithDot } from "../avatar";
import { useLive } from "../store";
import { radius, space, type as type_ } from "../theme";
import { Badge, Body, Divider, Row, useColors, when } from "../ui";
import { Screen, Title } from "./chrome";

export function ChannelsScreen({
  onOpenChannel,
}: {
  onOpenChannel: (id: string) => void;
}) {
  const colors = useColors();
  const channels = useLive((source) => source.channels());
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
          <Title text="Channels" detail="The Bots you are working with." />
        </View>

        {rows.length > 0 ? (
          <ScrollView
            horizontal
            contentContainerStyle={{
              paddingHorizontal: space.lg,
              gap: space.lg,
            }}
            showsHorizontalScrollIndicator={false}
          >
            {rows.map((channel) => (
              <View
                key={`rail_${channel.id}`}
                style={{ alignItems: "center", gap: 7, width: 68 }}
              >
                <BotAvatarWithDot
                  dot={
                    channel.pendingApprovals > 0 ? colors.pending : undefined
                  }
                  seed={channel.botId}
                  size={56}
                />
                <Text
                  numberOfLines={1}
                  style={{
                    ...type_.small,
                    color: colors.foreground,
                    fontWeight: "500",
                  }}
                >
                  {channel.botName}
                </Text>
              </View>
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
                  leading={<BotAvatar seed={channel.botId} size={40} />}
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
              <View style={{ paddingVertical: space.lg }}>
                <Body muted>No channels yet.</Body>
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
