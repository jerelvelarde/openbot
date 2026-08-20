import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { oneTimeToken } from "better-auth/plugins/one-time-token";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import {
  accounts,
  sessions,
  userRoles,
  users,
  verifications,
} from "../db/schema";
import { roleForEmail } from "./roles";

export function createAuth(config: DeploymentConfig, database: Database) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("Google authentication is not configured.");
  }

  return betterAuth({
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    trustedOrigins: authConfig.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: "pg",
      usePlural: true,
      schema: { users, sessions, accounts, verifications },
    }),
    socialProviders: {
      google: authConfig.google,
    },
    /**
     * How a phone signs in.
     *
     * A browser keeps a cookie; a native app cannot be handed one. So sign-in happens in the system
     * browser — which is the right place for it, because the app never sees the password — and ends in
     * a redirect back into the app carrying a **one-time** token. The app exchanges that for a session
     * and sends it as a bearer token from then on.
     *
     * One-time rather than the session token itself, because that redirect URL passes through the
     * operating system and can end up in a log. A token that is spent on first use is worth far less
     * lying around than a session that lasts weeks.
     *
     * `bearer` only converts a token into the session the rest of the server already understands, so
     * `createRequireUser` needs no second code path and cannot come to disagree with the cookie one
     * about who somebody is.
     */
    plugins: [
      bearer(),
      oneTimeToken({
        // Long enough to hand over between two processes on one device, short enough that a token
        // left in a log is worthless by the time anybody reads it.
        expiresIn: 3,
        // Stored hashed, so a leaked database does not hand somebody a set of live sign-ins.
        storeToken: "hashed",
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await database
              .insert(userRoles)
              .values({
                userId: user.id,
                role: roleForEmail(user.email, authConfig.initialAdminEmails),
              })
              .onConflictDoNothing();
          },
        },
      },
    },
  });
}
