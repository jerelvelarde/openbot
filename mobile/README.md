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
- **`src/data/http.ts`** — the same data from a real deployment, written against the endpoints the
  plan's Phase 1 and Phase 2 add (`GET`/`POST /api/approvals`, notifications) plus the channel routes
  that already exist. **Not reachable yet** — those routes do not exist on the server.

The seam is the point: the screens were finished once, against the interface, and the transport
swaps underneath when the server catches up.

Two things `http.ts` deliberately does not do. It never falls back to local data when a request
fails — a companion that quietly shows an invented approval queue is worse than one that says it is
offline. And it authenticates with a bearer token, never a cookie: a native client needs a token
flow, and the server must refuse to issue one while `OPENBOT_DEV_NO_AUTH` is set, because that flag
admits every caller as one administrator.

## Screens

| Screen | What it is for |
| --- | --- |
| Inbox | What is waiting on you. The home screen, and the reason the app exists. |
| Approval | One parked action, the rule that asked, and Allow once / Always allow / Refuse. |
| Channels | The Bots you are working with, and which are mid-turn. |
| Channel | The transcript, and the composer that queues while a Bot is busy. |
| Activity | Audit rows: permitted, refused, failed — every refusal with its rule. |

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

## Notes

- Navigation is hand-rolled rather than expo-router: three tabs and two pushed screens is less than a
  router's configuration would cost. Screens use React Native primitives only, so the same code runs
  on a device and in a browser.
- `mobile/` is **not** in the root `workspaces` array. Metro and Bun workspace hoisting fight each
  other, and this app has no dependency on the server's package graph.
- On web the app renders inside a device-sized frame. A companion stretched across a desktop window
  stops being an honest picture of itself.
