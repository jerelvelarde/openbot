import type { Message } from "@ag-ui/core";
import { useCallback, useEffect, useState } from "react";
import type { ComposerDraft } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  readExternalThreadMessages,
  submitExternalThreadTurn,
  type ExternalThreadTarget,
} from "@/lib/external/queries";

type Delivery =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "failed"; message: string };

export function ExternalThreadChat({
  target,
}: {
  target: ExternalThreadTarget;
}) {
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [restoring, setRestoring] = useState(true);
  const [unreadable, setUnreadable] = useState(false);
  const [delivery, setDelivery] = useState<Delivery>({ state: "idle" });

  const restore = useCallback(() => {
    let current = true;
    setRestoring(true);
    void readExternalThreadMessages(target.threadId).then(
      (stored) => {
        if (!current) return;
        setMessages(stored);
        setUnreadable(false);
        setRestoring(false);
      },
      () => {
        // Without this branch a rejected read left `restoring` true forever, so
        // the screen sat in its placeholder state with nothing explaining why.
        if (!current) return;
        setUnreadable(true);
        setRestoring(false);
      },
    );
    return () => {
      current = false;
    };
  }, [target.threadId]);

  useEffect(restore, [restore]);

  const onSubmit = useCallback(
    (draft: ComposerDraft) => {
      if (target.readOnly || delivery.state === "sending") return;
      // The coworker is pinned to the Slack thread and cannot be changed from
      // here, so a draft's agent and command chips have no meaning on this
      // surface; only the text crosses to Slack.
      const trimmed = draft.text.trim();
      if (draft.isEmpty || trimmed.length === 0) return;

      // Minted once per composed message and reused by any retry of it, because
      // this is the idempotency key: a fresh id on retry would be a second Slack
      // message and a second agent run rather than a retry.
      const id = crypto.randomUUID();
      setDelivery({ state: "sending" });
      void submitExternalThreadTurn(target.threadId, {
        id,
        text: trimmed,
      }).then(
        () => {
          setDelivery({ state: "idle" });
          // Reconcile against the stored transcript rather than trusting an
          // optimistic echo: Slack, not this tab, is the record of what was
          // actually delivered.
          restore();
        },
        (error: unknown) => {
          setDelivery({
            state: "failed",
            message:
              error instanceof Error
                ? error.message
                : "Could not send this message to Slack.",
          });
        },
      );
    },
    [delivery.state, restore, target.readOnly, target.threadId],
  );

  return (
    <ConversationView
      disabled={target.readOnly || delivery.state === "sending"}
      messages={messages}
      notice={
        <div className="pb-2 text-sm text-muted-foreground" role="status">
          <p>
            This is the canonical Slack conversation with {target.agentName}.{" "}
            {target.readOnly
              ? "It is read-only here; continue the conversation in Slack."
              : "Messages you send here appear in the Slack thread, attributed to you."}
          </p>
          {unreadable ? (
            <p>
              Earlier messages could not be loaded. The conversation continues
              in Slack.
            </p>
          ) : null}
          {delivery.state === "failed" ? (
            <p role="alert">{delivery.message} Try sending it again.</p>
          ) : null}
        </div>
      }
      onSubmit={onSubmit}
      restoring={restoring}
    />
  );
}
