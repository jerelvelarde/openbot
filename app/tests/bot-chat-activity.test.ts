import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  botChatActivityWatcher,
  watcherFor,
} from "../src/lib/bot-chats/activity";

/**
 * What a bot chat reports to the roster, and what it stays quiet about.
 *
 * The screen this serves renders the packaged `CopilotChat`, so the only way it learns what was said
 * is by watching the agent instance that chat binds to. Every rule here is about telling two things
 * apart on that one channel: something just said, which has to move the roster, and a thread's stored
 * history announcing itself again, which must not. Getting the second one wrong is not cosmetic — a
 * report un-archives the conversation it lands on, so it would restore an archive by navigation.
 *
 * The decision lives in a plain state machine, so this file drives it directly, message by message:
 * a rendered chat cannot be asked to replay a stored history on demand, and the replay is the case
 * that matters most.
 */

const BOT = "risk-analyst";

/** A message as the packaged composer adds it: no `input`, because there is no run yet. */
function typedHere(id: string, content: Message["content"]) {
  return { message: { content, id, role: "user" } as Message };
}

/** A message as a stream applies it — a live answer or a replayed one both carry the run input. */
function fromStream(
  id: string,
  role: "assistant" | "user",
  content: string,
  input: unknown = { runId: "run-1", threadId: "thread-1" },
) {
  return { input, message: { content, id, role } as Message };
}

describe("what a bot chat reports", () => {
  test("a person's message reports with no agent id, which is what derives the title", () => {
    const watcher = botChatActivityWatcher(BOT);

    expect(
      watcher.observed(typedHere("m1", "Book the Tuesday flight")),
    ).toEqual({
      agentId: null,
      firstFromPerson: true,
      text: "Book the Tuesday flight",
    });
  });

  test("the Bot's reply reports as the Bot, which is what raises the unseen dot", () => {
    const watcher = botChatActivityWatcher(BOT);

    watcher.observed(typedHere("m1", "Book the Tuesday flight"));

    expect(watcher.observed(fromStream("m2", "assistant", "Booked."))).toEqual({
      agentId: BOT,
      firstFromPerson: false,
      text: "Booked.",
    });
  });

  test("every sentence in one turn reports, so the newest is the preview", () => {
    // Deliberately not one-per-turn. Every computer tool is a frontend tool, so an ordinary browsing
    // turn is several runs in a row and the answer worth previewing is usually in a later one.
    const watcher = botChatActivityWatcher(BOT);
    watcher.observed(typedHere("m1", "Find the cheapest fare"));

    expect(
      watcher.observed(fromStream("m2", "assistant", "Let me look.")),
    ).toEqual({ agentId: BOT, firstFromPerson: false, text: "Let me look." });
    expect(
      watcher.observed(fromStream("m3", "assistant", "£61 on Tuesday.")),
    ).toEqual({
      agentId: BOT,
      firstFromPerson: false,
      text: "£61 on Tuesday.",
    });
  });

  test("a replayed history reports nothing, so opening a conversation cannot restore its archive", () => {
    /*
     * The whole reason the watcher exists. A fresh connect asks the gateway for the entire thread and
     * it arrives as ordinary AG-UI events, so every stored turn announces itself as a new message
     * before anybody has typed anything. Reported, they would stamp `last_message_at` with the time
     * the conversation was OPENED and clear `archived_at` on the way past.
     */
    const watcher = botChatActivityWatcher(BOT);

    expect(
      watcher.observed(fromStream("h1", "user", "Yesterday's ask")),
    ).toBeNull();
    expect(
      watcher.observed(fromStream("h2", "assistant", "Yesterday's answer")),
    ).toBeNull();
  });

  test("a replayed user turn does not open the latch the Bot's reply needs", () => {
    // The latch is what tells the two apart, so it must not be something the gateway can trip. If a
    // replayed person's turn set it, every stored answer behind it would be reported.
    const watcher = botChatActivityWatcher(BOT);

    watcher.observed(fromStream("h1", "user", "Yesterday's ask"));

    expect(
      watcher.observed(fromStream("h2", "assistant", "Yesterday's answer")),
    ).toBeNull();
  });

  test("one message is never reported twice, however often it is announced", () => {
    // A resumed connect can re-deliver the tail of a thread this tab already reported, and one
    // message must not move the roster twice.
    const watcher = botChatActivityWatcher(BOT);

    expect(watcher.observed(typedHere("m1", "Same message"))).not.toBeNull();
    expect(watcher.observed(typedHere("m1", "Same message"))).toBeNull();
    expect(
      watcher.observed(fromStream("m1", "user", "Same message")),
    ).toBeNull();
  });

  test("only what a person or the Bot said is reported, not tool results or activity cards", () => {
    const watcher = botChatActivityWatcher(BOT);
    watcher.observed(typedHere("m1", "Open the page"));

    expect(
      watcher.observed({
        message: {
          content: '{"ok":true}',
          id: "t1",
          role: "tool",
          toolCallId: "call-1",
        } as Message,
      }),
    ).toBeNull();
    expect(
      watcher.observed({
        message: {
          content: "Do this first",
          id: "s1",
          role: "system",
        } as Message,
      }),
    ).toBeNull();
  });

  test("a message with no words reports nothing, but still opens the latch", () => {
    /*
     * An attachment on its own has nothing a roster line could show, and the server has no preview to
     * write. The person did speak, though, and the reply to them is exactly what this screen exists to
     * get into the roster — so the latch is set on where the message came from, not on whether it had
     * words in it.
     */
    const watcher = botChatActivityWatcher(BOT);

    expect(
      watcher.observed(
        typedHere("m1", [
          {
            metadata: {},
            source: { mimeType: "image/png", type: "data", value: "AAAA" },
            type: "image",
          },
        ]),
      ),
    ).toBeNull();
    expect(watcher.observed(fromStream("m2", "assistant", "Got it."))).toEqual({
      agentId: BOT,
      firstFromPerson: false,
      text: "Got it.",
    });
  });

  test("an empty or blank message is not reported at all", () => {
    const watcher = botChatActivityWatcher(BOT);

    expect(watcher.observed(typedHere("m1", "   "))).toBeNull();
    expect(watcher.observed(typedHere("m2", ""))).toBeNull();
    // The latch is open, so an empty answer is refused on its own account rather than by direction.
    watcher.observed(typedHere("m3", "Anything"));
    expect(watcher.observed(fromStream("m4", "assistant", ""))).toBeNull();
  });

  test("the text a person typed alongside an attachment is what reports", () => {
    const watcher = botChatActivityWatcher(BOT);

    expect(
      watcher.observed(
        typedHere("m1", [
          { text: "What is in this?", type: "text" },
          {
            metadata: {},
            source: { mimeType: "image/png", type: "data", value: "AAAA" },
            type: "image",
          },
        ]),
      ),
    ).toEqual({
      agentId: null,
      firstFromPerson: true,
      text: "What is in this?",
    });
  });

  test("only the first thing a person says carries the flag the title refetch turns on", () => {
    /*
     * The flag is what buys "one refetch per conversation". The alternative — asking whether the
     * conversation still has no title — answers "no title yet" for every message sent while that
     * refetch is in flight, so a burst into a fresh conversation asks to be named once per message.
     */
    const watcher = botChatActivityWatcher(BOT);

    expect(watcher.observed(typedHere("m1", "First"))?.firstFromPerson).toBe(
      true,
    );
    expect(watcher.observed(typedHere("m2", "Second"))?.firstFromPerson).toBe(
      false,
    );
    expect(
      watcher.observed(fromStream("m3", "assistant", "Answer"))
        ?.firstFromPerson,
    ).toBe(false);
  });

  test("a message with no words does not spend the flag", () => {
    // Nothing was reported, so the server has had no message to derive a title from: the flag has to
    // wait for one that actually said something.
    const watcher = botChatActivityWatcher(BOT);

    watcher.observed(
      typedHere("m1", [
        {
          metadata: {},
          source: { mimeType: "image/png", type: "data", value: "AAAA" },
          type: "image",
        },
      ]),
    );

    expect(
      watcher.observed(typedHere("m2", "What is in this?"))?.firstFromPerson,
    ).toBe(true);
  });

  test("a replayed person's turn does not spend the flag either", () => {
    // It was not reported, so the server never saw it, so it cannot be the message the title came
    // from. Spending the flag on it would leave a conversation with a replayed history permanently
    // showing the Bot's name in the roster.
    const watcher = botChatActivityWatcher(BOT);

    watcher.observed(fromStream("h1", "user", "Yesterday's ask"));

    expect(
      watcher.observed(typedHere("m1", "Today's ask"))?.firstFromPerson,
    ).toBe(true);
  });

  test("the reported text is trimmed, so a preview never starts with whitespace", () => {
    const watcher = botChatActivityWatcher(BOT);

    expect(watcher.observed(typedHere("m1", "  Book it\n"))).toEqual({
      agentId: null,
      firstFromPerson: true,
      text: "Book it",
    });
  });
});

