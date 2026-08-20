/**
 * The home screen, and the reason the app exists.
 *
 * Not a chat list. What is waiting on a person goes first and everything else is secondary, because
 * the companion is for the half of OpenBot that happens while nobody is watching: a parked approval,
 * a Bot with a question, a routine that failed.
 */
import { ScrollView, View } from "react-native";
import type { Approval, Notification } from "../data/types";
import { useLiveResult, useSource } from "../store";
import { space } from "../theme";
import {
  Badge,
  Body,
  Card,
  Heading,
  Label,
  OutcomeDot,
  useColors,
  when,
} from "../ui";
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
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
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

        {waiting.map((approval) => (
          <Card key={approval.id} onPress={() => onOpenApproval(approval.id)}>
            <View
              style={{
                flexDirection: "row",
                gap: space.sm,
                alignItems: "center",
              }}
            >
              <Badge tone="pending">Needs you</Badge>
              <Body muted>{when(approval.askedAt)}</Body>
            </View>
            <Heading>{approval.botName}</Heading>
            <Body>
              wants to {approval.intent} {subjectLine(approval)}
            </Body>
          </Card>
        ))}

        {news.length > 0 ? (
          <View style={{ gap: space.sm }}>
            <Label>Earlier</Label>
            {news.map((note: Notification) => (
              <Card
                key={note.id}
                muted
                onPress={() => {
                  void source.markRead(note.id);
                  if (note.approvalId) onOpenApproval(note.approvalId);
                  else if (note.channelId) onOpenChannel(note.channelId);
                }}
              >
                <View style={{ flexDirection: "row", gap: space.md }}>
                  <OutcomeDot
                    outcome={
                      note.kind === "refused"
                        ? "refused"
                        : note.kind === "routine-failed"
                          ? "failed"
                          : "allowed"
                    }
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Body>
                      {note.botName} {note.body}
                    </Body>
                    <Body muted>{when(note.at)}</Body>
                  </View>
                </View>
              </Card>
            ))}
          </View>
        ) : null}

        {waiting.length === 0 &&
        news.length === 0 &&
        approvals !== undefined ? (
          <Card muted>
            <Body muted>
              Nothing has needed you today. Bots carry on working, and this is
              where they come when they cannot.
            </Body>
          </Card>
        ) : null}

        <View
          style={{ height: space.xl, backgroundColor: colors.background }}
        />
      </ScrollView>
    </Screen>
  );
}
