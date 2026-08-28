# Durable Slack delivery for OpenBot on Railway

Date: 2026-08-27

## Summary

OpenBot's first real Slack mention failed for two independent reasons. The Railway PostgreSQL database had only applied migrations through `0019`, while the deployed Slack release required `0020` and `0021`. Applying the deployed image's migration runner repaired that schema drift. A second real mention then reached the managed Channels runtime but still ended in its generic `Something went wrong` response before OpenBot recorded `channel.routed`.

This change makes both failure classes diagnosable and prevents recurrence. Railway will run the deployed image's idempotent migration runner before promoting each OpenBot deployment. The Slack ingress path will attach a fixed, non-sensitive phase code to failures so production logs identify the failing boundary without recording provider IDs, emails, tokens, message text, or signed links. A real Slack reproduction will select the final cause-specific code change; the implementation may not weaken the existing tenant, actor, account-link, or coworker authorization rules.

## Goals

- Prevent a Railway deployment from starting against unapplied OpenBot migrations.
- Identify the exact OpenBot phase behind a managed Channels `runtime_handler_failed` result.
- Preserve the existing secure account-link flow for unlinked Slack users.
- Fix the observed Slack failure for every valid user, not by inserting one manual identity link.
- Verify the complete production path with a real Slack mention and an OpenBot reply.

## Non-goals

- Replacing CopilotKit Channels SDK's managed Slack transport.
- Logging raw managed-delivery payloads or increasing log cardinality with provider identifiers.
- Trusting `identityContext.raw`, an unverified actor email, or an `unknown` tenant as authorization evidence.
- Changing coworker routing, tool grants, computer policy, or Slack interaction behavior unless the reproduction proves one of those paths is the failing boundary.
- Adding a general observability platform.

## Evidence and current boundary

The production investigation established the following:

1. Slack and CopilotKit Intelligence remained attached and online.
2. The first failed turn was logged as a Channels delivery handler failure with `errorCategory: "unknown"`.
3. OpenBot's audit trail contained no `channel.routed` event for that turn.
4. Railway PostgreSQL did not contain `external_user_links`; its Drizzle journal stopped before the deployed Slack migrations.
5. Running `/usr/local/bin/bun scripts/migrate.ts` from the deployed image succeeded. The journal then contained all 22 migrations expected by that image, including `external_user_links` and `external_thread_bindings`.
6. A fresh Slack mention still failed before routing after the schema repair.
7. In the live image, `loadConfig()` resolved the correct HTTPS application URL, token minting succeeded, a real database query succeeded, and `SlackIdentityLinker.resolve()` returned a valid unlinked result for a well-formed managed identity context.
8. The existing Slack-focused baseline is green: 43 tests pass across identity linking, ingress registry behavior, channel integration, and the migration journal.
9. A bounded production diagnostic split canonical identity validation by field. The managed delivery reported provider `slack`, a human actor, and a valid actor ID, but supplied tenant ID `unknown`. The public managed-delivery contract permits tenant metadata to be absent; the delivery adapter substitutes `unknown` in that case.

The remaining failure is therefore a missing canonical workspace ID at managed identity ingress. OpenBot must preserve workspace-scoped authorization without trusting the raw provider payload. For the single-workspace demo deployment, an operator-configured workspace ID supplies that missing trusted boundary. CopilotKit Channels remains responsible for the general upstream fix: managed Slack delivery should populate its canonical tenant metadata.

## Design

### 1. Railway migration gate

Configure the production OpenBot service with this pre-deploy command:

```text
cd /app/server && /usr/local/bin/bun scripts/migrate.ts
```

Railway runs [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command) from the newly built image, inside the private network, with the service environment. A non-zero result blocks promotion, so new application code cannot become healthy against an older schema. The command uses `drizzle-orm` from production dependencies and the SQL files copied into the runtime image; it updates the same `drizzle.__drizzle_migrations` journal as development migrations.

This setting belongs to the OpenBot service, not the PostgreSQL service. The implementation records and verifies it through Railway's service configuration. It does not add legacy `railway.toml` or `railway.json` configuration because Railway has deprecated that mechanism. A future repository-wide Railway Infrastructure-as-Code adoption may absorb the setting, but is outside this repair.

The migration runner is already idempotent. Re-running it with an up-to-date journal performs no schema changes and returns success. The release verification must observe the pre-deploy log before treating the deployment as successful.

### 2. Bounded Slack failure phases

Add one Slack-specific error boundary around the application-owned phases of a managed turn. It reports only a closed enum and rethrows the original error so Channels retains ownership of terminal delivery behavior.

Allowed phase values are:

- `identity.resolve`
- `ingress.remember`
- `ingress.take`
- `identity.validate`
- `link_card.post`
- `thread.subscribe`
- `execution.prepare`
- `agent.run`

The log event contains:

```json
{
  "type": "slack-turn-failed",
  "phase": "link_card.post"
}
```

It must not contain the thrown message or stack, delivery ID, event ID, Slack workspace/user/channel/thread IDs, OpenBot user/coworker IDs, email, message content, tokens, URLs, or serialized context. Phase values are source constants rather than caller-provided strings. Successful turns produce no new phase log.

The boundary must distinguish failures without changing control flow. It may wrap calls in a small helper such as `runSlackPhase(phase, operation, logger)`, but it may not catch-and-continue, replace a specific error with a generic success, or post a second fallback message. Channels remains responsible for its single `Something went wrong` provider fallback.

