import { describe, expect, test } from "bun:test";
import {
  linkFor,
  menuFor,
  openConversationId,
} from "../src/components/app-sidebar/roster-row";

describe("openConversationId", () => {
  test("resolves a channel route from channelId alone", () => {
    expect(openConversationId({ channelId: "channel_1" })).toBe("channel_1");
  });

  test("resolves a bot chat route from botChatId alone", () => {
    expect(openConversationId({ botChatId: "botchat_1" })).toBe("botchat_1");
  });

  test("resolves to undefined when neither param is present", () => {
    expect(openConversationId({})).toBeUndefined();
  });

  test("prefers channelId when both are present, an arbitrary but fixed choice", () => {
    // No route ever matches both params at once, so this case cannot occur in the app — the
    // precedence just has to be fixed, not meaningful, so the two callers agree on it.
    expect(
      openConversationId({ channelId: "channel_1", botChatId: "botchat_1" }),
    ).toBe("channel_1");
  });
});

describe("linkFor", () => {
  test("sends a channel row to the channel screen", () => {
    expect(linkFor({ kind: "channel", id: "channel_1" })).toEqual({
      to: "/channel/$channelId",
      params: { channelId: "channel_1" },
    });
  });

  test("sends a bot chat row to its own screen", () => {
    // A roster row that does not open what it names is worse than no row at all.
    expect(linkFor({ kind: "bot_chat", id: "botchat_1" })).toEqual({
      to: "/bot/$botChatId",
      params: { botChatId: "botchat_1" },
    });
  });
});

describe("menuFor", () => {
  test("offers Archive on a live row", () => {
    expect(menuFor({ archived: false, pinned: false })).toEqual([
      "pin",
      "archive",
      "delete",
    ]);
  });

  test("offers Restore in place of Archive on an archived row", () => {
    expect(menuFor({ archived: true, pinned: false })).toEqual([
      "pin",
      "restore",
      "delete",
    ]);
  });

  test("offers Unpin in place of Pin on a pinned row", () => {
    expect(menuFor({ archived: false, pinned: true })).toEqual([
      "unpin",
      "archive",
      "delete",
    ]);
  });
});
