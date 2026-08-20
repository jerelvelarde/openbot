/**
 * One conversation, and the ability to steer it.
 *
 * Tool calls render as compact lines, never as interactive UI. The phone is not where somebody takes
 * the wheel of a browser or approves a component; it is where they read what happened and say the
 * next thing. A refusal carries the rule that caused it, because "blocked" without the rule sends a
 * person hunting through Boundaries for something they cannot name.
 */
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Message, ToolLine } from "../data/types";
import { useLive, useSource } from "../store";
import { radius, space, type as type_ } from "../theme";
import {
  Badge,
  Body,
  Button,
  Label,
  OutcomeDot,
  Rule,
  useColors,
  when,
} from "../ui";
import { Screen, TopBar } from "./chrome";

function ToolLineView({ line }: { line: ToolLine }) {
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <OutcomeDot outcome={line.outcome} />
        <View style={{ flex: 1 }}>
          <Body muted>
            {line.label}
            {line.detail ? ` · ${line.detail}` : ""}
            {line.outcome === "running" ? " …" : ""}
          </Body>
        </View>
      </View>
      {/* The rule travels with the refusal, so the boundary can be found and edited. */}
      {line.rule ? (
        <View style={{ paddingLeft: space.lg }}>
          <Rule>{line.rule}</Rule>
        </View>
      ) : null}
    </View>
  );
}

function Bubble({ message }: { message: Message }) {
  const colors = useColors();
  const mine = message.role === "user";
  return (
    <View
      style={{
        maxWidth: "90%",
        alignSelf: mine ? "flex-end" : "flex-start",
        backgroundColor: mine ? colors.primary : colors.card,
        borderColor: mine ? colors.primary : colors.border,
        borderWidth: 1,
        borderRadius: radius,
        paddingVertical: space.md,
        paddingHorizontal: space.lg,
        gap: space.xs,
      }}
    >
      <Text
        style={{
          ...type_.body,
          lineHeight: 21,
          color: mine ? colors.primaryForeground : colors.foreground,
        }}
      >
        {message.text}
      </Text>
      {message.queued ? (
        <Text
          style={{
            ...type_.small,
            color: mine ? colors.primaryForeground : colors.muted,
            opacity: 0.8,
          }}
        >
          Queued · it will pick this up when it settles
        </Text>
      ) : null}
    </View>
  );
}

export function ChannelScreen({
  channelId,
  onBack,
  onOpenApproval,
}: {
  channelId: string;
  onBack: () => void;
  onOpenApproval: (id: string) => void;
}) {
  const colors = useColors();
  const source = useSource();
  const channel = useLive((s) => s.channel(channelId));
  const messages = useLive((s) => s.messages(channelId));
  const approvals = useLive((s) => s.approvals());
  const [draft, setDraft] = useState("");
  /** What went wrong sending, in the words the source used. Cleared on the next attempt. */
  const [sendError, setSendError] = useState<string | null>(null);
  const scroller = useRef<ScrollView>(null);

  // Follow the conversation as it grows, and when the Bot settles: a transcript that has to be
  // scrolled by hand to see the reply you just caused is a transcript nobody reads on a phone.
  const messageCount = messages?.length ?? 0;
  const busy = channel?.busy ?? false;
  useEffect(() => {
    // Nothing to follow yet, and an empty transcript that scrolls itself looks like a glitch.
    if (messageCount === 0 && !busy) return;
    const timer = setTimeout(
      () => scroller.current?.scrollToEnd({ animated: true }),
      60,
    );
    return () => clearTimeout(timer);
  }, [messageCount, busy]);

  const waiting = (approvals ?? []).find(
    (one) => one.state === "pending" && one.channelId === channelId,
  );

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setSendError(null);
    // A message that could not be sent is said out loud. Against a live deployment starting a turn is
    // an AG-UI run rather than a REST call, and a person believing they sent something they did not
    // is the worst outcome available here.
    void source.send(channelId, text).catch((error: unknown) => {
      setDraft(text);
      setSendError(
        error instanceof Error ? error.message : "That could not be sent.",
      );
    });
  };

  return (
    <Screen>
      <TopBar
        title={channel?.name ?? "Channel"}
        onBack={onBack}
        right={channel?.busy ? <Badge tone="quiet">Working</Badge> : undefined}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          ref={scroller}
          contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        >
          {waiting ? (
            <View
              style={{
                backgroundColor: colors.card,
                borderColor: colors.pending,
                borderWidth: 1,
                borderRadius: radius,
                padding: space.lg,
                gap: space.md,
              }}
            >
              <Label>Waiting on you</Label>
              <Body>
                {waiting.botName} needs approval to {waiting.intent}{" "}
                {waiting.subject.kind === "element"
                  ? `“${waiting.subject.label}”`
                  : waiting.subject.label}
                .
              </Body>
              <Button
                title="Review it"
                onPress={() => onOpenApproval(waiting.id)}
              />
            </View>
          ) : null}

          {(messages ?? []).map((message) => (
            <View key={message.id} style={{ gap: space.sm }}>
              {message.text ? <Bubble message={message} /> : null}
              {message.toolLines?.map((line) => (
                <ToolLineView
                  key={`${message.id}:${line.label}:${line.detail ?? ""}`}
                  line={line}
                />
              ))}
              <Text
                style={{
                  ...type_.small,
                  color: colors.muted,
                  alignSelf:
                    message.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                {when(message.at)}
              </Text>
            </View>
          ))}
        </ScrollView>

        {sendError ? (
          <View
            style={{
              paddingHorizontal: space.lg,
              paddingTop: space.sm,
              backgroundColor: colors.card,
            }}
          >
            <Text style={{ ...type_.small, color: colors.fail }}>
              {sendError}
            </Text>
          </View>
        ) : null}
        <View
          style={{
            flexDirection: "row",
            gap: space.sm,
            padding: space.md,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            backgroundColor: colors.card,
            alignItems: "center",
          }}
        >
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={send}
            placeholder={
              channel?.busy
                ? "It is working — this will be queued"
                : "Say something"
            }
            placeholderTextColor={colors.muted}
            style={{
              flex: 1,
              ...type_.body,
              color: colors.foreground,
              backgroundColor: colors.cardMuted,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 10,
              paddingVertical: 11,
              paddingHorizontal: space.md,
            }}
          />
          <Button title="Send" onPress={send} disabled={!draft.trim()} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
