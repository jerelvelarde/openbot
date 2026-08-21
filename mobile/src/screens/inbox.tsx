/**
 * The home screen, and the reason the app exists.
 *
 * Not a chat list. What is waiting on a person goes first and everything else is secondary, because
 * the companion is for the half of OpenBot that happens while nobody is watching: a parked approval,
 * a Bot with a question, a routine that failed.
 */
import { ScrollView, Text, View } from "react-native";
import { BotAvatar, BotAvatarWithDot } from "../avatar";
import type { Notification } from "../data/types";
import { useLiveResult, useSource } from "../store";
import { radius, space, type as type_ } from "../theme";
import {
  Body,
  Button,
  Card,
  Divider,
  intentPhrase,
  Label,
  Row,
  sentence,
  subjectPhrase,
  useColors,
  when,
} from "../ui";
import { Screen, Title } from "./chrome";

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
  // Kept, not discarded: an approvals-succeeded / notifications-failed poll used to render the app's
  // strongest all-clear on top of a read it knew had failed.
  const { value: notifications, error: newsError } = useLiveResult((source) =>
    source.notifications(),
  );
  const source = useSource();

  const waiting = (approvals ?? []).filter((one) => one.state === "pending");
  const news = (notifications ?? []).filter(
    (one) =>
      one.kind !== "approval" || !waiting.some((a) => a.id === one.approvalId),
  );
  const trouble = error ?? newsError;

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
                  : `${waiting.length} approval${waiting.length === 1 ? " is" : "s are"} waiting on you.`
          }
        />

        {trouble ? (
          <Card muted>
            <Label>Offline</Label>
            <Body muted>{trouble}</Body>
            <Body muted>
              What you can see below is the last thing this app was told, which
              may be out of date.
            </Body>
            <Button
              onPress={() => source.refresh()}
              title="Try again"
              tone="quiet"
            />
          </Card>
        ) : null}

        {waiting.length > 0 ? (
          <View style={{ gap: space.md }}>
            {waiting.map((approval) => (
              <Card
                accent
                hint="Opens the approval"
                key={approval.id}
                label={`${approval.botName} wants to ${intentPhrase(approval.intent)} ${subjectPhrase(approval.subject)}`}
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
                    ring={colors.card}
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
                  wants to {intentPhrase(approval.intent)}{" "}
                  {subjectPhrase(approval.subject)}
                </Body>
                {/* The one call to action on the screen, drawn as a bar rather than a button so the
                    whole card stays the tap target — and hidden from the accessibility tree, which
                    already has the card itself as one button. */}
                <View
                  importantForAccessibility="no-hide-descendants"
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
            {/* Not "Earlier": on a live deployment this list is exactly the approvals that have been
                settled, and it is the only bucket, so it groups nothing by time. */}
            <Label>Recently answered</Label>
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
                    label={sentence(
                      `${note.botName} ${note.body}`,
                      when(note.at),
                    )}
                    leading={
                      <BotAvatarWithDot
                        dot={
                          note.kind === "refused" || note.kind === "expired"
                            ? colors.refuse
                            : note.kind === "routine-failed"
                              ? colors.fail
                              : colors.allow
                        }
                        ring={colors.card}
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

        {newsError && news.length === 0 ? (
          <View style={{ gap: space.sm }}>
            <Label>Recently answered</Label>
            <Body muted>Could not load what happened earlier.</Body>
          </View>
        ) : null}

        {/* Only when the deployment answered BOTH reads. The all-clear is the strongest claim this
            app makes, and it was being made on top of a failure. */}
        {waiting.length === 0 &&
        news.length === 0 &&
        approvals !== undefined &&
        notifications !== undefined &&
        !trouble ? (
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
