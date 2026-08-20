# The companion app

A phone app for the half of OpenBot that happens while nobody is watching.

It is not the web app on a small screen. The web app is where you work with a Bot: you watch its
browser, take the wheel, approve a component, read a long transcript. The companion is for the
moments when a Bot needs *you* and you are not at a desk — an action parked waiting for an answer, a
sign-in it cannot do itself, a routine that stopped overnight.

Four screens: what is waiting on you, the channels you have, one conversation, and the audit trail.

## Running it

```bash
cd mobile
bun install
bun start          # then press i, a, or w
```

With nothing configured it runs against an in-memory deployment — real state machine, no server, no
Docker, no model key. Every screen works, an approval can be answered, and the banner across the top
says `Local · nothing behind it` so a screenshot of it can never be mistaken for a real one.

To point it at a deployment:

```bash
EXPO_PUBLIC_OPENBOT_API=https://openbot.example bun start
```

The banner then says `Live · https://openbot.example`, which exists because "is this real?" is the
first question anybody asks of a screenshot of an approval.

### The web build, and recording it

React Native Web runs the same code in a browser, which is how the flows are recorded without a
simulator. The API has no CORS configuration and should not gain any for a recording, so the build is
served from one origin with the API proxied behind it:

```bash
cd mobile
EXPO_PUBLIC_OPENBOT_API=same-origin bunx expo export --platform web --output-dir dist
bun scripts/dev-proxy.ts      # :8090, serves dist/ and forwards /api to :3001
```

Same-origin means the browser's own session cookie authenticates it, so the web build never signs in
and never holds a token. On a device neither is true — see below.

The web build draws a phone around itself at 393 × 852 points and scales it to the window, so it
reads correctly in a narrow window, a wide one, or a video frame. The status bar is drawn rather than
taken from the clock: a recording made at 04:12 that shows 04:12 tells the viewer about somebody's
evening rather than about the product.

## Signing in, on a device

A browser keeps a cookie; a native app cannot be handed one. So:

1. the app opens the **system browser** at `/api/mobile/sign-in` — it never sees a password, and the
   person can see the address bar;
2. Google redirects back to `/api/mobile/handoff` on the deployment, where a cookie session now
   exists;
3. that endpoint mints a **single-use** token and redirects into the app;
4. the app trades it for a session token, keeps it in the platform's secure store, and sends it as a
   bearer token afterwards — through the same guard the browser uses.

Single-use because that last redirect passes through the operating system and can be logged. A token
spent on first use is worth almost nothing there; a session that lasts weeks is worth a great deal.

Set `OPENBOT_APP_SCHEME=openbot` on the deployment to turn this on. Without it those two routes
answer 501 and say why, rather than redirecting somewhere that will not open.

## Notifications

Four things are worth interrupting a person for, and nothing else is:

| | |
|---|---|
| **approval** | an action is parked and cannot happen until somebody answers |
| **question** | a Bot needs a hand — a sign-in, a code, something it must not do itself |
| **finished** | work the person asked to be told about is done |
| **failed** | something running unattended stopped, and nobody was watching |

A product that notifies on everything is a product whose notifications are switched off, and then the
approval nobody saw is the one that mattered.

**A notification is read on a locked screen.** The server composes the words; a caller cannot pass a
body, only a subject the server already resolved — the same value that went in the audit row. Page
text, file contents and typed values have no route into a push payload. The one exception is what a
Bot wrote about its own request, truncated, because a person cannot decide whether to help without
reading what was asked.

Who gets told is decided from the **Bot**, not from whoever started the turn: an unattended run has
nobody at a keyboard. A public Bot's work is everybody's business; a private Bot's is its owner's and
any administrator's.

Set `OPENBOT_PUSH=expo`, or `EXPO_ACCESS_TOKEN` if the project requires one. Unset means
notifications are composed and logged but not sent — deliberately, because "not configured" and
"broken" look identical from a phone and only one is worth investigating.

### Registering a device

`POST /api/devices` with `{ platform, token }`. A push token is a standing capability to interrupt
somebody, so it is registered rather than inferred, revocable by its owner, never returned to a
surface, and never written into a log or an error.

Registration is **refused** while `OPENBOT_DEV_NO_AUTH` is on. That mode makes every caller the same
administrator, so "register this token to me" would attach a handset to whoever the deployment
pretends everybody is, and the next caller would start receiving that person's approvals. Reading
approvals over loopback is a development convenience; putting them on a handset is not.

## What it deliberately does not do

- **Take the wheel of a browser.** Driving somebody else's Chrome from a phone is worse than not
  doing it. The app says a Bot needs help; the help happens at a desk.
- **Approve a generative-UI component.** Those render in a page, and the phone has no page.
- **Fall back to local data when a request fails.** It says `Could not reach this deployment` and
  keeps the last thing it was told. A companion that quietly shows a made-up approval queue is worse
  than one that admits it is offline.
- **Claim a Bot is busy.** A run belongs to whichever client started it, and this app cannot see one
  in flight. A Bot parked on an approval is the one "working" state it can know truthfully.

## Where things are

| | |
|---|---|
| `App.tsx` | the shell: three tabs, two pushed screens, the sign-in gate |
| `src/device.tsx` | the phone the web build draws around itself |
| `src/avatar.tsx` | a Bot's face, from the same seed the web app uses |
| `src/data/source.ts` | the one interface every screen is written against |
| `src/data/local.ts` | the in-memory deployment, for running with nothing behind it |
| `src/data/http.ts` | a real deployment, over the endpoints that exist |
| `src/data/session.tsx` | signing in, and where the token lives |
| `src/data/push.ts` | asking to be told |
| `scripts/dev-proxy.ts` | one origin for the web build, and a page for a Bot to act on |
