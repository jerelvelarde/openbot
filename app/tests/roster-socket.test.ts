import { describe, expect, test } from "bun:test";
import {
  type RosterActivityEvent,
  type RosterSocket,
  startRosterSocket,
} from "../src/lib/channels/use-channel-events";

/**
 * A stand-in for the one `WebSocket` the loop drives.
 *
 * Structural rather than a mock library, and deliberately no more than `RosterSocket` declares: the
 * four handlers and `close` are the whole of what the loop can touch, so a fake that offers exactly
 * those cannot drift from what the browser gives it. The three methods below fire the events a
 * browser fires, with the real event objects, so nothing here depends on the loop ignoring them.
 */
class FakeSocket implements RosterSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closes = 0;

  close() {
    this.closes += 1;
  }

  opened() {
    this.onopen?.(new Event("open"));
  }

  delivered(activity: Partial<RosterActivityEvent> & { id: string }) {
    const frame = {
      kind: "channel",
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      ...activity,
    };
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }

  /** Whatever the frame happens to be, readable or not. */
  deliveredRaw(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  dropped() {
    this.onclose?.(new CloseEvent("close"));
  }
}

/**
 * The timers, as values.
 *
 * The loop keeps two kinds — the reconnect and the one that decides a socket has held — and this does
 * not need to tell them apart: only ever one of them is pending at a time, which is itself worth
 * asserting, so `fireOnly` refuses to guess. It returns the delay it fired, which is what the backoff
 * tests are actually about.
 */
function fakeClock() {
  type Timer = { delay: number; run: () => void; live: boolean };
  const timers: Timer[] = [];

  return {
    schedule(run: () => void, delay: number) {
      timers.push({ delay, run, live: true });
      return timers.length;
    },
    cancel(handle: number) {
      const timer = timers[handle - 1];
      if (timer) timer.live = false;
    },
    fireOnly() {
      const live = timers.filter((timer) => timer.live);
      const [timer] = live;
      if (live.length !== 1 || !timer) {
        throw new Error(`expected one pending timer, found ${live.length}`);
      }
      timer.live = false;
      timer.run();
      return timer.delay;
    },
    pending() {
      return timers.filter((timer) => timer.live).map((timer) => timer.delay);
    },
  };
}

function harness() {
  const clock = fakeClock();
  const sockets: FakeSocket[] = [];
  const events: RosterActivityEvent[] = [];
  const recoveries = { count: 0 };

  const stop = startRosterSocket({
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (run, delay) => clock.schedule(run, delay),
    cancel: (handle) => clock.cancel(handle),
    onEvent: (activity) => {
      events.push(activity);
    },
    recoverMissedEvents: () => {
      recoveries.count += 1;
    },
  });

  return {
    clock,
    sockets,
    events,
    recoveries,
    stop,
    /** The socket the loop is currently on. A reconnect makes a new one. */
    latest() {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("the loop has not connected");
      return socket;
    },
    /** One round of accept-and-drop, answering with the delay the reconnect was scheduled at. */
    flap() {
      this.latest().opened();
      this.latest().dropped();
      return clock.fireOnly();
    },
  };
}

/**
 * The loop against a server that completes the upgrade and closes without saying anything.
 *
 * A misconfigured proxy, a replica shutting down, an upgrade that succeeds before an auth check
 * fails: the socket opens, so every "did it work" signal that reads `onopen` says yes, and the tab
 * reconnects at the first delay forever. Twice a second, with a three-list roster refetch on each.
 */
describe("a socket that opens and immediately closes", () => {
  test("backs the reconnect off rather than retrying at the first delay forever", () => {
    const live = harness();

    const delays = [live.flap(), live.flap(), live.flap(), live.flap()];

    // Resetting the backoff on `onopen` — which is where the reset used to be — made every one of
    // these 500, because the socket genuinely did open every time.
    expect(delays).toEqual([500, 1000, 2000, 4000]);
  });

  test("does not refetch the roster on every open", () => {
    const live = harness();

    live.flap();
    live.flap();
    live.flap();
    live.flap();

    // Zero, and zero is the right number here rather than merely a smaller one: this tab has a
    // roster its own query fetched, no live connection has been established since, and nothing it
    // could refetch would be fresher than the last refetch of the same broken loop.
    expect(live.recoveries.count).toBe(0);
  });

  test("polls once per attempt once the backoff has bottomed out", () => {
    const live = harness();

    // 500 doubling to the 30s ceiling takes six closes.
    expect([
      live.flap(),
      live.flap(),
      live.flap(),
      live.flap(),
      live.flap(),
      live.flap(),
    ]).toEqual([500, 1000, 2000, 4000, 8000, 16_000]);
    expect(live.recoveries.count).toBe(0);

    live.latest().opened();

    // The socket is the only clock this tab has, `refetchOnWindowFocus` is off, and once the backoff
    // has given up on getting a live connection there is nothing left to bound the roster's staleness
    // at all. So the attempt doubles as the poll — one refetch per 30 seconds rather than two per
    // second, and none until the attempts are that far apart.
    expect(live.recoveries.count).toBe(1);
    live.latest().dropped();
    expect(live.clock.fireOnly()).toBe(30_000);
    live.latest().opened();
    expect(live.recoveries.count).toBe(2);
  });
});

