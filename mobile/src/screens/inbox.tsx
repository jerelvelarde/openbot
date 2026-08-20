/**
 * The home screen, and the reason the app exists.
 *
 * Not a chat list. What is waiting on a person goes first and everything else is secondary, because
 * the companion is for the half of OpenBot that happens while nobody is watching: a parked approval,
 * a Bot with a question, a routine that failed.
 */
import { ScrollView, View } from "react-native";
import type { Approval, Notification } from "../data/types";
import { useLive, useSource } from "../store";
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
  const subject = approval.subject;
  if (subject.kind === "element")
    return `“${subject.label}” on ${subject.host}`;
  if (subject.kind === "page") return `open ${subject.host}`;
  if (subject.kind === "file") return subject.path;
  return `${subject.tool} on ${subject.server}`;
}

export function InboxScreen({
  onOpenApproval,
  onOpenChannel,
}: {
  onOpenApproval: (id: string) => void;
  onOpenChannel: (id: string) => void;
}) {
  const colors = useColors();
  const approvals = useLive((source) => source.approvals());
  const notifications = useLive((source) => source.notifications());
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
            waiting.length === 0
              ? "Nothing is waiting on you."
              : `${waiting.length} thing${waiting.length === 1 ? "" : "s"} waiting on you.`
          }
        />

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
                      note.kind === "routine-failed" ? "failed" : "allowed"
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
