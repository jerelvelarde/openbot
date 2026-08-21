/**
 * One parked action, and the three answers to it.
 *
 * Everything on this screen is the SERVER's account of what is about to happen: the element label the
 * gateway resolved from its own snapshot, the host it is on, and the rule that stopped it. None of it
 * is the model's description of its own intention, because a screen that asked you to approve the
 * model's summary of what it was doing would be approving the one thing the policy exists not to
 * trust.
 */
import { useRef, useState } from "react";
import { AccessibilityInfo, ScrollView, View } from "react-native";
import { BotAvatar } from "../avatar";
import type { Approval } from "../data/types";
import { useLiveResult, useSource } from "../store";
import { space } from "../theme";
import {
  Badge,
  Body,
  Button,
  Card,
  Heading,
  intentPhrase,
  Label,
  Rule,
  useColors,
  when,
} from "../ui";
import { Screen, TopBar } from "./chrome";

function describe(approval: Approval): { what: string; where: string } {
  const { kind, label, host } = approval.subject;
  if (kind === "file") return { what: label, where: "its workspace" };
  if (kind === "mcp") {
    return { what: label, where: host ? `${host} (MCP)` : "an MCP server" };
  }
  /**
   * A `page` subject is not a page.
   *
   * It is what the gateway returns when it could not match the action to anything in the snapshot it
   * took, carrying the bare tool name as the label. Saying so plainly matters more here than
   * anywhere: this is the case where nobody — not the server, not the person answering — can say what
   * is about to be clicked.
   */
  if (kind === "page") {
    return {
      what: "something this deployment could not identify",
      where: host ?? "its computer",
    };
  }
  return { what: `“${label}”`, where: host ?? "its computer" };
}

/**
 * What "Always allow this" actually grants, in words.
 *
 * The server writes `bot.id == "<bot>" && contains(element.name, "<label>")` — a case-insensitive
 * substring, with **no host term in it**. So a screen that says "on portal.example" directly above
 * that button lets somebody believe they are granting one button on one site when they are granting
 * that Bot anything similarly labelled anywhere it can reach. This is the one place where the user's
 * model and the enforced rule diverge, on a security decision, so it is spelled out before the tap
 * rather than shown as a receipt afterwards.
 */
function alwaysMeans(approval: Approval): string {
  const { kind, label, host } = approval.subject;
  if (kind === "file") {
    return `From now on this Bot may act on the file ${label} without asking.`;
  }
  if (kind === "mcp") {
    return `From now on this Bot may call ${label}${host ? ` on ${host}` : ""} without asking.`;
  }
  if (kind === "page") {
    return "From now on this Bot may take this action without asking, including where the server cannot identify what it is acting on.";
  }
  return `From now on this Bot may act on anything labelled “${label}” without asking — on any site it can reach, not only ${host ?? "this one"}.`;
}

/**
 * How long is left, in the words somebody deciding actually needs.
 *
 * Hedged once the deadline has passed, because the server is the authority on whether an approval is
 * still open: a row that still says "pending" past its own `expiresAt` is one the deployment has not
 * reaped yet, and flatly announcing it is over would be this screen guessing at a state — the one
 * thing it exists not to do.
 */
