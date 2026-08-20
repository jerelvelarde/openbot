/**
 * Computer tables: agent computers, sessions, computer-use audit.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or coworker.ts to do it.
 */
import { index, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents, users } from "./core";

/**
 * The boundary this deployment is enforcing, kept where a restart cannot lose it.
 *
 * This table keeps policy across restarts. The policy can be changed while running, and a restart
 * must not silently return to the default.
 *
 * One row, by construction. A deployment has one boundary, so the primary key is a constant and every
 * write is an upsert onto it. A table that can hold two policies is a table that will eventually hold
 * two and have to decide between them, and "which of these is in force" is not a question this should
 * ever be able to ask.
 *
 * Memory is still the cache. The gateway asks for the policy on every action, so it reads from
 * memory; this is the record that survives a restart, not something on the path of a click.
 */
export const actionPolicy = pgTable("action_policy", {
  /** Always `current`. See the note above on there being exactly one. */
  id: text("id").primaryKey(),
  /** `enforce` or `dry-run`. Not an enum: the policy module owns that vocabulary. */
  mode: text("mode").notNull(),
  deny: text("deny").array().notNull(),
  /**
   * The rules that ask a person rather than deciding.
   *
   * Nullable so a row written before this column existed still loads, and reads as no ask rules.
   * Defaulting it to an empty list in the migration would be the same answer; leaving it nullable
   * means an old row is visibly old rather than looking like a deliberate empty.
   */
  ask: text("ask").array(),
  /** Standing permissions, which outrank `ask`. Nullable for the same reason `ask` is. */
  exempt: text("exempt").array(),
  allow: text("allow").array().notNull(),
  /** Who last changed it, for the Admin page and the trail. */
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * An action a Bot wants to take, waiting on a person.
 *
 * This exists as a table, rather than as a prompt held in whichever process happened to be running
 * the turn, because the person who answers may not be on the device that started it. They may be on a
 * phone, on somebody else's laptop, or not at their desk yet, and an approval that only exists in one
 * browser tab is one that cannot be answered from anywhere else and is lost when that tab closes.
 *
 * The subject is stored as the SERVER resolved it. Never as the model described what it was about to
 * do: the whole reason the gateway holds the snapshot is that a label supplied by the caller cannot be
 * trusted, and an approval screen quoting the caller's own label would hand that trust straight back.
 */
export const approvalState = pgEnum("approval_state", [
  "pending",
  "allowed",
  "denied",
  "expired",
]);

export const pendingApprovals = pgTable(
  "pending_approvals",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** The thread this happened in, so a phone can show it beside the conversation. */
    threadId: text("thread_id"),
    /** Who was driving when the Bot asked. Null for the local development actor. */
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Mechanism, e.g. `computer_click`. */
    toolName: text("tool_name").notNull(),
    /** Effect, e.g. `activate`. What an operator actually thinks in. */
    intent: text("intent"),
    /** `element` | `file` | `page` | `mcp`, so a surface knows how to phrase the subject. */
    subjectKind: text("subject_kind").notNull(),
    /** The element label, file path or tool name, as the server resolved it. */
    subjectLabel: text("subject_label").notNull(),
    /** The host the action lands on, when there is one. */
    subjectHost: text("subject_host"),
    /** The `ask` expression that stopped it, so an operator can go and find the rule. */
    rule: text("rule").notNull(),
    /** Why, in words that go in front of a person. */
    reason: text("reason").notNull(),
    state: approvalState("state").notNull().default("pending"),
    /** Who answered, and when. Both null while it is still a question. */
    answeredByUserId: text("answered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /**
     * The rule an "always allow" wrote.
     *
     * Recorded on the approval as well as in the policy, so the trail can show that this answer is
     * why a boundary changed. A permission that appears in the policy with nothing explaining it is
     * a permission nobody can audit.
     */
    scopedRule: text("scoped_rule"),
    /**
     * When this stops being answerable.
     *
     * A question nobody answers must not hold a turn open forever, and must not be answerable days
     * later when the page it was about is long gone.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The query the inbox makes, on every poll: what is still waiting, newest first.
    index("pending_approvals_state_created_idx").on(
      table.state,
      table.createdAt,
    ),
    index("pending_approvals_agent_idx").on(table.agentId),
  ],
);

/**
 * A device that has asked to be told.
 *
 * Registered rather than inferred, and revocable, because a push token is a standing capability to
 * interrupt somebody. It is also the one row that must never be creatable while the deployment is
 * running without authentication: `OPENBOT_DEV_NO_AUTH` admits every caller as one administrator,
 * which is defensible on loopback and is not defensible for something that reaches a phone.
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    token: text("token").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("push_devices_user_idx").on(table.userId)],
);
