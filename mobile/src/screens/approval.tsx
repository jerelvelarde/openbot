/**
 * One parked action, and the three answers to it.
 *
 * Everything on this screen is the SERVER's account of what is about to happen: the element label the
 * gateway resolved from its own snapshot, the host it is on, and the rule that stopped it. None of it
 * is the model's description of its own intention, because a screen that asked you to approve the
 * model's summary of what it was doing would be approving the one thing the policy exists not to
 * trust.
 */
import { useState } from "react";
import { ScrollView, View } from "react-native";
import type { Approval } from "../data/types";
import { useLive, useSource } from "../store";
import { space } from "../theme";
import {
  Badge,
  Body,
  Button,
  Card,
  Heading,
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
  // An element is quoted because it is a label a person will go looking for on a page. A page, or a
  // bare action the server could not name, is not.
  return {
    what: kind === "element" ? `“${label}”` : label,
    where: host ?? "its computer",
  };
}

export function ApprovalScreen({
  approvalId,
  onBack,
}: {
  approvalId: string;
  onBack: () => void;
}) {
  const colors = useColors();
  const source = useSource();
  const approval = useLive((s) => s.approval(approvalId));
  const [answering, setAnswering] = useState(false);

  if (!approval) {
    return (
      <Screen>
        <TopBar title="Approval" onBack={onBack} />
        <View style={{ padding: space.lg }}>
          <Body muted>That approval is no longer waiting.</Body>
        </View>
      </Screen>
    );
  }

  const { what, where } = describe(approval);
  const settled = approval.state !== "pending";

  const answer = (decision: "allow" | "deny", scope: "once" | "always") => {
    setAnswering(true);
    void source
      .answer(approval.id, decision, scope)
      .finally(() => setAnswering(false));
  };

  return (
    <Screen>
      <TopBar title={approval.botName} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <Card>
          <Badge tone={settled ? "quiet" : "pending"}>
            {approval.state === "pending"
              ? "Waiting for you"
              : approval.state === "allowed"
                ? "You allowed it"
                : approval.state === "denied"
                  ? "You refused it"
                  : "Expired"}
          </Badge>
          <Heading>
            {approval.botName} wants to {approval.intent} {what}
          </Heading>
          <Body muted>on {where}</Body>
        </Card>

        <View style={{ gap: space.sm }}>
          <Label>Why you are being asked</Label>
          <Card muted>
            <Body>{approval.reason}</Body>
          </Card>
        </View>

        <View style={{ gap: space.sm }}>
          <Label>The rule that asked</Label>
          <Rule>{approval.rule}</Rule>
        </View>

        <View style={{ gap: space.sm }}>
          <Label>Details</Label>
          <Card muted>
            <Body muted>Tool: {approval.toolName}</Body>
            <Body muted>Bot: {approval.botId}</Body>
            <Body muted>Asked at {when(approval.askedAt)}</Body>
            {approval.answeredBy ? (
              <Body muted>Answered by {approval.answeredBy}</Body>
            ) : null}
          </Card>
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
            <Button
              title="Allow once"
              tone="allow"
              disabled={answering}
              onPress={() => answer("allow", "once")}
            />
            <Button
              title="Always allow this"
              tone="quiet"
              disabled={answering}
              onPress={() => answer("allow", "always")}
            />
            <Button
              title="Refuse"
              tone="refuse"
              disabled={answering}
              onPress={() => answer("deny", "once")}
            />
          </View>
        )}

        <View
          style={{ height: space.xl, backgroundColor: colors.background }}
        />
      </ScrollView>
    </Screen>
  );
}
