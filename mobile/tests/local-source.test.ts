import { describe, expect, test } from "bun:test";
import { createLocalSource } from "../src/data/local";
import type { LiveTurn } from "../src/data/types";

/**
 * The in-memory deployment, held to the same contract as the real one.
 *
 * It is not a stub that returns fixtures: it is what the screens are built against and what the
 * recordings show, so where it and the HTTP source disagree the demo is teaching people something
 * untrue about the product. These tests pin the parts that are easy to get wrong — a reply that
 * arrives as it is written, a message to a busy Bot being held rather than dropped, and a
 * conversation that can be started at all.
 */

/** The seeded channel is mid-turn from the start: it is parked on the approval. */
async function seeded() {
  const source = createLocalSource();
  const [channel] = await source.channels();
  if (!channel) throw new Error("the local source seeds one channel");
  return { source, channel };
}

describe("starting a conversation", () => {
  test("there is somebody to start one with", async () => {
    const { source } = await seeded();
    const bots = await source.bots();
    // More than one, because a picker with a single entry teaches nobody what the screen is for.
    expect(bots.length).toBeGreaterThan(1);
    expect(bots.every((bot) => bot.id && bot.name)).toBe(true);
  });

  test("a new channel is listed, readable and empty", async () => {
    const { source } = await seeded();
    const bots = await source.bots();
    const bot = bots[1];
    if (!bot) throw new Error("expected a second Bot");

    const before = (await source.channels()).length;
    const created = await source.createChannel(bot.id);

    expect(created.botId).toBe(bot.id);
    expect(created.lastMessage).toBeNull();
    expect((await source.channels()).length).toBe(before + 1);
    // Findable by the id the app routes on, which is what the channel screen looks it up by.
    expect((await source.channel(created.id))?.id).toBe(created.id);
    expect(await source.messages(created.id)).toEqual([]);
  });

  test("a Bot that does not exist is refused rather than invented", async () => {
    const { source } = await seeded();
    await expect(source.createChannel("nobody")).rejects.toThrow();
  });
});

describe("a reply", () => {
  test("arrives as it is written, and ends", async () => {
    const { source } = await seeded();
    const bot = (await source.bots())[1];
    if (!bot) throw new Error("expected a second Bot");
    const channel = await source.createChannel(bot.id);

    const turns: LiveTurn[] = [];
    await source.send(channel.id, "Anything.", {
      onTurn: (turn) => turns.push(turn),
    });

    // Several updates, not one: "it arrives as it is written" is the property under test.
    expect(turns.length).toBeGreaterThan(3);
    const last = turns[turns.length - 1];
    expect(last?.done).toBe(true);
    expect(last?.text.length).toBeGreaterThan(0);

    // Monotonic: text only ever grows, so nothing on screen is ever retracted.
    const lengths = turns.map((turn) => turn.text.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));

    // And a call that was drawn as running ended up with an outcome.
    expect(last?.toolLines.every((line) => line.outcome !== "running")).toBe(
      true,
    );
    expect(
      turns.some((turn) =>
        turn.toolLines.some((line) => line.outcome === "running"),
      ),
    ).toBe(true);
  });

  test("lands in the thread the transcript reads", async () => {
    const { source } = await seeded();
    const bot = (await source.bots())[1];
    if (!bot) throw new Error("expected a second Bot");
    const channel = await source.createChannel(bot.id);

    await source.send(channel.id, "Anything.");
    const messages = await source.messages(channel.id);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(messages[0]?.text).toBe("Anything.");
    // The roster's preview is what the channel list shows, and it must not be the question.
    expect((await source.channel(channel.id))?.lastMessage).toBe(
      messages[1]?.text,
    );
  });

  test("a skill changes what the Bot was asked, not what the person said", async () => {
    const { source } = await seeded();
    const bot = (await source.bots())[1];
    if (!bot) throw new Error("expected a second Bot");
    const channel = await source.createChannel(bot.id);
    const skills = await source.skills(channel.id);
    const skill = skills[0];
    if (!skill) throw new Error("expected a granted skill");

    await source.send(channel.id, "Go on then.", { skills: [skill] });
    const messages = await source.messages(channel.id);

    // The person's own words, unchanged: a skill is a system turn in front of them, never pasted in.
    expect(messages[0]?.text).toBe("Go on then.");
    expect(messages[0]?.text).not.toContain(skill.instructions);
    // And the skill's instruction is nowhere in the transcript either.
    expect(
      messages.some((message) => message.text?.includes(skill.instructions)),
    ).toBe(false);
  });

  test("every skill carries the instruction that is actually sent", async () => {
    const { source, channel } = await seeded();
    for (const skill of await source.skills(channel.id)) {
      expect(skill.slug).toBeTruthy();
      expect(skill.title).toBeTruthy();
      expect(skill.instructions.length).toBeGreaterThan(20);
    }
  });
});

describe("a Bot that is already working", () => {
  test("holds what it is told rather than dropping it", async () => {
    const { source, channel } = await seeded();
    // The seeded channel is parked on an approval, which is the one "busy" this app claims.
    expect(channel.busy).toBe(true);

    const turns: LiveTurn[] = [];
    const result = await source.send(channel.id, "While you are there.", {
      onTurn: (turn) => turns.push(turn),
    });

    expect(result.queued).toBe(true);
    // Nothing streamed, because nothing ran: the words are in the thread, the run is deferred.
    expect(turns).toEqual([]);
    const messages = await source.messages(channel.id);
    const last = messages[messages.length - 1];
    expect(last?.text).toBe("While you are there.");
    expect(last?.queued).toBe(true);
  });

  test("a message to a channel that is gone is refused", async () => {
    const { source } = await seeded();
    await expect(source.send("channel_nowhere", "Hello.")).rejects.toThrow();
  });
});
