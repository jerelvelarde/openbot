import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { botChatActivityWatcher } from "../src/lib/bot-chats/activity";

/**
 * What a bot chat reports to the roster, and what it stays quiet about.
 *
 * The screen this serves renders the packaged `CopilotChat`, so the only way it learns what was said
 * is by watching the agent instance that chat binds to. Every rule here is about telling two things
 * apart on that one channel: something just said, which has to move the roster, and a thread's stored
 * history announcing itself again, which must not. Getting the second one wrong is not cosmetic — a
 * report un-archives the conversation it lands on, so it would restore an archive by navigation.
 *
 * No render harness anywhere in this suite, which is why the decision lives in a plain state machine
 * and this file drives it directly.
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
    ).toEqual({ agentId: null, text: "Book the Tuesday flight" });
  });

  test("the Bot's reply reports as the Bot, which is what raises the unseen dot", () => {
    const watcher = botChatActivityWatcher(BOT);

    watcher.observed(typedHere("m1", "Book the Tuesday flight"));

    expect(watcher.observed(fromStream("m2", "assistant", "Booked."))).toEqual({
      agentId: BOT,
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
    ).toEqual({ agentId: BOT, text: "Let me look." });
    expect(
      watcher.observed(fromStream("m3", "assistant", "£61 on Tuesday.")),
    ).toEqual({ agentId: BOT, text: "£61 on Tuesday." });
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
    ).toEqual({ agentId: null, text: "What is in this?" });
  });

  test("the reported text is trimmed, so a preview never starts with whitespace", () => {
    const watcher = botChatActivityWatcher(BOT);

    expect(watcher.observed(typedHere("m1", "  Book it\n"))).toEqual({
      agentId: null,
      text: "Book it",
    });
  });
});
