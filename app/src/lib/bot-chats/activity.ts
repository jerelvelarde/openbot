import type { Message } from "@ag-ui/core";
import { useAgent } from "@copilotkit/react-core/v2";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { recordBotChatActivityMutationOptions } from "./mutations";
import type { BotChat } from "./queries";

/**
 * Telling the roster what was just said in a direct conversation with a Bot.
 *
 * WHY THE CLIENT REPORTS THIS AT ALL, rather than the server noticing on its own: the client that ran
 * the agent already has the message before platform replay can return it, the runtime exposes no
 * run-completion hook, and its run endpoint returns before the reply exists. That is the same reason
 * `channel-chat.tsx` reports a channel's activity from the browser, and the reasoning belongs here
 * too — this is the other kind of conversation in the same roster, and it needs the same two facts
 * (`last_message`, `last_message_at`) written by the same means.
 *
 * A CHANNEL CAN DO THIS FROM ITS SEND PATH AND A BOT CHAT CANNOT. `ChannelChat` owns `say`, so it
 * knows the moment a person's turn leaves the composer and reports from there. The Bot chat screen
 * renders the packaged `CopilotChat`, which owns its own composer, its own transcript and its own
 * runs. Replacing it to get at the send is a spec non-goal, so the messages are OBSERVED instead:
 * `useAgent({ agentId })` hands back the same shared agent instance the packaged chat binds to (see
 * `stopped-turn.ts`, which watches the same instance for run failures), and that instance announces
 * every message it gains.
 */

/** What one report says: the words, and who said them. Null names the person. */
export type BotChatActivity = {
  agentId: string | null;
  text: string;
  /**
   * True on the first words a person says in this conversation — false on every message the Bot
   * says, on a person's later ones, and on every message sent while a title is still being asked
   * for.
   *
   * The server may derive the conversation's title from that one message, so this is what tells the
   * hook which report is worth a refetch. A latch here rather than a test at the call site because
   * the call site cannot tell: it would have to ask whether the title has arrived yet, and the
   * answer is still "no" for every message sent while the refetch is in flight.
   *
   * A THROTTLE RATHER THAN A ONE-SHOT, which is the difference between this and what it used to be.
   * `titleStillMissing` arms it again when a report ends without a title, so "never again" holds only
   * for as long as asking again would be asking a question already in flight.
   */
  firstFromPerson: boolean;
};

/**
 * The part of AG-UI's `onNewMessage` payload this file reads.
 *
 * `input` IS THE ONLY THING THAT SAYS WHERE A MESSAGE CAME FROM, and everything below turns on it.
 * `AbstractAgent.addMessage` notifies subscribers with `{ message, messages, state, agent }` and no
 * `input`, because there is no run to describe; a message applied from a stream — a live run's own
 * events, or the gateway replaying a thread's history — always carries the `RunAgentInput` it arrived
 * on (@ag-ui/client 0.0.57, `AbstractAgent.addMessage` and the TEXT_MESSAGE_END branch of its event
 * pipeline). AG-UI's own subscriber type declares `input` optional on this callback for exactly that
 * reason, so this is a distinction the protocol makes rather than one inferred here.
 */
export type ObservedMessage = {
  message: Readonly<Message>;
  input?: unknown;
};

/** Held so the hook below can keep one across re-subscribes. */
export type BotChatActivityWatcher = {
  observed: (event: ObservedMessage) => BotChatActivity | null;
  /**
   * Arm `firstFromPerson` again: the last report that carried it did not leave the conversation
   * titled.
   *
   * Called by the hook when the refetch behind a title-deriving report came back with `title` still
   * null, or when that report never landed at all. Only the flag is armed — the `spokenHere` latch
   * and the reported-ids set are untouched, because neither of them is about titles.
   */
  titleStillMissing: () => void;
};

/**
 * The words a roster line would show for a message, or "" for a message that has none.
 *
 * A user turn's content is either a string or a list of parts, because the packaged composer sends
 * attachments as parts alongside the text. Only the text parts are joined, the same way
 * `toVisibleChatItems` projects them for the channel transcript: an image has no words to preview.
 */
