/**
 * One conversation, and the ability to steer it.
 *
 * Tool calls render as compact lines, never as interactive UI. The phone is not where somebody takes
 * the wheel of a browser or approves a component; it is where they read what happened and say the
 * next thing. A refusal carries the rule that caused it, because "blocked" without the rule sends a
 * person hunting through Boundaries for something they cannot name.
 */
import { useEffect, useRef, useState } from "react";
import type { TextStyle } from "react-native";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { BotAvatar } from "../avatar";
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
  richText,
  useColors,
} from "../ui";
import { Screen, TopBar } from "./chrome";

function ToolLineView({ line }: { line: ToolLine }) {
  const colors = useColors();
  return (
    <View style={{ gap: space.xs, paddingLeft: space.xs }}>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <OutcomeDot outcome={line.outcome} />
        <View style={{ flex: 1 }}>
          <Text style={{ ...type_.small, fontSize: 13, color: colors.muted }}>
            <Text style={{ fontWeight: "600", color: colors.foreground }}>
              {line.label}
            </Text>
            {line.detail ? ` · ${line.detail}` : ""}
            {line.outcome === "running" ? " …" : ""}
          </Text>
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
        maxWidth: "86%",
        alignSelf: mine ? "flex-end" : "flex-start",
        backgroundColor: mine ? colors.primary : colors.cardMuted,
        borderRadius: radius.lg,
        // The corner nearest its own side is tightened, which is what makes a row of bubbles read as
        // a conversation rather than a stack of cards.
        borderBottomRightRadius: mine ? 6 : radius.lg,
        borderBottomLeftRadius: mine ? radius.lg : 6,
        paddingVertical: 11,
        paddingHorizontal: 15,
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
        {richText(message.text ?? "")}
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

/**
 * The focus ring a browser draws around a text input, removed.
 *
 * No phone has one, and it makes the composer look like a web form in a recording. `outlineStyle` is
 * a react-native-web property that React Native's own style types do not carry, so it is asserted
 * here in one place rather than cast at the point of use.
 */
const NO_FOCUS_RING = (
  Platform.OS === "web" ? { outlineStyle: "none" } : {}
) as TextStyle;

/** The plus and the microphone. Marks rather than glyphs, so no icon font is needed. */
function Plus({ color }: { color: string }) {
  return (
    <View style={{ width: 16, height: 16, justifyContent: "center" }}>
      <View style={{ height: 2, borderRadius: 1, backgroundColor: color }} />
      <View
        style={{
          position: "absolute",
          left: 7,
          width: 2,
          height: 16,
          borderRadius: 1,
          backgroundColor: color,
        }}
      />
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
    // A message that could not be sent is said out loud. A person believing they sent something they
    // did not is the worst outcome available here.
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
        leading={<BotAvatar seed={channel?.botId ?? channelId} size={28} />}
        onBack={onBack}
        right={channel?.busy ? <Badge tone="quiet">Working</Badge> : undefined}
        title={channel?.name ?? "Channel"}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ padding: space.lg, gap: space.md }}
          ref={scroller}
        >
          {waiting ? (
            <View
              style={{
                backgroundColor: colors.card,
                borderColor: colors.pending,
                borderWidth: 1,
                borderRadius: radius.md,
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
                onPress={() => onOpenApproval(waiting.id)}
                title="Review it"
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
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            backgroundColor: colors.card,
            alignItems: "center",
          }}
        >
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              backgroundColor: colors.cardMuted,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.pill,
              paddingLeft: 14,
              paddingRight: 6,
            }}
          >
            <Plus color={colors.muted} />
            <TextInput
              onChangeText={setDraft}
              onSubmitEditing={send}
              placeholder={
                channel?.busy
                  ? "It is working — this will be queued"
                  : `Ask ${channel?.botName ?? "this Bot"}`
              }
              placeholderTextColor={colors.muted}
              style={{
                flex: 1,
                ...type_.body,
                color: colors.foreground,
                paddingVertical: 11,
                ...NO_FOCUS_RING,
              }}
              value={draft}
            />
            <Pressable
              accessibilityLabel="Send"
              accessibilityRole="button"
              disabled={!draft.trim()}
              onPress={send}
              style={({ pressed }) => ({
                width: 34,
                height: 34,
                borderRadius: 17,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.primary,
                opacity: draft.trim() ? (pressed ? 0.8 : 1) : 0.25,
              })}
            >
              {/* An upward chevron: the arrow every composer has. */}
              <View
                style={{
                  width: 9,
                  height: 9,
                  borderTopWidth: 2,
                  borderRightWidth: 2,
                  borderColor: colors.primaryForeground,
                  transform: [{ rotate: "-45deg" }],
                  marginBottom: 2,
                }}
              />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
