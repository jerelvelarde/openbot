import type { Message } from "@ag-ui/core";
import { useEffect, useState } from "react";
import { ConversationView } from "@/components/channels/conversation-view";
import type { ExternalThreadTarget } from "@/lib/external/queries";
import { readThreadMessages } from "@/lib/copilot/thread-messages";

export function ExternalThreadChat({
  target,
}: {
  target: ExternalThreadTarget;
}) {
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [restoring, setRestoring] = useState(true);
  const [unreadable, setUnreadable] = useState(0);

  useEffect(() => {
    let current = true;
    void readThreadMessages(target.threadId, target.agentId).then((stored) => {
      if (!current) return;
      setMessages(stored.messages);
      setUnreadable(stored.unreadable);
      setRestoring(false);
    });
    return () => {
      current = false;
    };
  }, [target.agentId, target.threadId]);

  return (
    <ConversationView
      disabled
      messages={messages}
      notice={
        <div className="pb-2 text-sm text-muted-foreground" role="status">
          <p>
            This is the canonical Slack conversation with {target.agentName}. It
            is read-only here for this demo; continue the conversation in Slack.
          </p>
          {unreadable > 0 ? (
            <p>
              {unreadable === 1
                ? "One earlier message could not be read."
                : `${unreadable} earlier messages could not be read.`}
            </p>
          ) : null}
        </div>
      }
      onSubmit={() => undefined}
      restoring={restoring}
    />
  );
}
