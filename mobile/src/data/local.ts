/**
 * A deployment in memory, so the companion runs with nothing behind it.
 *
 * It is not a stub that returns fixtures: answering an approval here actually resumes the parked
 * turn, a refusal actually writes the rule that caused it into the trail, and a message sent to a
 * busy Bot is actually held and drained. The behaviour is the part worth having, because it is what
 * the screens are built against and what the recordings show.
 *
 * The shapes and the wording follow the server. A refusal reads the way `describeRefusal` in
 * `server/src/computer/policy.ts` phrases one, and the audit event names are the ones in
 * `server/src/audit.ts`.
 */
import type {
  Approval,
  AuditRow,
  Channel,
  Message,
  Notification,
} from "./types";
import type { AnswerScope, DataSource } from "./source";

const BOT = { id: "risk-analyst", name: "Risk Analyst" };
const HOST = "portal.northwind.example";

/**
 * A fixed clock.
 *
 * Timestamps are minted from a base rather than from `Date.now()` so a recording made today and one
 * made next week show the same thread, and a reviewer comparing them is looking at the change rather
 * than at the date.
 */
const BASE = new Date("2026-08-19T14:02:00Z").getTime();
let tick = 0;
const stamp = () => new Date(BASE + tick++ * 41_000).toISOString();