The logger is a synchronous `(event) => void` dependency with a production default that serializes the two-field event to `console.error`. Tests inject a collector. A logger failure is caught locally so observability cannot replace the application error being diagnosed.

### 3. Single-workspace tenant fallback

Add optional configuration `OPENBOT_SLACK_TENANT_ID`. It is the Slack workspace/team ID that the operator attached to this OpenBot Channel. Configuration accepts a non-empty, non-`unknown` canonical ID and rejects invalid values at startup.

Before identity linking or ingress persistence, normalize the immutable `ChannelIdentityContext` through one pure Slack tenant resolver:

- A known canonical Channels tenant remains authoritative when no fallback is configured.
- A known canonical Channels tenant must exactly equal the configured tenant when both exist; mismatch fails before every store or agent operation.
- An absent, blank, or `unknown` canonical tenant may be replaced only by the configured tenant.
- An absent canonical tenant with no configured tenant still fails closed.
- Provider, actor, installation, conversation, event, trigger, profile lookup, and raw payload are not changed.

The normalized context, rather than the original incomplete context, is passed to `SlackIdentityLinker` and stored in `SlackIngressRegistry`. This keeps every downstream tenant comparison consistent: account-link tokens, immutable thread bindings, approval reauthorization, execution context, audit identity, and coworker routing all use the same effective workspace ID. No handler may independently repeat the fallback.

This is deliberately a single-workspace bridge. It does not infer tenant identity from `raw`, a channel ID, actor email, actor ID, or the Slack installation ID. Supporting multiple Slack workspaces requires Channels to supply canonical tenant metadata per delivery, or a future administrator-owned mapping keyed by another authenticated managed-delivery capability.

The production OpenBot service is configured with `OPENBOT_SLACK_TENANT_ID=T05QFA4BW9X`. This value is an identifier, not a credential. It may appear in deployment configuration but remains excluded from bounded failure logs to keep diagnostics low-cardinality.

### 4. Error handling and security invariants

- Database migration failure blocks the new Railway deployment; the previous healthy deployment remains serving.
- Slack phase logging is best-effort but must not swallow or replace the original exception.
- A configured Slack tenant is accepted only as an operator-owned fallback for a missing canonical managed tenant; a conflicting known tenant is rejected.
- Unlinked users receive only the signed account-link card and never create a coworker binding or agent run.
- Existing links reload the current OpenBot user and role on every turn.
- A tenant or actor reported as blank or `unknown` remains invalid.
- Provider identity derives from canonical Channels fields, never attacker-controlled raw payload data.
- Automatic email linking continues to require the adapter profile lookup and an unambiguous active verified OpenBot account.
- The final patch must not expose secrets or personal identifiers in Railway, application, Channels, or audit logs.

## Testing

### Unit tests

- Every application-owned phase emits exactly its fixed phase code and rethrows the original error.
- Phase logs contain only `type` and `phase`.
- Successful turns emit no failure phase.
- The selected cause-specific fix has a regression test that fails against the deployed behavior.
- Tenant normalization covers known/no-config, known/matching-config, known/mismatching-config, unknown/configured, unknown/unconfigured, and malformed configuration.
- Existing tests continue to prove rejection of blank/unknown tenant and actor IDs, spoofed raw identity, untrusted actor email, cross-principal ingress pairing, and replayed ingress.

### Integration tests

- An unlinked managed mention posts one link card and performs no subscription, binding, routing, or agent run.
- A linked mention subscribes, creates or reloads one immutable thread binding, records `channel.routed`, and runs the selected coworker.
- A failure posts at most the Channels-owned generic fallback and produces one bounded OpenBot phase log.
- The migration journal still has a one-to-one ordered entry for every deployed SQL file.
- Running the migration runner twice leaves the journal and schema valid.

### Production verification

1. Confirm Railway's OpenBot service has the pre-deploy migration command.
2. Deploy the diagnostic commit and observe terminal Railway deployment success.
3. Send one approved `@openbot whatsup` mention in `#openbot-channels`.
4. Confirm the bounded reason is `slack_identity_tenant_invalid` and configure the approved single-workspace tenant fallback.
5. Merge and deploy the tenant-normalization patch; observe the migration pre-deploy step and terminal deployment success.
6. Send a fresh approved Slack mention.
7. For an unlinked identity, confirm a working OpenBot account-link card, complete linking through the authenticated OpenBot web surface, then retry.
8. Confirm the Slack thread receives a non-fallback OpenBot reply and the audit trail records `channel.routed` for the linked OpenBot user and selected coworker.
9. Confirm no new `slack-turn-failed` or `channel delivery handler failed` entry appears for the successful delivery.

## Rollback

The phase diagnostic is additive and can be reverted without data migration. The cause-specific patch must likewise avoid destructive schema changes. If the final application deployment fails, Railway keeps the prior deployment. The pre-deploy migration setting stays enabled because disabling it recreates the original drift risk; a migration failure is investigated and corrected before another promotion rather than bypassed.

## Completion criteria

- Railway blocks deployments whose OpenBot migrations fail.
- Production schema matches the migration journal shipped in the deployed image.
- A real Slack mention no longer returns `Something went wrong`.
- An omitted managed tenant is replaced by the configured workspace ID, while a conflicting known tenant remains rejected.
- An unlinked user can reach and complete the secure account-link flow.
- A linked user reaches coworker routing and receives a threaded OpenBot response.
- The relevant focused tests, formatting, lint, typecheck, and build pass.
- The PR contains no unrelated Typefully changes or manual production identity rows.
