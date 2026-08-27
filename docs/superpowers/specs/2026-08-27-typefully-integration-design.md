# Typefully Integration, Draft Canvas, and Governed Publishing

**Status:** Approved design
**Date:** 2026-08-27

## Summary

OpenBot will add Typefully as a curated, per-user connector. A person can draft content before
connecting Typefully, connect their own Typefully API key only when an operation needs it, edit and
preview the draft in an OpenBot side panel, and publish only after explicit human approval of the
exact saved version.

The conversation keeps a compact, durable draft card. Selecting **Review draft** opens a wider
canvas in OpenBot's existing detail-panel area. The canvas follows Typefully's focused editor and
realistic-preview model while remaining an OpenBot component. It supports direct text and media
editing, debounced autosave, X and LinkedIn previews, and the human-in-the-loop publishing decision.

Typefully credentials belong to the person initiating the turn. Bot grants still decide whether a
Bot can use Typefully at all. These are separate controls: a credential identifies whose account is
reached, while a grant identifies which Bot may reach it.

## Goals

- Add Typefully as a reviewed connector with one encrypted API key per OpenBot user.
- Let a Bot prepare a useful local draft even when the user has not connected Typefully.
- Prompt for connection at the moment a Typefully-dependent operation is required.
- Preserve the pending draft and resume the operation after successful connection.
- Render a compact draft record inline and a full editing/preview canvas in a side panel.
- Autosave edits and media changes to Typefully once connected.
- Make immediate publication structurally impossible without explicit human approval.
- Bind approval to an immutable draft version and refuse stale, changed, expired, or reused
  approvals.
- Keep all connector calls under existing Bot grants, policy evaluation, and auditing.
- Ship high-fidelity preview and governed publication for X and LinkedIn in the first release.

## Non-goals

- Per-Bot model providers or model API keys. That is a separate runtime and billing feature.
- Changes to the existing Notion connector.
- Deployment-wide or administrator-owned Typefully accounts.
- OAuth for Typefully. Typefully currently authenticates its public API and MCP server with API keys.
- High-fidelity preview or OpenBot publishing for Threads, Bluesky, Mastodon, Substack Notes, or
  other Typefully destinations in the first release.
- Reproducing Typefully's entire calendar, analytics, collaboration, or team-management product.
- Allowing the model to call a raw immediate-publish operation after a prompt-only approval.
- Automatically granting Typefully tools or UI to Bots when the connector is enabled.

## Existing OpenBot Boundaries

The design extends existing seams instead of creating a second integration system:

- The plugin catalogue defines reviewed vendors, authentication ownership, transport, and write
  classification.
- `mcp_user_credentials` associates one person's connector grant with an encrypted credential.
- The credential vault encrypts secrets and supports atomic rotation and revocation.
- Plugin grants decide which MCP-shaped tools each Bot may call.
- Every connector call is grant-checked, policy-checked, and audited.
- Compiled gallery components are published deployment-wide and can be withheld per Bot.
- `useHumanInTheLoop` components suspend a run and return a person's decision as the tool result.
- `DetailPanel` provides a reloadable, linkable side-panel pattern beside the main conversation.

## Product Roles and Ownership

### Administrator

- Enables the curated Typefully connector for the deployment.
- Grants selected Typefully tools to selected Bots.
- Grants the Typefully draft component to selected Bots.
- Configures policy for Typefully reads, draft writes, scheduling, and publishing.
- Cannot enter, inspect, borrow, or replace another user's Typefully key.

### User

- Owns their Typefully connection and local Typefully drafts.
- Enters, rotates, and disconnects their own Typefully API key.
- Edits text and media in the draft canvas.
- Approves or declines publication from their own account.

### Bot

- May prepare and revise draft content when granted the Typefully draft capability.
- May use only the Typefully tools granted to its Bot identity.
- Receives no API key, credential identifier, or credential metadata in its context.
- Cannot invoke the final immediate-publish operation directly.

## Connector Architecture

### Curated entry

Typefully becomes a frozen catalogue entry with:

- stable key `typefully`;
- pinned official API host;
- `user-api-key` authentication;
- an explicit transport adapter;
- reviewed read and write classifications;
- official documentation URL.

The first-class integration will use a dedicated Typefully REST adapter behind OpenBot's existing
MCP-shaped `VendorTransport` interface. Typefully's official MCP server remains suitable for the
existing custom-server path, but it is not the enforcement boundary for this feature. The dedicated
adapter is required because the draft canvas needs deterministic draft/media schemas and the publish
gate must prevent the raw vendor publish operation from ever appearing in the Bot's tool manifest.

