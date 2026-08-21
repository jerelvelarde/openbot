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

import type { AnswerScope, DataSource, SendOptions } from "./source";
import type {
  Approval,
  AuditRow,
  Bot,
  Channel,
  LiveTurn,
  Message,
  Notification,
  Skill,
} from "./types";

const BOT = { id: "risk-analyst", name: "Risk Analyst" };
const HOST = "portal.northwind.example";

/**
 * The roster, so starting a conversation has somebody to start it with.
 *
 * Three, because a picker with one entry teaches nobody anything about what the screen is for. The
 * ids are the seeds the sign-in screen already shows faces for, so the same Bot has the same face
 * everywhere in the app.
 */
const BOTS: Bot[] = [
  { id: BOT.id, name: BOT.name, title: "Watches the payment runs" },
  {
    id: "general-assistant",
    name: "General Assistant",
    title: "Whatever nobody else owns",
  },
  { id: "knowledge", name: "Knowledge", title: "Reads the handbook" },
];

/** Granted skills, as the `/` menu offers them. */
const SKILLS: Skill[] = [
  {
    slug: "reconcile",
    title: "Reconcile a run",
    summary: "Check a payment run against the control sheet before submitting",
    instructions:
      "Reconcile the run against the control sheet line by line. Report the totals and any difference before acting, and do not submit anything if they disagree.",
  },
  {
    slug: "handover",
    title: "Write a handover",
    summary: "Summarise what happened for whoever picks this up next",
    instructions:
      "Write a short handover: what you did, what you found, what is still open, and what the next person has to decide. No preamble.",
  },
];

/**
 * A fixed clock, on today's date.
 *
 * Timestamps are minted from a base rather than from `Date.now()` so a recording made today and one
 * made next week show the same times, and a reviewer comparing them is looking at the change rather
 * than at the date.
 *
 * The base is a fixed time of day but the CURRENT day, which is the part that has to move: timestamps
 * are rendered day-aware now (see `when()`), so a hardcoded date makes the whole demo read as
 * "19 Aug 14:02" the day after it was pinned — a thread of stale history rather than this morning's
 * work. The visible strings stay identical run to run; only the invisible date follows the calendar.
 *
 * 09:30 because the web build draws a status bar reading 9:41, as every phone mockup does. The events
 * then run up to a few minutes short of it, so a recording does not show a conversation happening
 * hours after the clock above it.
 */