function spokenText(message: Readonly<Message>): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (content === undefined) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Decides, message by message, what is worth reporting — and what is history saying itself again.
 *
 * A PLAIN STATE MACHINE RATHER THAN A HOOK, so every rule below can be driven message by message
 * from a test — a rendered chat cannot be asked to replay a history on demand — and so the hook
 * underneath is thin enough to read in one go.
 *
 * THE REPLAY IS THE HAZARD THIS EXISTS FOR. Opening a conversation makes the packaged chat connect
 * the thread, and a fresh connect asks the gateway for the whole history, which arrives as ordinary
 * AG-UI events through the same pipeline a live answer uses — so every stored assistant turn
 * announces itself as a new message. Reporting those would stamp `last_message_at` with the time the
 * conversation was OPENED rather than the time anything was said: the roster would reorder itself on
 * every visit, and — because saying something in an archived conversation is how it comes back —
 * merely opening an archived conversation would restore it. `bot-chats/store.ts` is explicit that a
 * conversation must not be un-archived by navigation, and this is the client half of that promise.
 *
 * So the rules are:
 *
 *   - A person's turn is reported only when it was added by THIS browser (no `input`). That is the
 *     composer, and the gateway has no way to fake it.
 *   - The Bot's turn is reported only after this browser has seen the person speak here. A replay
 *     arrives before anybody has typed anything, so the latch is still closed when it does.
 *   - Nothing is reported twice, keyed on the message id: a resumed connect may re-deliver the tail
 *     of a thread this tab already reported, and one message must not move the roster twice.
 *
 * The `spokenHere` latch is never cleared, unlike `awaitingReply` in `channel-chat.tsx`, which
 * clears when the run finishes. It cannot be: OpenBot registers every computer tool as a frontend tool, so an ordinary
 * browsing turn is several runs in a row and the answer worth previewing usually lands in a later
 * one. Left latched, every sentence the Bot says updates the preview and the newest one wins, which
 * is what a roster line is for. The cost is that a replay arriving after the person has already typed
 * would be reported — and in that one case they have just spoken in the conversation anyway, so the
 * archive was theirs to clear and the next real message overwrites the preview.
 */
export function botChatActivityWatcher(
  botAgentId: string,
): BotChatActivityWatcher {
  const reported = new Set<string>();
  /** Whether a person has sent something from this browser, in this conversation. */
  let spokenHere = false;
  /**
   * Whether a person's words have already been reported for the title, and that report is either
   * still being answered or produced one.
   *
   * Cleared by `titleStillMissing` when it did neither, so the next thing the person says asks again
   * rather than the conversation keeping the Bot's name for the session.
   */
  let reportedFromPerson = false;

  return {
    titleStillMissing() {
      reportedFromPerson = false;
    },

    observed({ message, input }) {
      const addedHere = input === undefined;

      /*
       * Latched before the text is looked at, deliberately. A message carrying only an attachment has
       * no words to preview and is not reported, but the person did speak, and the answer to it is
       * the reply this screen exists to show in the roster.
       */
      if (message.role === "user" && addedHere) spokenHere = true;

      // A bot chat has one Bot and one person, and those are the only two things the server will
      // attribute a message to. A tool result, an activity card and a reasoning trace are not what
      // anybody said, so none of them belongs on a roster line.
      if (message.role !== "user" && message.role !== "assistant") return null;

      // The two guards above, applied per direction: a person's turn has to have come from here, and
      // the Bot's has to come after one that did.
      if (message.role === "user" ? !addedHere : !spokenHere) return null;

      const text = spokenText(message);
      if (!text) return null;
      if (reported.has(message.id)) return null;
      reported.add(message.id);

      const fromPerson = message.role === "user";
      /*
       * Latched only on a message that is actually being reported: an attachment with no words never
       * reaches here, so it does not spend the flag on a message the server is never told about.
       *
       * Being told about a message is not the same as the server titling from it, though, and this
       * cannot tell which happened — the rules differ (`.trim()` here, `flatten` there) and only the
       * answer says. So the latch is provisional: whoever reports calls `titleStillMissing` when the
       * conversation came back untitled, and the next thing the person says carries the flag again.
       */
      const firstFromPerson = fromPerson && !reportedFromPerson;
      if (fromPerson) reportedFromPerson = true;

      // `null` for the person, this Bot's id for the Bot. The server refuses any other agent id, and
      // the distinction is what decides both the title (only ever from a person's first message) and
      // the unseen dot (only ever raised by the Bot's).
      return {
        agentId: fromPerson ? null : botAgentId,
        firstFromPerson,
        text,
      };
    },
  };
}

