import { describe, expect, test } from "bun:test";
import {
  linkFor,
  menuFor,
  openConversationId,
  rowMarkers,
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

describe("rowMarkers", () => {
  test("marks an archived row, so the All list can tell one from a live row", () => {
    // The All tab holds both kinds of row. Without this marker the only way to tell an archived
    // conversation from a live one was to right-click it and read whether the menu said Archive or
    // Restore — which is the tri-state filter's whole point, undone.
    const live = rowMarkers({ unread: false, archived: false, pinned: false });
    const archived = rowMarkers({
      unread: false,
      archived: true,
      pinned: false,
    });
    expect(archived).toEqual(["archived"]);
    expect(live).toEqual([]);
  });

  test("puts state about the message before state about the row", () => {
    expect(rowMarkers({ unread: true, archived: true, pinned: true })).toEqual([
      "unread",
      "archived",
      "pinned",
    ]);
  });
});
