import { describe, expect, test } from "bun:test";
import {
  ControlError,
  ControlRequestError,
  createControl,
  secretIsForThisPage,
  secretMovedMessage,
} from "../src/control";

/**
 * The wheel, tested on both paths.
 *
 * This is the piece standing between two drivers and one page, and until now it had no tests at all, * it lived as a `let` inside the file that imports playwright, so a test could not reach it without
 * launching Chrome. What is checked here is mostly the refusal path, because that is where this
 * component earns its keep: a Bot clicking while a person types, a secret typed when nothing asked for
 * one, a request answered twice, a handover that leaves a password box open behind it.
 *
 * A fake clock is injected so `since` can be asserted rather than shrugged at.
 */
function fixture() {
  let tick = 0;
  const at = () => `2026-08-14T00:00:0${tick}.000Z`;
  const control = createControl(() => {
    tick += 1;
    return at();
  });
  return { control };
}

describe("the happy path: ask, hand over, hand back", () => {
  test("starts with the Bot driving and nothing pending", () => {
    const { control } = fixture();
    const state = control.get();
    expect(state.holder).toBe("bot");
    expect(state.requested).toBe(false);
    expect(state.reason).toBeUndefined();
    expect(control.pendingSecret()).toBeNull();
    // Nothing to refuse yet.
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("the Bot asking for help does NOT hand itself the human's authority", () => {
    const { control } = fixture();
    const state = control.requestHelp("There is a login wall.");
    // The flag is raised and a person decides. A Bot that could take control on its own behalf could
    // also hand a person a page they never asked to see.
    expect(state.requested).toBe(true);
    expect(state.reason).toBe("There is a login wall.");
    expect(state.holder).toBe("bot");
    // And it may still act while it waits: asking is not being blocked.
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("taking the wheel keeps the reason and lowers the flag", () => {
    const { control } = fixture();
    control.requestHelp("Sign in to continue.");
    const state = control.take();
    expect(state.holder).toBe("human");
    // The reason survives, because it is the thing the person was just asked to do.
    expect(state.reason).toBe("Sign in to continue.");
    // The request is answered, so the surface stops asking.
    expect(state.requested).toBe(false);
    expect(control.humanMayDrive()).toBe(true);
  });

  test("handing back returns the wheel and clears the old request", () => {
    const { control } = fixture();
    control.requestHelp("Sign in to continue.");
    control.take();
    const state = control.release();
    expect(state.holder).toBe("bot");
    // Dropped on purpose: leaving it set has the surface still showing a request that was dealt with.
    expect(state.reason).toBeUndefined();
    expect(state.requested).toBe(false);
    expect(control.humanMayDrive()).toBe(false);
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("`since` moves on a handover and not on a request", () => {
    const { control } = fixture();
    const created = control.get().since;
    control.requestHelp("Stuck.");
    // Asking for help is not a change of driver, so the clock does not restart.
    expect(control.get().since).toBe(created);
    expect(control.take().since).not.toBe(created);
  });
});

describe("the crappy paths: two drivers, one page", () => {
  test("the Bot is refused while a person holds the wheel", () => {
    const { control } = fixture();
    control.take();
    expect(() => control.assertBotMayAct()).toThrow(ControlError);
    // Refused with a reason the Bot can act on, wait, rather than a bare failure.
    expect(() => control.assertBotMayAct()).toThrow(/hand it back/);
  });

  test("the refusal lifts the moment the person hands back", () => {
    const { control } = fixture();
    control.take();
    control.release();
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("a person's input is not applied merely because they asked", () => {
    const { control } = fixture();
    control.requestHelp("Sign in.");
    // The Bot asked for help and no person has taken the wheel. An open socket is not permission: this is
    // what stops anything that can reach the port from driving the browser mid-task.
    expect(control.humanMayDrive()).toBe(false);
  });

  test("taking the wheel twice is not a way to lose the reason", () => {
    const { control } = fixture();
    control.requestHelp("Sign in.");
    control.take();
    const state = control.take();
    expect(state.holder).toBe("human");
    expect(state.reason).toBe("Sign in.");
  });

  test("handing back when the Bot already has it is harmless", () => {
    const { control } = fixture();
    const state = control.release();
    expect(state.holder).toBe("bot");
    expect(() => control.assertBotMayAct()).not.toThrow();
  });

  test("the caller cannot reach in and change the state it was handed", () => {
    const { control } = fixture();
    const state = control.get();
    state.holder = "human";
    // A copy, so reading the state is not a way to take the wheel.
    expect(control.get().holder).toBe("bot");
  });

  test("junk reasons fall back to something a person can read", () => {
    const { control } = fixture();
    // The wire carries whatever the caller sent. An empty or non-string reason must not leave the
    // person staring at a blank explanation of why they have just been handed a browser.
    for (const junk of ["", "   ", null, undefined, 42, {}]) {
      const { control: fresh } = fixture();
      expect(fresh.requestHelp(junk).reason).toBe(
        "The assistant needs a person to continue.",
      );
    }
    expect(control.requestHelp("  Trimmed.  ").reason).toBe("Trimmed.");
  });
});

describe("the crappy paths: secrets", () => {
  test("a secret request must name the field it goes in", () => {
    const { control } = fixture();
    // The version without this typed the value into whatever happened to have focus, and reported
    // success when that was nothing at all.
    for (const bad of [{}, { ref: "" }, { ref: "   " }, { ref: 7 }]) {
      expect(() => control.requestSecret(bad)).toThrow(ControlRequestError);
    }
    // A request error, not a control refusal: the caller asked wrongly and no driver changed.
    expect(() => control.requestSecret({})).toThrow(/which field/);
    expect(control.pendingSecret()).toBeNull();
  });

  test("a secret request records the label and the field, and nothing else", () => {
    const { control } = fixture();
    const state = control.requestSecret({
      label: "  the six-digit code  ",
      ref: "e12",
      snapshotId: 3,
    });
    expect(state.secretWanted).toBe("the six-digit code");
    expect(state.secretRef).toBe("e12");
    expect(state.secretSnapshotId).toBe(3);
    expect(control.pendingSecret()).toEqual({ ref: "e12", snapshotId: 3 });
  });

  test("an unlabelled request still says something honest", () => {
    const { control } = fixture();
    expect(control.requestSecret({ ref: "e1" }).secretWanted).toBe(
      "the value this page is asking for",
    );
  });

  test("a non-numeric snapshotId is dropped rather than carried as junk", () => {
    const { control } = fixture();
    const state = control.requestSecret({ ref: "e1", snapshotId: "3" });
    // Carried through to `locateRef`, where a string would prevent the numeric staleness check from
    // matching and could let a stale field accept the secret.
    expect(state.secretSnapshotId).toBeUndefined();
  });

  test("nothing is pending until the Bot asks", () => {
    const { control } = fixture();
    // What makes the masked box scoped rather than a general-purpose way to type into the page.
    expect(control.pendingSecret()).toBeNull();
  });

  test("a supplied secret closes the request, so it cannot be answered twice", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "code" });
    control.secretSupplied();
    expect(control.pendingSecret()).toBeNull();
    expect(control.get().secretWanted).toBeUndefined();
    expect(control.get().secretRef).toBeUndefined();
  });

  test("a FAILED attempt leaves the request open", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "code" });
    // `secretSupplied` is called only after the value reached the field, so a field that could not be
    // found leaves this pending and the person can try again instead of starting over.
    expect(control.pendingSecret()).not.toBeNull();
  });

  test("handing the wheel over or back closes any pending secret", () => {
    for (const handover of ["take", "release"] as const) {
      const { control } = fixture();
      control.requestSecret({ ref: "e12", label: "password" });
      control[handover]();
      // A person who drove the browser themselves has dealt with the login. A masked box still asking
      // for a password afterwards is asking for a secret nothing is waiting for.
      expect(control.pendingSecret()).toBeNull();
      expect(control.get().secretWanted).toBeUndefined();
    }
  });

  test("the secret VALUE is never anywhere in the state", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", label: "one-time code" });
    // The machine has no field that could hold it, and this test exists to fail if one is ever added.
    // The value passes through a single request, into the page, and is not kept.
    const serialised = JSON.stringify(control.get());
    expect(serialised).not.toContain("value:");
    expect(
      Object.keys(control.get())
        .filter((k) => /secret/i.test(k))
        .sort(),
    ).toEqual([
      // Whose document the field was on, which is the only part of a secret request a person ever
      // sees besides its label, and which page it was. Both are here because a ref alone stopped
      // being enough once the Bot began following the windows a site opens.
      "secretOrigin",
      "secretPageId",
      "secretRef",
      "secretSnapshotId",
      "secretWanted",
    ]);
  });

  /**
   * A ref is only meaningful against the document it was taken from.
   *
   * The Bot follows a page a site opens in a second window, because a person cannot finish a popup
   * sign-in they cannot see. That made the browser able to be somewhere else by the time somebody
   * answers a secret request, and refs are minted per snapshot, so `e3` exists on that page too and
   * names something else on it. Measured before this existed: the request was for an API key field on
   * the page underneath, and the value went into the popup's public search box, with `supplied: true`
   * in the response.
   *
   * The rest of the secret path is deliberately permissive about the snapshot generation, because a
   * Bot may reasonably take another snapshot of the same page while waiting. This is the one thing it
   * cannot be permissive about.
   */
  test("a secret request remembers which page it was made for, and whose", () => {
    const { control } = fixture();
    control.requestSecret({
      ref: "e12",
      label: "API key",
      pageId: "p3",
      origin: "https://example.test",
    });

    expect(control.pendingSecret()).toMatchObject({
      pageId: "p3",
      origin: "https://example.test",
    });
    // The origin is on the state as well as the pending record, because it is what the masked box
    // shows the person. A prompt for a password with no address on it cannot be checked.
    expect(control.get().secretOrigin).toBe("https://example.test");
  });

  test("a page or an origin that is not a non-empty string is dropped rather than carried as junk", () => {
    const { control } = fixture();
    control.requestSecret({ ref: "e12", pageId: 3, origin: "" });

    expect(control.pendingSecret()?.pageId).toBeUndefined();
    expect(control.pendingSecret()?.origin).toBeUndefined();
  });

  test("the page a request was for goes when the request does", () => {
    const { control } = fixture();
    control.requestSecret({
      ref: "e12",
      pageId: "p3",
      origin: "https://x.test",
    });
    control.secretSupplied();

    expect(control.get().secretPageId).toBeUndefined();
    expect(control.get().secretOrigin).toBeUndefined();
  });
});

/**
 * Whether the browser is still on the page a pending secret names.
 *
 * The page, not a count of switches. Counting was the first answer and it was wrong in both
 * directions worth caring about: it refused a secret after a window opened and closed again, when the
 * browser was back on the page the ref names and the ref still resolved — throwing away what the
 * person had typed and making the Bot ask afresh, which an advert opening a window on a timer could
 * farm into a loop. And a count says nothing at all about a page that navigated itself somewhere
 * else while staying the same page.
 */
describe("deciding whether a pending secret still names the page in front", () => {
  const front = { pageId: "p1", origin: "https://typefully.test" };

  test("the same page showing the same site is the page it was asked for", () => {
    expect(secretIsForThisPage({ ...front }, front)).toBe(true);
  });

  test("another page is refused even when it is the same site", () => {
    // Two tabs on one site are two documents, and `e3` on one is not `e3` on the other.
    expect(
      secretIsForThisPage(
        { pageId: "p2", origin: "https://typefully.test" },
        front,
      ),
    ).toBe(false);
  });

  test("the same page showing another site is refused", () => {
    // A page can navigate itself without ever ceasing to be the same page, which is why the id alone
    // does not answer this.
    expect(
      secretIsForThisPage({ pageId: "p1", origin: "https://evil.test" }, front),
    ).toBe(false);
  });

  test("a window that opened and closed again leaves the request answerable", () => {
    /*
     * The regression the counter caused, stated as the behaviour it broke. Opener, popup, popup
     * closed: the browser is back where it started, the ref still resolves, and the person's paste
     * must not be thrown away and asked for again.
     */
    expect(secretIsForThisPage({ ...front }, front)).toBe(true);
  });

  test("the refusal says what actually moved", () => {
    /*
     * Measured, not imagined. The first version of this named both origins unconditionally, and in a
     * run against a real browser — where a site opened a second window on itself — it produced "was
     * asked for on X and the browser is now on X", which reads as a broken refusal rather than as a
     * reason to be careful.
     */
    const acrossSites = secretMovedMessage(
      { pageId: "p1", origin: "https://typefully.test" },
      { origin: "https://accounts.evil.test" },
    );
    expect(acrossSites).toContain("https://typefully.test");
    expect(acrossSites).toContain("https://accounts.evil.test");

    const sameSite = secretMovedMessage(
      { pageId: "p1", origin: "https://typefully.test" },
      { origin: "https://typefully.test" },
    );
    expect(sameSite).toContain("a different window");
    expect(sameSite).not.toMatch(/typefully\.test.*typefully\.test/);
  });

  test("the refusal always says nothing was typed", () => {
    // The person has just handed over a password. Whether it went anywhere is the first thing they
    // need to know, and it is the part a terse refusal leaves them guessing about.
    for (const front of [
      { origin: "https://typefully.test" },
      { origin: "https://evil.test" },
    ]) {
      expect(
        secretMovedMessage(
          { pageId: "p1", origin: "https://typefully.test" },
          front,
        ),
      ).toContain("Nothing was typed");
    }
  });

  test("a request that recorded no page is not refused on missing information", () => {
    // Only reachable from a caller that asked for a secret before anything had looked at a page,
    // which no real Bot does: it has to snapshot to have a ref at all.
    expect(secretIsForThisPage({}, front)).toBe(true);
    expect(secretIsForThisPage({ pageId: "p1" }, front)).toBe(true);
    expect(secretIsForThisPage({ origin: "https://x.test" }, front)).toBe(true);
  });
});

/**
 * A request nobody answered does not outlive the run that made it.
 *
 * Control belongs to the computer, not to a conversation, and an unanswered request used to sit on
 * it forever. The run that asked had ended, but every later conversation with that Bot showed a live
 * "Take control" for work it was not doing — and showed the reason the Bot gave, which is written
 * for whoever asked and was being rendered to whoever looked.
 *
 * Seen in the product: a brand new channel, on an unrelated question, displaying "Google Docs is
 * asking for sign-in before I can read the PRD document" from a conversation minutes earlier.
 */
describe("an unanswered request to take the wheel", () => {
  test("is still shown inside the window", () => {
    let clock = "2026-08-22T03:00:00.000Z";
    const control = createControl(() => clock);
    control.requestHelp("sign in to Drive");

    clock = "2026-08-22T03:05:00.000Z";
    const state = control.get();
    expect(state.requested).toBe(true);
    expect(state.reason).toBe("sign in to Drive");
  });

  test("stops being shown once it is stale, and takes its reason with it", () => {
    let clock = "2026-08-22T03:00:00.000Z";
    const control = createControl(() => clock);
    control.requestHelp("sign in to Drive");

    clock = "2026-08-22T03:20:00.000Z";
    const state = control.get();
    expect(state.requested).toBe(false);
    // The reason is the part that leaked between conversations, so it goes too.
    expect(state.reason).toBeUndefined();
  });

  test("never takes the wheel back off a person who holds it", () => {
    /*
     * The one case that must not expire. Somebody may be halfway through typing a code, and pulling
     * the browser back mid-sign-in is worse than any stale prompt. Only the ASK times out.
     */
    let clock = "2026-08-22T03:00:00.000Z";
    const control = createControl(() => clock);
    control.requestHelp("sign in to Drive");
    control.take();

    clock = "2026-08-22T04:00:00.000Z";
    expect(control.get().holder).toBe("human");
  });
});