/**
 * Which watcher a conversation gets, which is the difference between this file's rules holding and
 * holding only for whoever remembers to re-mount the hook.
 */
describe("watcherFor", () => {
  const chatA = { agentId: BOT, id: "botchat-1" };
  const chatB = { agentId: "travel-agent", id: "botchat-2" };

  test("nothing held yet gets a watcher for this conversation", () => {
    expect(watcherFor(null, chatA).botChatId).toBe(chatA.id);
  });

  test("the same conversation keeps the watcher it already had", () => {
    // The only reason a caller holds one at all: a re-subscribe must not lose the "already reported"
    // set, or the tail of a thread this tab has already reported moves the roster a second time.
    const held = watcherFor(null, chatA);

    expect(watcherFor(held, chatA)).toBe(held);
  });

  test("a different conversation gets a watcher whose latch is closed", () => {
    /*
     * The failure this function exists to make impossible. A watcher carried across a navigation
     * arrives with `spokenHere` already latched by the previous conversation, so the first thing the
     * new one announces — its replayed history — is reported, which stamps `last_message_at` with
     * the moment of the navigation and clears `archived_at` on the way past: an archived
     * conversation un-archived by being opened.
     */
    const held = watcherFor(null, chatA);
    held.watcher.observed(typedHere("m1", "Said in the first conversation"));

    const next = watcherFor(held, chatB);

    expect(next).not.toBe(held);
    expect(next.botChatId).toBe(chatB.id);
    expect(
      next.watcher.observed(fromStream("h1", "assistant", "Stored answer")),
    ).toBeNull();
  });

  test("a different conversation's watcher reports its own Bot", () => {
    // The other thing a carried-over watcher gets wrong: it would attribute the new conversation's
    // replies to the previous Bot, and the server refuses any agent id but the conversation's own.
    const next = watcherFor(watcherFor(null, chatA), chatB);

    next.watcher.observed(typedHere("m1", "Hello"));

    expect(next.watcher.observed(fromStream("m2", "assistant", "Hi"))).toEqual({
      agentId: chatB.agentId,
      firstFromPerson: false,
      text: "Hi",
    });
  });
});