function remaining(expiresAt: string): string | undefined {
  const left = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(left)) return undefined;
  if (left <= 0) return "The time to answer may have run out.";
  const minutes = Math.floor(left / 60_000);
  if (minutes < 1) return "Answerable for under a minute.";
  return `Answerable for another ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export function ApprovalScreen({
  approvalId,
  onBack,
  onOpenChannel,
}: {
  approvalId: string;
  onBack: () => void;
  onOpenChannel: (id: string) => void;
}) {
  const colors = useColors();
  const source = useSource();
  /**
   * Loading, missing and failed are three different things.
   *
   * They were one: `undefined` for all three, rendered as "That approval is no longer waiting." So
   * the first thing somebody woken by a push saw about a parked payment run was that it had already
   * been settled — and if the read failed, it said that permanently.
   */
  const { value: approval, error } = useLiveResult((s) =>
    s.approval(approvalId).then((found) => found ?? null),
  );
  const [pending, setPending] = useState<null | "once" | "always" | "deny">(
    null,
  );
  const [answerError, setAnswerError] = useState<string | null>(null);
  /** The one permanent answer asks twice. See {@link alwaysMeans}. */
  const [confirmingAlways, setConfirmingAlways] = useState(false);
  const scroller = useRef<ScrollView>(null);

  if (!approval) {
    return (
      <Screen>
        <TopBar onBack={onBack} title="Approval" />
        <View style={{ padding: space.lg, gap: space.md }}>
          {error ? (
            <Card muted>
              <Label>Could not be loaded</Label>
              <Body muted>{error}</Body>
              <Body muted>
                Nothing here can be answered until this deployment answers.
              </Body>
            </Card>
          ) : approval === undefined ? (
            <Body muted>Checking…</Body>
          ) : (
            <Body muted>That approval is no longer waiting.</Body>
          )}
        </View>
      </Screen>
    );
  }

  const { what, where } = describe(approval);
  const settled = approval.state !== "pending";
  const left =
    !settled && approval.expiresAt ? remaining(approval.expiresAt) : undefined;

  const answer = (decision: "allow" | "deny", scope: "once" | "always") => {
    setPending(decision === "deny" ? "deny" : scope);
    setAnswerError(null);
    void source.answer(approval.id, decision, scope).then(
      () => {
        setPending(null);
        // Back to the top, where the badge now says what was decided. Answering removes the buttons
        // and the page shrinks under you, so without this somebody is left looking at forensic
        // details with no visible confirmation that anything happened.
        scroller.current?.scrollTo({ y: 0, animated: true });
        AccessibilityInfo.announceForAccessibility(
          decision === "deny"
            ? "Refused."
            : scope === "always"
              ? "Allowed, and from now on."
              : "Allowed once.",
        );
      },
      /**
       * What the deployment said, said out loud.
       *
       * All four of the server's replies — already expired, somebody answered first, this cannot be
       * turned into a standing rule, gone — used to produce exactly one effect: the buttons stopped
       * being dim. The third one is the worst, because it is a sentence written for a person to read
       * and it never arrived.
       */
      (cause: unknown) => {
        setPending(null);
        setAnswerError(
          cause instanceof Error
            ? cause.message
            : "That answer did not reach the deployment.",
        );
      },
    );
  };

  return (
    <Screen>
      <TopBar
        leading={<BotAvatar seed={approval.botId} size={28} />}
        onBack={onBack}
        title={approval.botName}
      />
      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        ref={scroller}
      >
        <Card accent={!settled}>
          <View accessibilityLiveRegion="polite">
            <Badge tone={settled || pending ? "quiet" : "pending"}>
              {pending
                ? "Sending your answer…"
                : approval.state === "pending"
                  ? "Waiting for you"
                  : approval.state === "allowed"
                    ? "Allowed"
                    : approval.state === "denied"
                      ? "Refused"
                      : "Expired"}
            </Badge>
          </View>
          <Heading>
            {approval.botName} {settled ? "wanted to" : "wants to"}{" "}
            {intentPhrase(approval.intent)} {what}
          </Heading>
          <Body muted>on {where}</Body>
          {approval.subject.kind === "page" ? (
            <Body muted>
              The server could not match this to anything in the page it
              snapshotted, so it cannot tell you what will be acted on.
            </Body>
          ) : null}
          {left ? <Body muted>{left}</Body> : null}
          {approval.state === "expired" ? (
            <Body muted>
              Nobody answered in time, so it did not happen. The Bot was told to
              stop.
            </Body>
          ) : null}
        </Card>

        <View style={{ gap: space.sm }}>
          <Label>
            {settled ? "Why you were asked" : "Why you are being asked"}
          </Label>
          <Card muted>
            <Body>{approval.reason}</Body>
          </Card>
        </View>

        <View style={{ gap: space.sm }}>
          <Label>The rule that asked</Label>
          {/* The gateway writes the literal "an ask rule" when it did not record which one matched.
              Putting that inside `Rule` is the app asserting "go and find this in Boundaries" about
              a string that is not an expression and cannot be found. */}
          {approval.rule === "an ask rule" ? (
            <Card muted>
              <Body muted>
                This deployment's policy asked, but did not record which rule.
              </Body>
            </Card>
          ) : (
            <Rule>{approval.rule}</Rule>
          )}
        </View>

        {approval.scopedRule ? (
          <View style={{ gap: space.sm }}>
            <Label>The rule this wrote</Label>
            <Rule>{approval.scopedRule}</Rule>
            <Body muted>
              Always-allow is a rule, not a hidden setting. An administrator can
              read it, and change it, in Boundaries.
            </Body>
          </View>
        ) : null}

        {settled ? null : (
          <View style={{ gap: space.sm, paddingTop: space.xs }}>
            {answerError ? (
              <Card muted>
                <Body>{answerError}</Body>
              </Card>
            ) : null}
            {confirmingAlways ? (
              <Card muted>
                <Body>{alwaysMeans(approval)}</Body>
                <Body muted>
                  An administrator can read it, and change it, in Boundaries.
                  This app cannot take it back.
                </Body>
              </Card>
            ) : null}
            <Button
              disabled={pending !== null}
              onPress={() => answer("allow", "once")}
              title={pending === "once" ? "Sending your answer…" : "Allow once"}
              tone="allow"
            />
            <Button
              disabled={pending !== null}
              onPress={() => {
                if (!confirmingAlways) {
                  setConfirmingAlways(true);
                  return;
                }
                answer("allow", "always");
              }}
              title={
                pending === "always"
                  ? "Sending your answer…"
                  : confirmingAlways
                    ? "Confirm: always allow"
                    : "Always allow this"
              }
              tone="quiet"
            />
            <Button
              disabled={pending !== null}
              onPress={() => answer("deny", "once")}
              title={pending === "deny" ? "Sending your answer…" : "Refuse"}
              tone="refuse"
            />
            {/* The facts a decision needs — the amount, the invoice count, what the Bot checked —
                are in the conversation, and the approval has always carried its channel. */}
            {approval.channelId ? (
              <Button
                onPress={() => onOpenChannel(approval.channelId)}
                title="Open the conversation"
                tone="quiet"
              />
            ) : null}
          </View>
        )}

        <View style={{ gap: space.sm }}>
          <Label>Details</Label>
          <Card muted>
            <Body muted>Tool: {approval.toolName}</Body>
            <Body muted>Bot: {approval.botId}</Body>
            <Body muted>Asked at {when(approval.askedAt)}</Body>
            {/* Never who. The server deliberately does not carry the answerer's name, and this
                screen used to invent "a person" and render it as a fact. */}
            {approval.answeredAt ? (
              <Body muted>Answered at {when(approval.answeredAt)}</Body>
            ) : null}
          </Card>
        </View>

        <View
          style={{ height: space.xl, backgroundColor: colors.background }}
        />
      </ScrollView>
    </Screen>
  );
}
