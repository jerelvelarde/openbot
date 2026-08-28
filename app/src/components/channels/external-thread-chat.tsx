import { UseAgentUpdate, useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";
import { ConversationView } from "@/components/channels/conversation-view";
import { transcriptMessages } from "@/components/channels/transcript-messages";
import type { ExternalThreadTarget } from "@/lib/external/queries";
import { readThreadMessages } from "@/lib/copilot/thread-messages";

export function ExternalThreadChat({
  target,
}: {
  target: ExternalThreadTarget;
}) {
  const { agent, isReady } = useAgent({
    agentId: `external-slack:${target.threadId}`,
    runtimeAgentId: target.agentId,
    threadId: target.threadId,
    updates: [UseAgentUpdate.OnMessagesChanged],
  });
  const [restoring, setRestoring] = useState(true);
  const [unreadable, setUnreadable] = useState(0);

  useEffect(() => {
    if (!isReady) return;
    let current = true;
    void readThreadMessages(target.threadId, target.agentId).then((stored) => {
      if (!current) return;
      if (stored.messages.length > 0 && agent.messages.length === 0) {
        agent.setMessages(stored.messages);
      }
      setUnreadable(stored.unreadable);
      setRestoring(false);
    });
    return () => {
      current = false;
    };
  }, [agent, isReady, target.agentId, target.threadId]);

  return (
    <ConversationView
      disabled
      messages={transcriptMessages(agent.messages, null)}
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
