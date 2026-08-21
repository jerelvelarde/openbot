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
import { ApiError } from "../data/http";
import type { LiveTurn, Message, Skill, ToolLine } from "../data/types";
import { useLiveResult, useSource } from "../store";
import { radius, space, type as type_ } from "../theme";
import {
  Badge,
  Body,
  Button,
  intentPhrase,
  Label,
  OUTCOME_WORDS,
  OutcomeDot,
  Row,
  Rule,
  richText,
  subjectPhrase,
  useColors,
} from "../ui";
import { Screen, TopBar } from "./chrome";

function ToolLineView({ line }: { line: ToolLine }) {
  const colors = useColors();
  return (
    <View style={{ gap: space.xs, paddingLeft: space.xs }}>
      <View
        style={{ flexDirection: "row", gap: space.sm, alignItems: "baseline" }}
      >
        <OutcomeDot outcome={line.outcome} />
        <View style={{ flex: 1 }}>
          <Text style={{ ...type_.small, fontSize: 13, color: colors.muted }}>
            <Text style={{ fontWeight: "600", color: colors.foreground }}>
              {line.label}
            </Text>
            {/* Without a detail the outcome is carried by an 8px dot and nothing else, so a plugin
                call that failed and one that worked are the same line in two colours. */}
            {line.detail
              ? ` · ${line.detail}`
              : line.outcome === "allowed" || line.outcome === "running"
                ? ""
                : ` · ${OUTCOME_WORDS[line.outcome] ?? line.outcome}`}
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

function Bubble({
  message,
  botName,
  dimmed,
}: {
  message: Message;
  botName: string;
  /** Said, but not yet acknowledged by the deployment. */
  dimmed?: boolean;
}) {
  const colors = useColors();
  const mine = message.role === "user";
  return (
    <View
      accessible
      accessibilityLabel={`${mine ? "You said" : `${botName} said`}: ${
        message.text ?? ""
      }${message.queued ? ". Queued, it will be picked up when the Bot settles" : ""}`}
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
        opacity: dimmed ? 0.55 : 1,
      }}
    >
      <Text
        style={{
          ...type_.body,
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
 * here in one place rather than cast at the point of use. The concept of focus is not deleted with
 * it — the pill takes a border instead, because the web build is driven with a keyboard.
 */
const NO_FOCUS_RING = (
  Platform.OS === "web" ? { outlineStyle: "none" } : {}
) as TextStyle;

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
  /**
   * Loaded, empty and failed are three different things.
   *
   * They were one. A failed read rendered a conversation with no messages, a title reading the
   * literal "Channel", an avatar seeded on the thread id — a different face — and a composer inviting
   * somebody to talk into it. A parked approval in that very channel silently did not appear.
   */
  const { value: channel, error: channelError } = useLiveResult((s) =>
    s.channel(channelId).then((found) => found ?? null),
  );
  const { value: messages, error: messagesError } = useLiveResult((s) =>
    s.messages(channelId),
  );
  const { value: approvals } = useLiveResult((s) => s.approvals());
  const [draft, setDraft] = useState("");
  /** What went wrong sending, in the words the source used. Cleared on the next attempt, or on typing. */
  const [sendError, setSendError] = useState<string | null>(null);
  /** Said, and not yet in the thread the deployment returns. */
  const [sending, setSending] = useState<string | null>(null);
  /**
   * The reply as it is being written.
   *
   * Screen state rather than source state: it is one in-flight request that this screen started, and
   * announcing a re-read of the whole thread on every token would put a network call behind every
   * character. The durable thread takes over the moment it has the turn.
   */
  const [live, setLive] = useState<LiveTurn | null>(null);
  /** `/` skills chosen for the next message. Chips, not text: see the composer. */
  const [chips, setChips] = useState<Skill[]>([]);

  const { value: skills } = useLiveResult((s) => s.skills(channelId));
  const scroller = useRef<ScrollView>(null);
  const nearBottom = useRef(true);
  const settled = useRef(false);

  const loading = channel === undefined || messages === undefined;
  const failed = channelError ?? messagesError;

  /**
   * Follow the conversation, unless somebody is reading it.
   *
   * Scrolling on content growth rather than on a timer, because a timer fires before the new bubble
   * has been laid out — so the message you just sent stayed clipped behind the composer until an
   * unrelated poll happened to scroll again. And only when already at the bottom: during a run every
   * tool result is its own message, and yanking somebody out of the history they scrolled up to read,
   * once a second, is worse than not following at all.
   */
  const follow = () => {
    if (!nearBottom.current) return;
    scroller.current?.scrollToEnd({ animated: settled.current });
    settled.current = true;
  };

  // The message left the phone; the thread now has it. Stop drawing the local copy.
  useEffect(() => {
    if (!sending) return;
    if ((messages ?? []).some((m) => m.role === "user" && m.text === sending)) {
      setSending(null);
    }
  }, [messages, sending]);

  /**
   * Hand the finished turn over to the thread.
   *
   * Held until the durable copy actually arrives rather than dropped when the run ends, because the
   * gap between the two is a poll away and clearing early makes the reply vanish and come back.
   */
  useEffect(() => {
    if (!live?.done || !live.text) return;
    if (
      (messages ?? []).some(
        (m) => m.role === "assistant" && m.text === live.text,
      )
    ) {
      setLive(null);
    }
  }, [live, messages]);

  const waiting = (approvals ?? []).find(
    (one) => one.state === "pending" && one.channelId === channelId,
  );

  const streaming = Boolean(live && !live.done);

  const send = () => {
    const text = draft.trim();
    if (!text || sending || streaming) return;
    const chosen = chips;
    setDraft("");
    setSendError(null);
    setSending(text);
    setChips([]);
    setLive({ text: "", toolLines: [], done: false });
    void source
      .send(channelId, text, { skills: chosen, onTurn: setLive })
      .catch((cause: unknown) => {
        setSending(null);
        setLive(null);
        setChips(chosen);
        // Only if nothing has been typed since. Restoring unconditionally, seconds later, wrote over
        // whatever was in the field by then.
        setDraft((current) => current || text);
        setSendError(describeSendFailure(cause));
      });
  };

  /** A draft that is only a slash query is the menu being opened, not a message being written. */
  const query = /^\/(\S*)$/.exec(draft)?.[1]?.toLowerCase();
  const offered =
    query === undefined
      ? []
      : (skills ?? []).filter(
          (skill) =>
            !chips.some((chip) => chip.slug === skill.slug) &&
            (skill.slug.includes(query) ||
              skill.title.toLowerCase().includes(query)),
        );

  const composerDisabled = Boolean(failed) || channel === null;

  return (
    <Screen>
      <TopBar
        leading={
          channel ? (
            <BotAvatar seed={channel.botId} size={28} />
          ) : (
            // Reserved, so the title does not jump sideways when the read lands.
            <View style={{ width: 28, height: 28 }} />
          )
        }
        onBack={onBack}
        right={
          // "Working" is derived from a parked approval, so it used to appear in the top bar of the
          // screen whose card below says the Bot is blocked on you. Say the true one.
          waiting ? (
            <Badge tone="pending">Waiting on you</Badge>
          ) : channel?.busy ? (
            <Badge tone="quiet">Working</Badge>
          ) : undefined
        }
        title={channel?.name ?? (channel === null ? "Gone" : "…")}
      />
      <KeyboardAvoidingView
        // Undefined on Android meant no adjustment at all, and under this SDK's edge-to-edge the
        // keyboard is an overlay rather than a window resize — so it covered the composer, the send
        // button and the error line while somebody typed an instruction to a Bot driving a browser.
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        {/* Pinned, not scrolled. As child zero of a transcript that scrolls itself to the bottom,
            the one thing this screen exists to surface was off-screen on any thread taller than the
            viewport — including for somebody who arrived by tapping "1 waiting". */}
        {waiting ? (
          <View
            style={{
              backgroundColor: colors.card,
              borderBottomColor: colors.border,
              borderBottomWidth: 1,
              padding: space.lg,
              gap: space.md,
            }}
          >
            <Label>Waiting on you</Label>
            <Body>
              {waiting.botName} needs approval to {intentPhrase(waiting.intent)}{" "}
              {subjectPhrase(waiting.subject)}.
            </Body>
            <Button
              onPress={() => onOpenApproval(waiting.id)}
              title="Review it"
            />
          </View>
        ) : null}

        <ScrollView
          contentContainerStyle={{ padding: space.lg, gap: space.md }}
          keyboardDismissMode={
            Platform.OS === "ios" ? "interactive" : "on-drag"
          }
          // Without this the first tap on "Review it" with the keyboard up only closes the keyboard.
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={follow}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } =
              event.nativeEvent;
            nearBottom.current =
              contentSize.height - contentOffset.y - layoutMeasurement.height <
              48;
          }}
          ref={scroller}
          scrollEventThrottle={16}
          /**
           * Bounded, so "the end" is the end.
           *
           * Without a flex the transcript sizes to its content inside the column, overflowing behind
           * the composer — and `scrollToEnd` then lands at the bottom of a box whose bottom is not
           * on screen, which is why a message you had just sent stayed half-hidden.
           */
          style={{ flex: 1 }}
        >
          {failed ? (
            <View
              style={{
                backgroundColor: colors.cardMuted,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: radius.md,
                padding: space.lg,
                gap: space.sm,
              }}
            >
              <Label>Offline</Label>
              <Body muted>{failed}</Body>
              <Body muted>
                Anything below is the last thing this app was told, and there
                may be more it has not seen.
              </Body>
            </View>
          ) : null}

          {loading && !failed ? (
            <Body muted>Loading this conversation…</Body>
          ) : null}
          {channel === null ? <Body muted>That channel is gone.</Body> : null}
          {channel && !loading && !failed && (messages ?? []).length === 0 ? (
            <Body muted>
              Nothing has been said here yet. What you say goes to{" "}
              {channel?.botName ?? "this Bot"}, which acts on it and reports
              back.
            </Body>
          ) : null}

          {(messages ?? []).map((message) => (
            <View key={message.id} style={{ gap: space.sm }}>
              {message.text ? (
                <Bubble
                  botName={channel?.botName ?? "The Bot"}
                  message={message}
                />
              ) : null}
              {message.toolLines?.map((line) => (
                <ToolLineView
                  key={`${message.id}:${line.label}:${line.detail ?? ""}`}
                  line={line}
                />
              ))}
            </View>
          ))}

          {/* Your own words, before the deployment has confirmed them. Without this the composer
              emptied and nothing appeared anywhere until the next poll. */}
          {sending ? (
            <Bubble
              botName={channel?.botName ?? "The Bot"}
              dimmed
              message={{
                id: "sending",
                role: "user",
                text: sending,
                at: new Date().toISOString(),
              }}
            />
          ) : null}
          {/* The reply, arriving. Drawn exactly like a settled turn — same bubble, same tool lines
              — so nothing shifts or restyles when the durable thread takes over. */}
          {live && (live.text || live.toolLines.length > 0) ? (
            <View style={{ gap: space.sm }}>
              {live.text ? (
                <Bubble
                  botName={channel?.botName ?? "The Bot"}
                  message={{
                    id: "live",
                    role: "assistant",
                    text: live.text,
                    at: new Date().toISOString(),
                  }}
                />
              ) : null}
              {live.toolLines.map((line) => (
                <ToolLineView key={line.id ?? line.label} line={line} />
              ))}
            </View>
          ) : null}

          {live?.failure ? (
            <Text style={{ ...type_.small, color: colors.refuse }}>
              {live.failure}
            </Text>
          ) : null}

          {sending && !live?.text && live?.toolLines.length === 0 ? (
            <Text style={{ ...type_.small, color: colors.muted }}>
              Sending…
            </Text>
          ) : null}
          {streaming && (live?.text || live?.toolLines.length) ? (
            <Text style={{ ...type_.small, color: colors.muted }}>
              {channel?.botName ?? "The Bot"} is working…
            </Text>
          ) : null}
        </ScrollView>

        {sendError ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingHorizontal: space.lg,
              paddingTop: space.sm,
              backgroundColor: colors.card,
            }}
          >
            <Text style={{ ...type_.small, color: colors.refuse, flex: 1 }}>
              {sendError}
            </Text>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={send}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <Text
                style={{
                  ...type_.small,
                  fontWeight: "600",
                  color: colors.foreground,
                }}
              >
                Try again
              </Text>
            </Pressable>
          </View>
        ) : null}

        {offered.length > 0 ? (
          <View
            style={{
              backgroundColor: colors.card,
              borderTopColor: colors.border,
              borderTopWidth: 1,
              paddingHorizontal: space.lg,
            }}
          >
            <Label>Skills</Label>
            {offered.map((skill) => (
              <Row
                detail={skill.summary ?? skill.title}
                key={skill.slug}
                label={`${skill.title}. ${skill.summary ?? ""}`}
                lines={2}
                onPress={() => {
                  setChips((current) => [...current, skill]);
                  setDraft("");
                }}
                title={skill.title}
              />
            ))}
          </View>
        ) : null}

        {chips.length > 0 ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: space.sm,
              paddingHorizontal: space.md,
              paddingTop: space.sm,
              backgroundColor: colors.card,
            }}
          >
            {chips.map((skill) => (
              /* A chip, not the skill's paragraph pasted into the box. What it stands for goes to
                 the Bot as a system turn in front of the message; what stays on screen is one token
                 saying which skill was used. */
              <Pressable
                accessibilityHint="Removes this skill"
                accessibilityLabel={`${skill.title} skill`}
                accessibilityRole="button"
                key={skill.slug}
                onPress={() =>
                  setChips((current) =>
                    current.filter((one) => one.slug !== skill.slug),
                  )
                }
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: colors.cardMuted,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: radius.pill,
                  paddingVertical: 5,
                  paddingHorizontal: 11,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text
                  style={{
                    ...type_.small,
                    fontWeight: "600",
                    color: colors.foreground,
                  }}
                >
                  /{skill.slug}
                </Text>
                <Text style={{ ...type_.small, color: colors.muted }}>✕</Text>
              </Pressable>
            ))}
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
            alignItems: "flex-end",
          }}
        >
          <Composer
            botName={channel?.botName}
            disabled={composerDisabled}
            draft={draft}
            onChange={(text) => {
              setDraft(text);
              if (sendError) setSendError(null);
            }}
            hasSkills={(skills ?? []).length > 0}
            onSend={send}
            sending={Boolean(sending) || streaming}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The two errors a person can actually cause, in words rather than in the runtime's own. */