The adapter exposes reviewed OpenBot tool definitions for supported reads, draft creation and
updates, media operations, and scheduling. It deliberately omits immediate publication from the
tools offered to a Bot. Final publication is an authenticated server operation reachable only from
the approval path described below.

### Credential resolution

The connector introduces `user-api-key` alongside `user-oauth` and `deployment-bearer`.

For each call:

1. Resolve the authenticated actor who initiated the turn.
2. Verify that the active Bot holds the requested Typefully tool grant.
3. Resolve that actor's live Typefully credential.
4. If absent, return a structured connection-required result rather than treating the Bot as
   unavailable.
5. Decrypt the key only inside the server immediately before the outbound request.
6. Evaluate policy and record the audited outcome.

There is no fallback to an administrator, another user, the Bot owner, or a deployment environment
variable.

## Connection Experience

### Progressive connection

A user can create and edit a local draft without a Typefully key. The draft displays **Saved in
OpenBot**. The first sync, social-set lookup, scheduling, or publishing action that needs Typefully
returns a structured connection-required state and suspends the pending workflow.

The inline card and canvas show **Connect Typefully**. Selecting it opens the existing side-panel
area with:

- a concise explanation of what will be connected;
- a link to Typefully's API-key settings;
- a write-only API-key input;
- **Connect** and **Cancel** actions.

The key is submitted directly to an authenticated server route. It never enters component
arguments, the transcript, a Bot message, or browser query parameters.

The server validates the key against Typefully before storing it. A successful connection stores an
encrypted per-user credential, creates or reconciles the remote draft, changes status to **Saved to
Typefully**, and resumes the suspended operation. Canceling preserves the local draft and leaves
Typefully-dependent actions unavailable.

### Rotation and disconnect

Reconnecting atomically rotates the credential: the old row is retired in the same transaction that
stores the replacement. Disconnecting revokes the local credential pointer immediately. Existing
OpenBot draft content remains available locally, but sync, scheduling, and publishing return to the
connection-required state.

## Draft Surfaces

### Inline transcript component

The conversation renders a compact durable card containing:

- draft title or leading text;
- X and/or LinkedIn destinations;
- selected social set;
- media count;
- sync and approval status;
- **Review draft** action.

The component receives an OpenBot draft ID and bounded display summary, not the complete draft or
credentials. Selecting **Review draft** opens the canvas through route/search state so reload keeps
the panel open and browser Back closes it.

Terminal states remain in history:

- Local draft
- Saving
- Saved to Typefully
- Waiting for approval
- Changed — review again
- Declined
- Published
- Publishing failed
- Publishing status unknown

### Side-panel canvas

The canvas uses a wider instance of `DetailPanel` than the current 400-pixel default and collapses to
the main surface at narrow application widths. It contains:

- editable post or thread blocks;
- platform enable/disable controls;
- X and LinkedIn content variants;
- selected social set and account identity;
- media upload, removal, ordering, and alt-text editing;
- desktop and mobile preview modes;
- Typefully-style focused editing and realistic native-post previews;
- autosave state and actionable errors;
- scheduling controls when the Bot holds scheduling capability;
- **Decline** and **Publish now** actions when a publication proposal is pending.

The OpenBot component should feel recognizably consistent with Typefully's editor and realistic
preview, but it must use OpenBot's theme, accessibility primitives, and panel navigation rather than
copying Typefully's application shell.

## Autosave and Versioning

The canvas edits an authoritative server draft with optimistic local state.

- Text and metadata changes use a short debounce.
- Media changes save after the upload or removal operation settles.
- The UI shows **Saving…**, **Saved in OpenBot**, **Saved to Typefully**, or a specific failure.
- Publishing is disabled while changes are pending or any save has failed.
- Each successful save increments a monotonic version and computes a canonical content hash.
- The client includes its expected version with every save.
- A stale expected version is rejected; it is never silently overwritten.
- Every successful content, platform, account, scheduling, or media change invalidates an existing
  approval.

Before connection, autosave persists locally. After connection, the server persists locally and
syncs the same version to Typefully. The local record retains the last confirmed remote version so a
failed remote save is visible and recoverable.

Canvas-originated remote saves retain the draft's originating Bot identity and recheck that Bot's
current Typefully grants. Revoking a grant still permits the owner to preserve edits locally, but it
blocks further Typefully synchronization, scheduling, and publication through that Bot.

## Human-in-the-Loop Publication

### Two-phase protocol

Immediate publication is a two-phase operation:

1. **Prepare:** create an immutable publication proposal from a fully saved draft version.
2. **Approve and execute:** a person reviews that proposal and explicitly selects **Publish now**.

The proposal snapshots:

- canonical X and LinkedIn content;
- media references and alt text;
- social set and platform destinations;
- draft version and content hash;
- requesting Bot, channel, and user;
- creation and expiry timestamps.

The HITL render receives only a proposal ID and bounded summary. The side panel loads the
authoritative proposal from the server and displays the exact content that approval will publish.

### Enforcement

The server-side publish endpoint requires all of the following:

- an authenticated user matching the proposal owner;
- a pending, unexpired, unused proposal;
- a still-live Typefully credential belonging to that user;
- the Bot and connector grants that were required when the proposal was prepared;
- an unchanged local draft version and hash;
- a freshly fetched Typefully draft matching the approved canonical snapshot;
- a passing policy decision.

The proposal row is locked while its terminal decision is recorded so two approvals cannot spend it
twice. A mismatch, edit, expiry, disconnect, or concurrent Typefully change refuses publication and
returns the draft to **Changed — review again**.

The existing generic `askApproval` component remains useful for ordinary decisions but is not the
publication boundary. Prompting a model to ask first is not equivalent to making the publish
operation unreachable without approval.

### User-initiated publication

If a user selects **Publish now** while reviewing a draft without a suspended Bot run, OpenBot still
creates and spends the same immutable proposal. The explicit click is the human decision and is
audited identically. A Bot-initiated flow additionally returns the result through the suspended HITL
tool so the Bot can report the outcome.

## Persistence

### Credential changes

Add a credential kind that distinctly represents a per-user MCP/API-key secret. OAuth refresh
tokens and static API keys must never be accepted by each other's exchange or refresh paths.

Extend the per-user connector association so it records whether the connection is OAuth or API-key
based. OAuth scopes remain meaningful only for OAuth connections; API-key metadata records only
non-secret validation details needed by the settings UI.

The active connection remains unique on `(server_id, user_id)`.

### `typefully_drafts`

The Typefully-specific draft table contains:

- OpenBot draft ID;
- owner user ID;
- originating channel ID;
- originating Bot ID;
- optional Typefully draft ID;
- canonical editable draft document as JSON;
- current version and content hash;
- last remote-confirmed version and hash;
- sync status and bounded last error;
- created and updated timestamps.

The canonical document includes only supported X/LinkedIn content, platform settings, scheduling
metadata, and media descriptors. It contains no API key.

### `typefully_publication_proposals`

The proposal table contains:

- proposal ID and draft ID;
- owner user, requesting Bot, and channel IDs;
- immutable version, hash, and canonical publication snapshot;
- pending, declined, expired, published, failed, or unknown status;
- expiry, decision, and completion timestamps;
- bounded vendor result identifiers or published URLs;
- bounded failure detail.

Proposal snapshots are application data and are not copied into generic audit payloads.

## Authorization and Privacy

- Draft content reads and writes require authenticated ownership. Administrators can inspect bounded
  audit metadata, not unpublished draft bodies or media.
- Channel-rendered draft cards also require channel membership.
- A Bot grant is checked independently from user ownership.
- The API key is accepted only by the dedicated write-only connection route.
- Secret values are encrypted at rest and redacted from errors and audit events.
- Component arguments never contain the full unpublished draft, credential IDs, or secret metadata.
- Publication cannot be reached through the Bot tool catalogue.
- Unsupported destinations fail closed before proposal creation.
- Custom MCP Typefully servers remain separate and do not inherit the curated connector's identity,
  classifications, UI, or publication exception.

## Policy and Audit

Typefully operations use existing MCP policy context and are classified explicitly:

- listing social sets and drafts: reads;
- creating or editing drafts and media: writes;
- scheduling: write;
- immediate publication: irreversible write plus mandatory HITL gate;
- deletion: destructive write under the normal policy engine.

Audit events record actor, Bot, connector, tool or operation, draft ID, version/hash, destination,
policy decision, approval decision, and outcome. They do not record API keys or full unpublished
post content.

At minimum, the lifecycle emits events for connection, rotation, disconnect, local draft creation,
remote synchronization failure, proposal creation, approval, decline, expiry, publish refusal,
publish success, publish failure, and ambiguous publish outcome.

## Failure Behavior

### Connection

- Missing key: preserve the draft and render setup.
- Invalid key: do not store it; show a field-level validation failure.
- Validation timeout: preserve the entered value only in current form state and allow an explicit
  retry.
- Disconnect during work: keep the local draft and disable remote actions.

### Editing and sync

- Autosave failure: retain local edits, show **Not saved to Typefully**, offer retry, and disable
  publishing.
- Version conflict: preserve the user's unsaved text and offer reload or save as a new draft.
- Media failure: mark that attachment failed with **Retry** and **Remove** actions.
- Rate limit: retain state, show the vendor retry time when available, and avoid automatic loops.
- Vendor outage: continue local saving and clearly distinguish it from remote confirmation.