/** A watcher and the conversation it belongs to, so a held one can be checked before it is reused. */
export type HeldWatcher = {
  botChatId: string;
  watcher: BotChatActivityWatcher;
};

/**
 * The watcher for this conversation, reusing a held one only when it is the same conversation.
 *
 * A WATCHER MUST NEVER OUTLIVE ITS CONVERSATION, and that requirement lives here rather than in a
 * `key` on whoever renders the hook. Both of a watcher's pieces of memory are per-conversation: the
 * `spokenHere` latch, and the set of message ids already reported. Carry either into a different
 * conversation and the guarantees invert — the latch arrives already open, so the next thing that
 * announces itself is reported even though nobody has typed anything, and the first thing to
 * announce itself after a navigation is the new thread's replayed history. That would stamp
 * `last_message_at` with the moment of the navigation and clear `archived_at` on the way past: an
 * archived conversation un-archived by being opened, which is the one thing this file exists to
 * prevent.
 *
 * The screen that calls the hook passes `key={botChat.id}`, which remounts the whole subtree on a
 * change and so happens to make this impossible from that one call site — but that key was the only
 * thing standing between a navigation and the failure above, which made a correct screen a
 * precondition for a correct hook. The hook now holds either way: it swaps the held watcher inside
 * the effect that subscribes, so only a render React actually committed can change which watcher is
 * held. (Called from the render body, as it was, a render React abandoned could swap it too — the
 * failure direction was safe, a fresh watcher for the conversation being abandoned, but "the hook
 * holds either way" was not true of the concurrent case.)
 *
 * Reused for the same id, deliberately, which is the reason a ref holds it at all: a re-subscribe
 * (a new agent instance, a re-run effect) must not lose the "already reported" set, or the tail of
 * the thread gets reported twice.
 */
export function watcherFor(
  held: HeldWatcher | null,
  botChat: Pick<BotChat, "agentId" | "id">,
): HeldWatcher {
  if (held?.botChatId === botChat.id) return held;
  return {
    botChatId: botChat.id,
    watcher: botChatActivityWatcher(botChat.agentId),
  };
}

/**
 * Report both directions of this conversation to the roster, for as long as the screen is mounted.
 *
 * Nothing here waits on a report and nothing retries — a failed preview update is a stale roster
 * line, not a lost message. A refused one is no longer silent, though:
 * `recordBotChatActivityMutationOptions` reads the answer, throws when the server said no or never
 * answered at all, and writes a structured console line naming the conversation. There is no
 * sentence on the screen for it today, deliberately: a turn reports several times over — every
 * sentence the Bot says is one — so a blip would stack banners over a conversation whose messages
 * all arrived.
 */