const BASE = new Date(new Date().setHours(9, 30, 0, 0)).getTime();
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
      /**
       * Ten minutes from whenever this is being looked at.
       *
       * The server parks an action for ten minutes and the demo carries the same pressure, or the
       * countdown on the approval screen is only ever exercised against a live deployment. Measured
       * from now rather than from BASE, because BASE is a fixed hour: anchored to it, the demo says
       * the deadline has passed for most of every day.
       */
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
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
      botId: BOT.id,
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

  type Room = { channel: Channel; messages: Message[] };
  /**
   * Every conversation, seeded one plus whatever gets started.
   *
   * A list rather than the single channel this used to hold, because a companion that cannot start a
   * conversation is read-only, and there was no way to demonstrate — or record — the screen that does.
   */
  const rooms: Room[] = [{ channel, messages }];

  const roomOf = (channelId: string) =>
    rooms.find((room) => room.channel.id === channelId);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      timers.push(setTimeout(resolve, ms));
    });

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
      // Newest first, which is what the server's own roster query orders by.
      return [...rooms]
        .map((room) => room.channel)
        .sort((left, right) =>
          (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? ""),
        );
    },
    async channel(channelId) {
      return roomOf(channelId)?.channel;
    },
    async messages(channelId) {
      return [...(roomOf(channelId)?.messages ?? [])];
    },

    async bots() {
      return [...BOTS];
    },

    async createChannel(botId) {
      const bot = BOTS.find((candidate) => candidate.id === botId);
      if (!bot) throw new Error("There is no Bot with that id.");
      const room: Room = {
        channel: {
          id: id("channel"),
          name: bot.name,
          botId: bot.id,
          botName: bot.name,
          lastMessage: null,
          lastMessageAt: null,
          busy: false,
          pendingApprovals: 0,
        },
        messages: [],
      };
      rooms.push(room);
      announce();
      return room.channel;
    },

    async skills() {
      return [...SKILLS];
    },

    async send(channelId, text, options: SendOptions = {}) {
      const room = roomOf(channelId);
      if (!room) throw new Error("That channel is gone.");
      const queued = room.channel.busy;

      room.messages.push({
        id: id("msg"),
        role: "user",
        text,
        at: stamp(),
        ...(queued ? { queued: true } : {}),
      });
      room.channel.lastMessage = text;
      room.channel.lastMessageAt = stamp();

      if (queued) {
        // Held, not dropped and not interrupting. The words are in the thread either way; only the
        // intent to run is deferred.
        steerQueue.push(text);
        announce();
        return { queued: true };
      }

      room.channel.busy = true;
      announce();

      /**
       * The reply, written rather than delivered.
       *
       * Against a deployment this comes off the run's event stream a word at a time. The demo does
       * the same thing on a timer, because "it arrives as it is written" is a property of the app
       * worth being able to see and to record, and a source that jumped straight to the finished
       * answer would be the one place the local build lied about how the product behaves.
       */
      const reply =
        (options.skills ?? []).length > 0
          ? `Working to the ${(options.skills ?? []).map((skill) => skill.title.toLowerCase()).join(" and ")} skill. I have read the run and nothing disagrees with the control sheet.`
          : "Understood. I will pick that up now.";

      const fold: LiveTurn = { text: "", toolLines: [], done: false };
      const emit = () =>
        options.onTurn?.({ ...fold, toolLines: [...fold.toolLines] });

      await sleep(260);
      fold.toolLines.push({ label: "read", outcome: "running" });
      emit();
      await sleep(520);
      fold.toolLines[0] = {
        label: "read",
        detail: `${HOST}`,
        outcome: "allowed",
      };
      emit();

      for (const word of reply.split(" ")) {
        await sleep(45);
        fold.text = fold.text ? `${fold.text} ${word}` : word;
        emit();
      }

      fold.done = true;
      emit();

      room.messages.push({
        id: id("msg"),
        role: "assistant",
        text: reply,
        at: stamp(),
        toolLines: [{ label: "read", detail: HOST, outcome: "allowed" }],
      });
      room.channel.lastMessage = reply;
      room.channel.lastMessageAt = stamp();
      if (room.channel === channel) settle();
      else {
        room.channel.busy = false;
        announce();
      }
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
      approval.answeredAt = stamp();
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
            ? `Allowed “${label}”${scope === "always" ? ", and from now on" : ""}`
            : `Refused “${label}”`,
        // A refusal drawn as "answered" is drawn in the allow colour, which makes the one row
        // somebody scanning the trail most needs to spot look like the rows either side of it. The
        // HTTP source already derives this from the answer; this is the demo matching it.
        outcome: decision === "allow" ? "answered" : "refused",
        rule: approval.scopedRule ?? approval.rule,
        actor: "jerel@copilotkit.ai",
      });

      channel.pendingApprovals = approvals.filter(
        (candidate) => candidate.state === "pending",
      ).length;

      /**
       * The note becomes what happened.
       *
       * A notification body is written once, in the present tense, and then outlives the thing it
       * described: "needs approval to activate …" sitting in the list under a green dot, minutes
       * after it was refused, is the app reporting an outstanding request that is not outstanding.
       */
      for (const note of notifications) {
        if (note.approvalId !== approvalId) continue;
        note.read = true;
        note.kind = decision === "allow" ? "done" : "refused";
        note.body =
          decision === "allow"
            ? `was allowed to activate “${label}”`
            : `was refused “${label}”`;
        note.at = stamp();
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
          botId: approval.botId,
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

    refresh: announce,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