function describeSendFailure(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 409) {
    return "That Bot is still working on your last message. It will pick this up when it settles.";
  }
  if (cause instanceof Error) return cause.message;
  return "That could not be sent.";
}

function Composer({
  botName,
  draft,
  onChange,
  onSend,
  sending,
  disabled,
  hasSkills,
}: {
  botName: string | undefined;
  draft: string;
  onChange: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled: boolean;
  /** Whether to say the `/` menu exists. Promising it when the Bot has no skills would be a lie. */
  hasSkills: boolean;
}) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  const ready = Boolean(draft.trim()) && !sending && !disabled;

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "flex-end",
        gap: space.sm,
        backgroundColor: colors.cardMuted,
        borderColor: focused ? colors.pending : colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingLeft: 14,
        paddingRight: 4,
      }}
    >
      <TextInput
        editable={!disabled}
        // A single line meant anything past about six words scrolled out of sight — in a message
        // about to drive somebody's live portal. It starts one line tall: react-native-web renders a
        // textarea, whose own default is two.
        multiline
        numberOfLines={1}
        onBlur={() => setFocused(false)}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        /**
         * Enter sends, in a browser only.
         *
         * A multiline input has no submit key on a phone — Enter is a newline, which is what every
         * messaging app does and what the send button is for. But the web build is driven with a
         * keyboard, and react-native-web will not call `onSubmitEditing` for a multiline field
         * unless it also blurs it. Handling the key here runs before its own logic and stops it, so
         * the composer keeps focus and Shift+Enter still starts a new line.
         */
        onKeyPress={
          Platform.OS === "web"
            ? (event) => {
                const key = event as unknown as {
                  key?: string;
                  shiftKey?: boolean;
                  preventDefault?: () => void;
                };
                if (key.key !== "Enter" || key.shiftKey) return;
                key.preventDefault?.();
                onSend();
              }
            : undefined
        }
        onSubmitEditing={onSend}
        /**
         * Always the same invitation.
         *
         * It used to say "this will be queued" while a Bot was busy, which only the local source
         * actually does — against a real deployment a message sent now starts another turn. A
         * message that reports itself as queued when it was not is the one thing a composer must
         * never say, so the promise is made by the message afterwards, where it can be true.
         */
        placeholder={
          disabled
            ? "Not connected"
            : hasSkills
              ? `Ask ${botName ?? "this Bot"}, or / for a skill`
              : `Ask ${botName ?? "this Bot"}`
        }
        placeholderTextColor={colors.muted}
        returnKeyType="send"
        style={{
          flex: 1,
          ...type_.body,
          color: colors.foreground,
          paddingVertical: 11,
          maxHeight: 110,
          ...NO_FOCUS_RING,
        }}
        // Keeps the keyboard up after sending, which is what every other messaging app does and what
        // the send button already did.
        submitBehavior="submit"
        value={draft}
      />
      <Pressable
        accessibilityLabel="Send"
        accessibilityRole="button"
        accessibilityState={{ disabled: !ready }}
        disabled={!ready}
        // 40, not 34: below both Apple's 44pt and Material's 48dp this sat directly above the
        // Activity tab, and a low tap changed tab and threw the draft away. hitSlop is native-only,
        // so the box itself has to be big enough for the browser too.
        hitSlop={6}
        onPress={onSend}
        style={({ pressed }) => ({
          width: 40,
          height: 40,
          marginBottom: 2,
          borderRadius: 20,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.primary,
          opacity: ready ? (pressed ? 0.8 : 1) : 0.25,
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
  );
}
