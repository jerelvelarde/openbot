# Typefully

A Bot with this connector granted reaches Typefully **as the person asking**, through the hosted MCP
server Typefully runs at `mcp.typefully.com`, on the catalogue's default MCP transport. Two people
asking the same question get the drafts their own accounts can see. Like Notion, this connector
ships both read and write tools; unlike Notion, its writes schedule and publish to X, LinkedIn,
Threads, Bluesky, Mastodon and Substack, under the account holder's own name, in public, with no
undo. That difference is why this connector classifies tools the other way round from every other
one here — see [What counts as a write](#what-counts-as-a-write).

Setting it up takes two people, and neither can do the other's half:

| Who               | Does                                        | Where                          |
| ----------------- | ------------------------------------------- | ------------------------------ |
| An administrator  | Enables the connector                       | `/admin/plugins/typefully`     |
| Each person       | Consents with their own Typefully account   | `/settings/connected-accounts` |

There is deliberately no endpoint for an administrator to connect an account on somebody's behalf.

Typefully's API is a paid tier. A person whose plan does not include it can consent successfully and
still have every call refused at the vendor.

## What an administrator does

### 1. Enable the connector in OpenBot

At `/admin/plugins/typefully`, turn on **Enable for this deployment**. There is no client to
register and no secret to paste: this deployment introduces itself to Typefully on first connect,
over RFC 7591 dynamic client registration. The prerequisite is a public URL the redirect URI can be
derived from — `OPENBOT_PUBLIC_URL` if it is set, or the auth base URL it falls back to otherwise —
nothing needs to be registered at Typefully ahead of time.

The OAuth endpoints are on `api.typefully.com` while the MCP endpoint is on `mcp.typefully.com`. That
is what Typefully's own metadata says, not a mistake in the catalogue. Google Drive already splits the
same way, so nothing in the flow assumes a vendor's auth lives on its own host.

### 2. Connect your own account

On the same page, use **Your account** to connect your own Typefully account before doing anything
else here. This connector's tool list is an answer from Typefully's hosted server, so refreshing it
takes a credential, and the refresh in the next step mints one from the connection belonging to
whoever presses the button — not whichever account happens to be connected here. That is a personal
grant like anybody else's, reaching only what your own account can see — not deployment
configuration — but it has to come first, because an administrator who presses Refresh tools without
having connected their own account is refused, not lent someone else's.

### 3. Press Refresh tools

This records the tool list Typefully's hosted server advertises today.

Every tool it records will read as a **write**, including the ones that plainly only read. That is
deliberate and is explained below. Nothing is broken and there is nothing to fix on this screen.

### 4. Grant tools to a Bot

Enabling the connector does not give any Bot access to it. Each tool is granted per Bot, the same as
every other plugin tool. Every call then checks the grant, evaluates the action policy, and writes an
audit row.

Grant deliberately, and read the action policy before you do. A granted publishing tool is a Bot
that can post to a timeline; a policy that permits `mcp.effect == "write"` broadly is what decides
whether it will.

## What counts as a write

Typefully has exactly one OAuth scope, `full_access`, and it grants everything. There is no
read-only scope to ask for instead, so consenting at all consents to publishing. As with Notion,
that means the catalogue plus the action policy is the **entire** write barrier, with nothing at the
vendor standing behind it.

Notion's entry meets that by listing its write tools: anything else the server advertises is treated
as a read. This entry does the opposite, and lists its **read** tools instead — so a tool that is not
named is a write.

The reason is what each arrangement costs when it is wrong. A write list has to be complete to be
safe, and one rename at the vendor turns a post on somebody's timeline into a call the policy passes
through as harmless. A read list fails the other way: an unreviewed tool is over-scrutinised, which
costs a policy exception rather than a public post.

The list ships **empty**, so on a fresh deployment every Typefully tool is a write. Typefully's
server refuses `tools/list` without a credential, and documents itself by capability rather than by
tool, so there was no way to name its reads at review time without guessing — and every tool list
circulating elsewhere belongs to a community server built on the v1 API that Typefully switched off
in June 2026.

Making it precise is a code change, not a screen: a name moves into `readTools` on the Typefully
entry in `server/src/plugins/catalogue.ts`, checked against a live tool list, as the reviewed act of
saying "this tool only reads". Until then the connector works exactly as it should — every call is
simply judged as the write it might be.

## What each person does

At `/settings/connected-accounts`, Typefully appears once an administrator has enabled it. Open it
and press **Connect**. That leaves OpenBot for Typefully's own consent screen — the arrow on the
button says so — and returns to the same page, which then reads **Connected**.

Consent covers every social set your Typefully account can reach, because `full_access` is the only
scope Typefully offers. If your account carries a social set per colleague, connecting here makes all
of them reachable by a Bot you have granted the tools to; there is no per-social-set consent to give.

Nothing is cached. OpenBot stores the refresh token and mints a short-lived access token for each
call, so withdrawing access at Typefully takes effect on the next call rather than whenever a cache
expires.

## See also

- [Notion](notion.md) — the same shape, and the write-list arrangement this one inverts.
- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`, `KEY_ENCRYPTION_KEY`.
- [Typefully's own guide](https://support.typefully.com/en/articles/13128440-typefully-mcp-server) to
  its hosted MCP server.
