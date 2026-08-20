/**
 * The roster. Deliberately plain: this is a way through to a conversation, not a place to sit.
 */
import { ScrollView, View } from "react-native";
import { useLive } from "../store";
import { space } from "../theme";
import { Badge, Body, Card, Heading, useColors, when } from "../ui";
import { Screen, Title } from "./chrome";

export function ChannelsScreen({
  onOpenChannel,
}: {
  onOpenChannel: (id: string) => void;
}) {
  const colors = useColors();
  const channels = useLive((source) => source.channels());

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Title text="Channels" detail="The Bots you are working with." />
        {(channels ?? []).map((channel) => (
          <Card key={channel.id} onPress={() => onOpenChannel(channel.id)}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
              }}
            >
              <Heading>{channel.name}</Heading>
              {channel.pendingApprovals > 0 ? (
                <Badge tone="pending">{channel.pendingApprovals} waiting</Badge>
              ) : null}
              {channel.busy ? <Badge tone="quiet">Working</Badge> : null}
            </View>
            <Body muted>{channel.lastMessage ?? "Nothing said yet."}</Body>
            {channel.lastMessageAt ? (
              <Body muted>{when(channel.lastMessageAt)}</Body>
            ) : null}
          </Card>
        ))}
        <View
          style={{ height: space.xl, backgroundColor: colors.background }}
        />
      </ScrollView>
    </Screen>
  );
}
