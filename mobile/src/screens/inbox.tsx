/**
 * The home screen, and the reason the app exists.
 *
 * Not a chat list. What is waiting on a person goes first and everything else is secondary, because
 * the companion is for the half of OpenBot that happens while nobody is watching: a parked approval,
 * a Bot with a question, a routine that failed.
 */
import { ScrollView, Text, View } from "react-native";
import { BotAvatar, BotAvatarWithDot } from "../avatar";
import type { Approval, Notification } from "../data/types";
import { useLiveResult, useSource } from "../store";
import { radius, space, type as type_ } from "../theme";
import { Body, Card, Divider, Label, Row, useColors, when } from "../ui";
import { Screen, Title } from "./chrome";

function subjectLine(approval: Approval): string {
  const { kind, label, host } = approval.subject;
  if (kind === "file") return label;
  const named = kind === "element" ? `“${label}”` : label;
  return host ? `${named} on ${host}` : named;
}

export function InboxScreen({
  onOpenApproval,
  onOpenChannel,
}: {
  onOpenApproval: (id: string) => void;
  onOpenChannel: (id: string) => void;
}) {
  const colors = useColors();
  const { value: approvals, error } = useLiveResult((source) =>
    source.approvals(),
  );
  const { value: notifications } = useLiveResult((source) =>
    source.notifications(),
  );
  const source = useSource();

  const waiting = (approvals ?? []).filter((one) => one.state === "pending");
  const news = (notifications ?? []).filter(
    (one) =>
      one.kind !== "approval" || !waiting.some((a) => a.id === one.approvalId),
  );

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
          text="Inbox"
          detail={
            // "Nothing is waiting" is a claim about the deployment, so it is only made when the
            // deployment actually answered. Otherwise the state is unknown, and it says so.
            error
              ? "Could not reach this deployment."
              : approvals === undefined
                ? "Checking…"
                : waiting.length === 0
                  ? "Nothing is waiting on you."
                  : `${waiting.length} thing${waiting.length === 1 ? "" : "s"} waiting on you.`
          }
        />

        {error ? (
          <Card muted>
            <Label>Offline</Label>
            <Body muted>{error}</Body>
            <Body muted>
              What you can see below is the last thing this app was told, which
              may be out of date.
            </Body>
          </Card>
        ) : null}

        {waiting.length > 0 ? (
          <View style={{ gap: space.md }}>
            {waiting.map((approval) => (
              <Card
                accent
                key={approval.id}
                onPress={() => onOpenApproval(approval.id)}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.md,
                  }}
                >
                  <BotAvatarWithDot
                    dot={colors.pending}
                    seed={approval.botId}
                    size={40}
                  />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text
                      style={{ ...type_.heading, color: colors.foreground }}
                    >
                      {approval.botName}
                    </Text>
                    <Text style={{ ...type_.small, color: colors.pending }}>
                      Needs you · {when(approval.askedAt)}
                    </Text>
                  </View>
                </View>
                <Body>
                  wants to {approval.intent} {subjectLine(approval)}
                </Body>
                {/* The one call to action on the screen, drawn as a bar rather than a button so the
                    whole card stays the tap target. */}
                <View
                  style={{
                    marginTop: space.xs,
                    borderRadius: radius.pill,
                    backgroundColor: colors.primary,
                    paddingVertical: 11,
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      ...type_.body,
                      fontWeight: "600",
                      color: colors.primaryForeground,
                    }}
                  >
                    Review it
                  </Text>
                </View>
              </Card>
            ))}
          </View>
        ) : null}

        {news.length > 0 ? (
          <View style={{ gap: space.sm }}>
            <Label>Earlier</Label>
            <View
              style={{
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: radius.md,
                paddingHorizontal: space.lg,
              }}
            >
              {news.map((note: Notification, index) => (
                <View key={note.id}>
                  {index > 0 ? <Divider inset={44} /> : null}
                  <Row
                    detail={note.body}
                    leading={
                      <BotAvatarWithDot
                        dot={
                          note.kind === "refused"
                            ? colors.refuse
                            : note.kind === "routine-failed"
                              ? colors.fail
                              : colors.allow
                        }
                        seed={note.botId}
                        size={32}
                      />
                    }
                    lines={2}
                    meta={when(note.at)}
                    onPress={() => {
                      void source.markRead(note.id);
                      if (note.approvalId) onOpenApproval(note.approvalId);
                      else if (note.channelId) onOpenChannel(note.channelId);
                    }}
                    title={note.botName}
                  />
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {waiting.length === 0 &&
        news.length === 0 &&
        approvals !== undefined ? (
          <View style={{ alignItems: "center", gap: space.md, paddingTop: 64 }}>
            <View style={{ opacity: 0.35 }}>
              <BotAvatar seed="openbot" size={56} />
            </View>
            <Body muted>Nothing has needed you today.</Body>
            <View style={{ paddingHorizontal: space.xl }}>
              <Text
                style={{
                  ...type_.body,
                  color: colors.muted,
                  textAlign: "center",
                  lineHeight: 21,
                }}
              >
                Bots carry on working, and this is where they come when they
                cannot.
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
