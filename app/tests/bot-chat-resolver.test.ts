import { describe, expect, test } from "bun:test";
import { resolveBotChat } from "../src/routes/_authed/_app/bot";

describe("resolveBotChat", () => {
  test("opens the conversation this person was last in", () => {
    expect(resolveBotChat({ mostRecent: "botchat_1" })).toEqual({
      open: "botchat_1",
    });
  });

  test("starts one when there is nothing to open", () => {
    // A first visit, or a person who archived everything: `?agent=` must still land somewhere usable.
    expect(resolveBotChat({ mostRecent: null })).toEqual({ create: true });
  });
});
