# The companion app

A phone app for the half of OpenBot that happens while nobody is watching.

It is not the web app on a small screen. The web app is where you work with a Bot: you watch its
browser, take the wheel, approve a component, read a long transcript. The companion is for the
moments when a Bot needs *you* and you are not at a desk — an action parked waiting for an answer, a
sign-in it cannot do itself, a routine that stopped overnight.

Five screens: what is waiting on you, the channels you have, one conversation, starting a new one,
and the audit trail.

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

## Chat

A channel is a thread. Two channels with the same Bot keep separate durable threads, so the Channels
list *is* the thread list, and the transcript is read from the runtime's own history at
`/api/copilotkit/api/threads/{id}/messages`.

**A reply arrives as it is written.** Starting a turn is an AG-UI run, and the run answers with an
event stream. The app reads it and folds the events into the turn on screen: text grows by deltas, a
tool call is drawn the moment it starts and resolves in place when its result lands. The durable
thread takes over a moment later and nothing on screen shifts, because both paths derive the line
through the same code — `src/data/run.ts`.

That file is XHR rather than `fetch`, deliberately: React Native's `fetch` has no streaming body, so
`response.body` is null and there is nothing to read incrementally. `XMLHttpRequest` exposes
`responseText` as it arrives on a device and in a browser alike, which is how every SSE library for
React Native works underneath. No dependency, one code path, both targets.

**Starting a conversation.** Pick a Bot, and the server mints the thread — `POST /api/channels`, then
open what comes back. The app never invents a thread id. Before this the app could only read the
channels a deployment already had, so a deployment with none was permanently read-only from a phone.

**`/` runs a skill.** The granted skills for a channel's Bot come from `/api/plugins/for/{botId}` and
appear as a menu when the draft is a slash query. Choosing one leaves a **chip**, not a paragraph: the
instruction goes to the Bot as a **system turn in front of** the message, never pasted into the
person's own words — which is what the web app does, and what keeps the reply from quoting
instructions back at somebody. The transcript skips system turns, so it never appears on either
surface.

**Sending reports the channel.** `POST /api/channels/{id}/activity` after the turn, which is what
keeps the roster's preview current and what wakes the other members' sockets. It is never allowed to
fail the send: the message went, and saying otherwise because a preview could not be updated is the
worst thing a composer can claim.

**Live updates.** The deployment pushes channel activity over `GET /api/channels/events`, and the app
holds that socket open with reconnect and backoff while anything is subscribed. It is an optimisation
and never a source of truth — an event only says "read again", so a dropped socket costs latency and
nothing else, and the four-second poll stays as the floor. On a device the bearer token travels in the
handshake headers, which is why that one constructor is asserted in `http.ts`: a token must never go
in a URL.

**What is deliberately not built: @mentions.** A channel has exactly one Bot (`MAX_RECIPIENTS = 1`),
and the web app's own composer says the quiet part out loud — "`draft.agentId` carries the @mentioned
coworker, but nothing routes on it yet: this channel is pinned to one `runtimeAgentId` for the life of
its thread." A mention picker on a phone would be a menu with one entry that changes nothing.

## Things the app is careful about

**It follows the phone's appearance setting.** `app.json` declares `automatic`, and on a device the
app takes the system scheme — a dark-mode phone at 3am does not get a full-brightness white screen.
The **web build stays pinned to light**, because it is a phone mockup for recordings and every
published artefact should keep looking like the last one.

**Insets are measured, not guessed.** `react-native-safe-area-context` supplies them, which is the
one dependency here that RN core cannot replace: it exposes no Android navigation-bar inset at all,
and a hardcoded 24pt is less than a three-button bar — so the tab labels get drawn underneath it and
taps in that band go to the system. It reports zero insets on web, so the drawn frame is unaffected.

**Timestamps say which day.** The approval queue keeps settled rows and the trail reaches back days,
so a bare clock time makes a refusal from last Tuesday at 14:22 and one from today at 14:22 the same
string. Same day is `14:22`, this week is `Tue 14:22`, older is `19 Aug 14:22`.

**An approval shows its deadline.** The server parks an action for ten minutes and then answers the
Bot itself. The phone renders the `expiresAt` it already sends, so nobody walks to a laptop to check
a figure and comes back to a 409 — and once that time has passed the wording hedges, because the
server is the authority on whether an approval is still open.

**"Always allow this" says what it will grant, before the tap.** The rule the server writes carries
the Bot and the element label and **no host term**, so "this button on this portal" is really "that
Bot, anything labelled this, anywhere it can reach". That sentence is on the screen, and the button
asks twice.

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