### Publishing

- Edit after approval: invalidate immediately.
- Expired proposal: return to review-required state.
- Vendor rejection: record failure without retrying automatically.
- Timeout or lost response: never blindly repeat publication. Reconcile against Typefully first.
- Unprovable outcome: mark **Publishing status unknown**, prevent another automatic attempt, and
  require manual resolution.

## Platform Scope

The first release supports high-fidelity editing, preview, scheduling, and publication for X and
LinkedIn. Typefully may return social sets containing other destinations, but OpenBot must not create
a publication proposal for an unsupported destination. The canvas explains that the destination is
not yet supported in OpenBot and directs the user to Typefully rather than presenting an inaccurate
preview.

New platforms require:

1. a canonical document mapping;
2. an accurate desktop/mobile preview;
3. media and formatting constraints;
4. policy classification;
5. approval snapshot coverage;
6. contract and end-to-end tests.

## Tenant Presets and Skills

A tenant package may ship Typefully-oriented skills and attach them to preset Bots, for example
drafting a launch post or reviewing a content calendar. Skill declarations may name Typefully tool
refs before the connector is enabled; they remain inert until the connector exists and the Bot holds
the corresponding grants.

This design does not make tool or component grants implicit. An administrator still enables the
connector and grants Typefully tools and the draft component to the intended Bots. Extending tenant
packages to seed MCP or component grants is a separate governance change.

## Testing Strategy

### Unit tests

- API-key credential creation, resolution, rotation, and revocation.
- Refusal to use an OAuth token on the API-key path or an API key on the OAuth path.
- Canonical draft serialization, version increments, and hashing.
- Autosave debounce state and stale-version conflict handling.
- Proposal state machine, expiry, invalidation, and single use.
- Tool-manifest proof that immediate publication is absent.
- X and LinkedIn preview formatting and bounded component arguments.

### Integration tests

- Curated connector enablement and tool discovery through a fake Typefully transport.
- Actor-scoped credential resolution with two users and two Bots.
- Missing-key structured response and resume after connection.
- Local draft creation followed by first remote sync.
- Remote save failure and recovery without content loss.
- Media upload failure, retry, and removal.
- Cross-user, cross-channel, and cross-Bot authorization refusals.
- Proposal creation, server-side approval checks, and audited publication.
- Local or remote change between approval and execution.
- Concurrent approval attempts against one proposal.
- Ambiguous vendor response reconciliation without duplicate publication.

### Component and route tests

- Inline summary statuses and **Review draft** navigation.
- Reloadable/back-button canvas behavior.
- Direct editing, platform tabs, desktop/mobile previews, and autosave states.
- Connection-required form, secret redaction, cancel, reconnect, and resume.
- HITL approval, decline, expired, changed, failure, and completion states.
- Keyboard navigation, accessible labels, responsive canvas collapse, and reduced motion.

### End-to-end journey

1. Start with a Bot granted Typefully drafting but a user with no Typefully connection.
2. Ask for an X and LinkedIn launch draft.
3. Render the local inline card and open the canvas.
4. Edit text and media and verify local autosave.
5. Request Typefully sync and complete the connection prompt.
6. Verify the pending operation resumes and the draft becomes remotely saved.
7. Request immediate publication.
8. Edit after the first proposal and verify approval invalidation.
9. Prepare a new proposal, approve it, and verify exactly one publication.
10. Verify the transcript terminal state and redacted audit trail.

## Rollout

1. Add schema and credential/auth primitives without exposing Typefully.
2. Add the Typefully transport and contract tests against a fake server.
3. Add progressive connection and settings UI.
4. Add local drafts, autosave, and remote synchronization.
5. Add inline and canvas components behind the normal component publication/grant controls.
6. Add immutable proposals and the enforced publication path.
7. Enable the catalogue entry after X and LinkedIn end-to-end tests pass.

Existing custom MCP servers and the Notion/Google Drive connectors remain unchanged throughout the
rollout.

## Success Criteria

- A user can produce and edit a local draft without a Typefully key.
- A Typefully-dependent action prompts for that user's key and resumes after connection.
- Two users invoking the same shared Bot always reach their own Typefully accounts.
- The inline card and canvas remain consistent across reloads and autosave failures.
- X and LinkedIn previews show the exact approved canonical content and media.
- No Bot-visible tool or alternate server route can immediately publish without HITL approval.
- A stale, changed, expired, cross-user, or already-used proposal cannot publish.
- A lost vendor response cannot cause an automatic duplicate publication.
- Credentials and full unpublished content do not appear in prompts, component arguments, or audit
  payloads.