export function useBotChatActivity(botChat: BotChat): void {
  const { agentId, id } = botChat;
  /*
   * Bound by agent id and nothing else, which is what makes this the chat's own agent rather than a
   * second one: `useAgent({ agentId })` returns the shared registered instance, and the packaged
   * chat resolves the same instance from the same id (it writes the thread onto it separately). Ask
   * for a `threadId` here and the hook throws, by design — see the message it throws.
   */
  const { agent } = useAgent({ agentId });
  const queryClient = useQueryClient();

  /** One watcher per conversation, so its "already reported" set survives a re-subscribe. */
  const held = useRef<HeldWatcher | null>(null);

  /*
   * The answer to "that report left the conversation untitled", which the mutation is what knows.
   *
   * Checked against the held conversation before it is acted on, for the same reason `watcherFor`
   * checks: a report settles after the write it describes, so one belonging to the conversation
   * somebody has just moved away from can arrive once a different watcher is held — and arming THAT
   * one's flag would let a conversation that has already asked for its title ask a second time, on
   * an answer about a different conversation entirely. Only the screen's `key` makes that impossible
   * today, and this hook is not allowed to need it. Stable identity, so the mutation options stay
   * the only thing that changes per render.
   */
  const titleStillMissing = useCallback((botChatId: string) => {
    const current = held.current;
    if (current?.botChatId !== botChatId) return;
    current.watcher.titleStillMissing();
  }, []);

  const recordActivity = useMutation(
    recordBotChatActivityMutationOptions(queryClient, titleStillMissing),
  );
  /* The mutation object's identity changes per render; `mutate` is stable, so only it is a dep. */
  const record = recordActivity.mutate;

  /**
   * Read at report time rather than captured, so the effect does not re-subscribe when it changes.
   *
   * Written from an effect rather than in the render body: only a committed render has a `botChat`
   * this hook should believe, and reports arrive from a subscription that a commit is what
   * establishes, so an effect is never too late for one.
   */
  const untitled = useRef(botChat.title === null);
  useEffect(() => {
    untitled.current = botChat.title === null;
  });

  useEffect(() => {
    /*
     * The held watcher is swapped here, in the effect, rather than in the render body — see
     * `watcherFor`. This is also the only place it matters: the watcher exists to be handed to a
     * subscription, and there is one of those per commit.
     */
    held.current = watcherFor(held.current, { agentId, id });
    const watcher = held.current.watcher;

    if (typeof agent.subscribe !== "function") {
      /*
       * NOT INFERRED SILENTLY, because the whole premise of this file is that the browser is the
       * only thing that can report what was said here. No subscription means no reports at all for
       * this conversation — no title, no preview, no timestamp, no unseen dot and no un-archiving —
       * which looks exactly like somebody who opened a chat and never spoke, and would be diagnosed
       * as a server problem for as long as it took somebody to read this file.
       *
       * A line rather than a throw: this is a reporter, and taking the conversation down with it
       * would be the worse trade. The packaged `useAgent` documents `agent` as always fully
       * constructed and `agent.subscribe(...)` as always safe (@copilotkit/react-core v2,
       * `headless.d.mts`), so reaching this is a broken contract rather than a state to design for —
       * which is exactly the kind of thing that has to be audible when it happens.
       */
      console.error(
        JSON.stringify({
          type: "bot-chat-activity-unsubscribable",
          botChatId: id,
          note: "This tab cannot subscribe to the Bot's messages, so nothing said in this conversation will reach the roster: no title, no preview, no unseen dot, and an archived conversation will not come back by being spoken in.",
        }),
      );
      return;
    }

    const subscription = agent.subscribe({
      onNewMessage: (event) => {
        const activity = watcher.observed(event);
        if (!activity) return;

        /*
         * ONE TITLE REFETCH AT A TIME: the first thing a person says in a conversation that has none
         * yet, and again after an attempt that did not produce one.
         *
         * Both halves are needed and neither is enough. `firstFromPerson` is latched in the watcher,
         * so a burst of messages asks once rather than once each — read on its own, `untitled` is
         * still true for every message sent before the invalidated detail query comes back.
         * `untitled` is what keeps a conversation that already has a title from refetching at all.
         *
         * What it no longer costs: an attempt that ends with `title` still null — the report was
         * refused, or the server declined to title a message this browser thought had words in it —
         * arms the flag again through `titleStillMissing`, so the next thing the person says asks
         * once more. Left latched, that one lost refetch meant the header and the sidebar row showed
         * the Bot's name for the rest of the session while a title the person's next message had
         * earned sat in the database.
         *
         * The refetch itself is in the mutation's own `onSuccess`, not passed per call — see
         * `recordBotChatActivityMutationOptions`, where a per-call callback was being cancelled by
         * the Bot's reply.
         */
        record({
          agentId: activity.agentId,
          at: new Date().toISOString(),
          botChatId: id,
          derivesTitle: activity.firstFromPerson && untitled.current,
          text: activity.text,
        });
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, agentId, id, record]);
}
