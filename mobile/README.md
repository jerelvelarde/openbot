# OpenBot Mobile

The companion for the asynchronous half of OpenBot — the half that exists because a Bot works while
nobody is watching. Answer an approval, get told a routine failed, steer a Bot that is mid-turn, read
what it did.

It is deliberately **not** a small copy of the web app. Boundaries, credentials, connectors, the
component playground and take-the-wheel all stay where they belong, on a screen big enough for them.

## Run it

```sh
cd mobile
bun install
bun run ios      # or: bun run android
bun run web      # the same app in a browser, framed at phone size
```

Nothing else is required: no Docker, no Postgres, no model key. See the data source below.

## Where the data comes from

`src/data/source.ts` declares one interface with two implementations:

- **`src/data/local.ts`** — a deployment in memory, and the default. Not a fixture dump: answering an
  approval really does resume the parked turn, a refusal really does write the rule that caused it
  into the trail, and a message sent to a busy Bot really is held and drained into one follow-up
  turn. That behaviour is what the screens are built against.
- **`src/data/http.ts`** — the same data from a real deployment: `/api/approvals`, `/api/channels`,
  `/api/agents`, `/api/audit`, and the runtime's own thread history and run endpoint under
  `/api/copilotkit`. All of those exist. Sending a message starts a real AG-UI run.

The seam is still the point: the screens were finished once against the interface, and either
transport can be swapped underneath without touching them.

One thing `http.ts` deliberately does not do: it never falls back to local data when a request
fails. A companion that quietly shows an invented approval queue is worse than one that says it is
offline, so it says `Could not reach this deployment` and keeps the last thing it was told.

How it authenticates depends on how it was started. Same-origin — the web build behind
`scripts/dev-proxy.ts` — is authenticated by the browser's own session cookie, which is why a
recording needs no token. A build pointed at a deployment over the network signs in through the
system browser and holds a session token in the platform's secure store. See
[docs/mobile.md](../docs/mobile.md).

## Screens

| Screen | What it is for |
| --- | --- |
| Inbox | What is waiting on you. The home screen, and the reason the app exists. |
| Approval | One parked action, the rule that asked, and Allow once / Always allow / Refuse. |
| Channels | The Bots you are working with, and which are mid-turn. |
| Channel | The transcript, and the composer that queues while a Bot is busy. |
| Activity | Audit rows: permitted, refused, failed — every refusal with its rule. |
| Sign in | One button, which opens the system browser. This app has no password field. |

## Rules this app holds itself to

- **Show the server's account, never the model's.** The element label on an approval is the one the
  gateway resolved from its own snapshot. A screen asking you to approve the model's summary of its
  own intention would be trusting the exact thing the policy exists not to trust.
- **A refusal carries its rule.** "Blocked" without the rule sends a person hunting through
  Boundaries for something they cannot name.
- **Always-allow is a rule, not a flag.** It writes a scoped allow rule, visible and editable in
  `/admin/boundaries` like any other.
- **Never a secret's value.** Only the label the person was asked for.
- **Nothing an audit trail would redact.** Notification bodies carry the resolved subject and no
  more: no argument values, no file contents, no message bodies. A push payload is a less trusted
  surface than the audit trail, not a more trusted one.

## Notifications

Four things buzz: an approval, a question, work you asked to be told about, and something unattended
that stopped. Nothing else. The server decides all of it — what is worth a notification and what a
notification may say — because a phone is not where that judgement belongs. `src/data/push.ts` only
gets the platform's token and hands it over.

## Notes

- Navigation is hand-rolled rather than expo-router: three tabs and two pushed screens is less than a
  router's configuration would cost. Screens use React Native primitives only, so the same code runs
  on a device and in a browser.
- `mobile/` is **not** in the root `workspaces` array. Metro and Bun workspace hoisting fight each
  other, and this app has no dependency on the server's package graph.
- On web the app renders inside a device-sized frame at 393 x 852 points, scaled to the window. A
  companion stretched across a desktop window stops being an honest picture of itself, and the frame
  is also what makes a recording of it legible.
- A Bot's face is drawn from its `avatarSeed` with the same hash, palette and composition the web app
  gets from `boring-avatars`, ported to React Native views. Same seed, same avatar — drawn crisply
  rather than blurred, because the blur needs a native module.