/**
 * The connection that does hold, which is what the reset and the recovery refetch are for.
 */
describe("a socket that holds open", () => {
  test("refetches the roster once it has held, not the moment it opens", () => {
    const live = harness();

    live.latest().opened();
    // An open is not a connection. The accept-and-drop loop above proves that much.
    expect(live.recoveries.count).toBe(0);

    expect(live.clock.fireOnly()).toBe(1000);
    expect(live.recoveries.count).toBe(1);
  });

  test("puts the reconnect back at its first delay", () => {
    const live = harness();
    live.flap();
    live.flap();
    live.flap();

    live.latest().opened();
    live.clock.fireOnly();
    live.latest().dropped();

    // 500 again, not 8000: the backoff climbs against a broken server and forgets the moment one
    // connection works, so a tab that reconnects after a genuine outage is not left waiting out a
    // delay the outage earned.
    expect(live.clock.fireOnly()).toBe(500);
  });
});

describe("a frame", () => {
  test("is proof the connection works, without waiting for the timer to say so", () => {
    const live = harness();
    live.flap();
    live.flap();
    live.flap();

    live.latest().opened();
    live
      .latest()
      .delivered({ id: "channel_1", lastMessage: "Said something." });
    live.latest().dropped();

    // A connection that delivered a roster event did the job this socket exists for, however briefly
    // it lasted, so the next reconnect is prompt.
    expect(live.clock.fireOnly()).toBe(500);
  });

  test("reaches the caller once it reads as an event", () => {
    const live = harness();
    live.latest().opened();

    live
      .latest()
      .delivered({ id: "channel_1", lastMessage: "Said something." });

    expect(live.events.map((activity) => activity.id)).toEqual(["channel_1"]);
  });

  test("that cannot be read never reaches the caller", () => {
    const live = harness();
    live.latest().opened();
    const realError = console.error;
    console.error = () => {};

    try {
      live.latest().deliveredRaw("null");
    } finally {
      console.error = realError;
    }

    // `readRosterEvent` has said so out loud; what matters here is that nothing downstream is handed
    // a frame with no row in it.
    expect(live.events).toEqual([]);
  });
});

/**
 * Teardown, which is where a frame outlived the screen it was for.
 *
 * `onclose` and `onerror` were detached and `onmessage` was not, so a frame already queued behind the
 * cleanup still ran the whole handler — patching caches for an unmounted tree and, for a `deleted`
 * frame, navigating a router the screen no longer has.
 */
describe("teardown", () => {
  test("detaches onmessage with its siblings", () => {
    const live = harness();
    live.latest().opened();

    live.stop();

    expect(live.latest().onmessage).toBeNull();
    expect(live.latest().onclose).toBeNull();
    expect(live.latest().onerror).toBeNull();
    // `onopen` too, which was the fourth one left attached: it schedules a timer now, and one
    // scheduled after teardown is one nobody cancels.
    expect(live.latest().onopen).toBeNull();
  });

  test("hands nothing to the caller from a frame that arrives after it", () => {
    const live = harness();
    live.latest().opened();

    live.stop();
    live.latest().delivered({ id: "channel_1", deleted: true });

    // The `deleted` frame specifically, because that is the one whose handling navigates.
    expect(live.events).toEqual([]);
  });

  test("closes the socket, cancels every timer, and never reconnects", () => {
    const live = harness();
    live.latest().opened();

    live.stop();

    expect(live.latest().closes).toBe(1);
    expect(live.clock.pending()).toEqual([]);
    expect(live.sockets).toHaveLength(1);
  });

  test("does not reconnect for a close it caused itself", () => {
    const live = harness();
    live.latest().opened();

    live.stop();
    // A real browser fires `close` for the `close()` above. The handler is detached, so this is the
    // belt: even fired directly, it must not schedule a reconnect for a screen that is gone.
    live.latest().dropped();

    expect(live.clock.pending()).toEqual([]);
    expect(live.sockets).toHaveLength(1);
  });
});