let sequence = 0;
function id(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

export function createLocalSource(): DataSource {
  const listeners = new Set<() => void>();
  const announce = () => {
    for (const listener of listeners) listener();
  };

  const channel: Channel = {
    id: "channel_1",
    name: "Risk Analyst",
    botId: BOT.id,
    botName: BOT.name,
    lastMessage: "Waiting for you to approve the payment run.",
    lastMessageAt: stamp(),
    // Mid-turn from the start: the Bot is parked on the approval below, which is the state the whole
    // companion exists to resolve.
    busy: true,
    pendingApprovals: 1,
  };

  const messages: Message[] = [
    {
      id: id("msg"),
      role: "user",
      text: "Check the August payment run in the supplier portal and submit it if the totals match the control sheet.",
      at: stamp(),
    },
    {
      id: id("msg"),
      role: "assistant",
      text: "Opening the portal and checking August against the control sheet.",
      at: stamp(),
      toolLines: [
        { label: "Opened", detail: HOST, outcome: "allowed" },
        {
          label: "Read the page",
          detail: "24 things it can act on",
          outcome: "allowed",
        },
        {
          label: "Read file",
          detail: "controls/august.csv",
          outcome: "allowed",
        },
      ],
    },
    {
      id: id("msg"),
      role: "assistant",
      text: "The totals match: £48,210.00 across 37 invoices. Submitting needs your approval.",
      at: stamp(),
      toolLines: [
        {
          label: "Waiting for you",
          detail: "Submit payment run",
          outcome: "running",
        },
      ],
    },
  ];

  const approvals: Approval[] = [
    {
      id: "approval_1",
      botId: BOT.id,
      botName: BOT.name,
      channelId: channel.id,
      toolName: "computer_click",
      intent: "activate",
      subject: { kind: "element", label: "Submit payment run", host: HOST },
      rule: 'intent == "activate" && contains(element.name, "submit")',
      reason:
        "This deployment's policy asks before anything called submit is activated outside your own domain.",
      askedAt: stamp(),
      state: "pending",
    },
  ];

  const audit: AuditRow[] = [
    {
      id: id("audit"),
      at: stamp(),
      eventType: "computer.action_allowed",
      botId: BOT.id,
      botName: BOT.name,
      summary: `Opened ${HOST}`,
      outcome: "allowed",
      actor: "jerel@copilotkit.ai",
    },
    {
      id: id("audit"),
      at: stamp(),
      eventType: "computer.action_allowed",
      botId: BOT.id,
      botName: BOT.name,
      summary: "Read file controls/august.csv",
      outcome: "allowed",
      actor: "jerel@copilotkit.ai",
    },
    {
      id: id("audit"),
      at: stamp(),
      eventType: "computer.action_asked",
      botId: BOT.id,
      botName: BOT.name,
      summary: `Asked to activate “Submit payment run” on ${HOST}`,
      outcome: "asked",
      rule: 'intent == "activate" && contains(element.name, "submit")',
      actor: "jerel@copilotkit.ai",
    },
  ];

  const notifications: Notification[] = [
    {
      id: id("note"),
      kind: "approval",
      botName: BOT.name,
      // Resolved subject only. No amount, no invoice count, no page contents: everything a lock
      // screen does not need is everything a lock screen must not have.
      body: `needs approval to activate “Submit payment run” on ${HOST}`,
      at: stamp(),
      read: false,
      approvalId: "approval_1",
      channelId: channel.id,
    },
  ];

  /** Messages typed at a busy Bot, drained into one follow-up turn when it settles. */
  let steerQueue: string[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, run: () => void) => {
    timers.push(setTimeout(run, ms));
  };

  /** The Bot settles: whatever was queued while it worked becomes one further turn. */
  function settle() {
    channel.busy = false;
    if (steerQueue.length > 0) {
      const drained = steerQueue;
      steerQueue = [];
      channel.busy = true;
      messages.push({
        id: id("msg"),
        role: "assistant",
        text:
          drained.length === 1
            ? `Picking up what you said while I was working: “${drained[0]}”.`
            : `Picking up the ${drained.length} things you said while I was working, in one go.`,
        at: stamp(),
      });
      announce();
      later(1400, () => {
        channel.busy = false;
        messages.push({
          id: id("msg"),
          role: "assistant",
          text: "Done. Nothing else is waiting on you.",
          at: stamp(),
        });
        channel.lastMessage = "Done. Nothing else is waiting on you.";
        channel.lastMessageAt = stamp();
        announce();
      });
      return;
    }
    announce();
  }

  return {
    async channels() {
      return [channel];
    },
    async channel(channelId) {
      return channelId === channel.id ? channel : undefined;
    },
    async messages() {
      return [...messages];
    },

    async send(_channelId, text) {
      const queued = channel.busy;
      messages.push({
        id: id("msg"),
        role: "user",
        text,
        at: stamp(),
        ...(queued ? { queued: true } : {}),
      });
      channel.lastMessage = text;
      channel.lastMessageAt = stamp();

      if (queued) {
        // Held, not dropped and not interrupting. The words are in the thread either way; only the
        // intent to run is deferred.
        steerQueue.push(text);
        announce();
        return { queued: true };
      }

      channel.busy = true;
      announce();
      later(1200, () => {
        messages.push({
          id: id("msg"),
          role: "assistant",
          text: "Understood.",
          at: stamp(),
        });
        settle();
      });
      return { queued: false };
    },

    async approvals() {
      return [...approvals];
    },
    async approval(approvalId) {
      return approvals.find((candidate) => candidate.id === approvalId);
    },

    async answer(approvalId, decision, scope: AnswerScope) {
      const approval = approvals.find(
        (candidate) => candidate.id === approvalId,
      );
      if (!approval) throw new Error("That approval is no longer waiting.");
      if (approval.state !== "pending") return approval;

      approval.state = decision === "allow" ? "allowed" : "denied";
      approval.answeredBy = "jerel@copilotkit.ai";
      const label =
        approval.subject.kind === "element"
          ? approval.subject.label
          : approval.toolName;

      // "Always allow" is a rule, not a flag: it is written where every other boundary lives so an
      // administrator can read it, and edit it, later.
      if (decision === "allow" && scope === "always") {
        approval.scopedRule = `bot.id == "${approval.botId}" && contains(element.name, "${label}")`;
      }

      audit.push({
        id: id("audit"),
        at: stamp(),
        eventType: "computer.action_answered",
        botId: approval.botId,
        botName: approval.botName,
        summary:
          decision === "allow"
            ? `You allowed “${label}”${scope === "always" ? ", and from now on" : ""}`
            : `You refused “${label}”`,
        outcome: "answered",
        rule: approval.scopedRule ?? approval.rule,
        actor: "jerel@copilotkit.ai",
      });

      channel.pendingApprovals = approvals.filter(
        (candidate) => candidate.state === "pending",
      ).length;

      for (const note of notifications) {
        if (note.approvalId === approvalId) note.read = true;
      }

      // Replace the "waiting for you" line with what actually happened, then let the run continue.
      const waiting = messages[messages.length - 1];
      if (waiting?.toolLines) {
        waiting.toolLines = [
          decision === "allow"
            ? { label: "Clicked", detail: label, outcome: "allowed" }
            : {
                label: "Blocked",
                detail: label,
                outcome: "refused",
                rule: approval.rule,
              },
        ];
      }

      if (decision === "allow") {
        audit.push({
          id: id("audit"),
          at: stamp(),
          eventType: "computer.action_allowed",
          botId: approval.botId,
          botName: approval.botName,
          summary: `Activated “${label}” on ${HOST}`,
          outcome: "allowed",
          actor: "jerel@copilotkit.ai",
        });
        messages.push({
          id: id("msg"),
          role: "assistant",
          text: "Submitted. The portal confirmed the August run: 37 invoices, £48,210.00.",
          at: stamp(),
          toolLines: [
            {
              label: "Read the page",
              detail: "confirmation",
              outcome: "allowed",
            },
          ],
        });
        channel.lastMessage = "Submitted. The portal confirmed the August run.";
        notifications.unshift({
          id: id("note"),
          kind: "done",
          botName: approval.botName,
          body: "finished the August payment run",
          at: stamp(),
          read: false,
          channelId: channel.id,
        });
      } else {
        audit.push({
          id: id("audit"),
          at: stamp(),
          eventType: "computer.action_refused",
          botId: approval.botId,
          botName: approval.botName,
          summary: `Refused “${label}” on ${HOST}`,
          outcome: "refused",
          rule: approval.rule,
          actor: "jerel@copilotkit.ai",
        });
        messages.push({
          id: id("msg"),
          role: "assistant",
          text: "I have not submitted it. The run is still sitting in the portal, ready, if you would rather do it yourself.",
          at: stamp(),
        });
        channel.lastMessage = "I have not submitted it.";
      }

      channel.lastMessageAt = stamp();
      announce();
      later(1500, settle);
      return approval;
    },

    async audit() {
      // Newest first, which is the order somebody checking what just happened reads in.
      return [...audit].reverse();
    },

    async notifications() {
      return [...notifications];
    },

    async markRead(noteId) {
      const note = notifications.find((candidate) => candidate.id === noteId);
      if (note) note.read = true;
      announce();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
