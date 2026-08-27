import { IconArrowUpRight } from "@tabler/icons-react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  connectPersonalTypefully,
  disconnectPersonalTypefully,
} from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  type PluginConnection,
} from "@/lib/plugins/queries";
import {
  prepareTypefullyPublication,
  syncTypefullyDraft,
} from "@/lib/typefully/mutations";
import {
  type AuthoritativeDraft,
  draftQueryOptions,
  TypefullyClientError,
  typefullyKeys,
} from "@/lib/typefully/queries";

const TYPEFULLY_API_SETTINGS = "https://typefully.com/settings/api";

export type PendingTypefullyOperation =
  | { kind: "sync"; draftId: string }
  | { kind: "schedule"; draftId: string; expectedVersion: number }
  | {
      kind: "prepare_publication";
      draftId: string;
      expectedVersion: number;
    };

export type TypefullyResumeResult =
  | {
      outcome: "resumed";
      draftId: string;
      operation: PendingTypefullyOperation["kind"];
      version: number;
      proposalId?: string;
    }
  | {
      outcome: "stale";
      draftId: string;
      operation: PendingTypefullyOperation["kind"];
      expectedVersion: number;
      currentVersion: number;
    };

export type TypefullyResumeDependencies = {
  loadConnection(signal?: AbortSignal): Promise<void>;
  loadDraft(draftId: string, signal?: AbortSignal): Promise<AuthoritativeDraft>;
  sync(draftId: string, signal?: AbortSignal): Promise<{ version: number }>;
  preparePublication(
    draftId: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<{ proposalId: string; version: number }>;
};

export async function resumePendingTypefullyOperation(
  pending: PendingTypefullyOperation,
  dependencies: TypefullyResumeDependencies,
  options: { expectedVersion?: number; signal?: AbortSignal } = {},
): Promise<TypefullyResumeResult> {
  options.signal?.throwIfAborted();
  await dependencies.loadConnection(options.signal);
  options.signal?.throwIfAborted();
  const draft = await dependencies.loadDraft(pending.draftId, options.signal);
  options.signal?.throwIfAborted();
  const expectedVersion =
    pending.kind === "sync" ? options.expectedVersion : pending.expectedVersion;
  if (expectedVersion !== undefined && draft.version !== expectedVersion) {
    return {
      outcome: "stale",
      draftId: pending.draftId,
      operation: pending.kind,
      expectedVersion,
      currentVersion: draft.version,
    };
  }
  if (pending.kind === "prepare_publication") {
    const resumed = await dependencies.preparePublication(
      pending.draftId,
      pending.expectedVersion,
      options.signal,
    );
    return {
      outcome: "resumed",
      draftId: pending.draftId,
      operation: pending.kind,
      version: resumed.version,
      proposalId: resumed.proposalId,
    };
  }
  const resumed = await dependencies.sync(pending.draftId, options.signal);
  return {
    outcome: "resumed",
    draftId: pending.draftId,
    operation: pending.kind,
    version: resumed.version,
  };
}

export async function resumeTypefullyAfterConnection(
  queryClient: QueryClient,
  pending: PendingTypefullyOperation,
  options: { expectedVersion?: number; signal?: AbortSignal } = {},
): Promise<TypefullyResumeResult> {
  const result = await resumePendingTypefullyOperation(
    pending,
    {
      loadConnection: async (signal) => {
        const connected = await queryClient.fetchQuery({
          ...connectionsQueryOptions(),
          staleTime: 0,
        });
        signal?.throwIfAborted();
        if (
          !connected.connections.some(
            (item) =>
              item.serverId === "typefully" && item.authMethod === "api_key",
          )
        ) {
          throw new TypefullyClientError("connection_required");
        }
      },
      loadDraft: async (draftId) => {
        const loaded = await queryClient.fetchQuery({
          ...draftQueryOptions(draftId),
          staleTime: 0,
        });
        return loaded.draft;
      },
      sync: async (draftId, signal) => {
        const synced = await syncTypefullyDraft({ draftId, signal });
        return { version: synced.draft.version };
      },
      preparePublication: async (draftId, expectedVersion, signal) => {
        const prepared = await prepareTypefullyPublication({
          draftId,
          expectedVersion,
          signal,
        });
        return {
          proposalId: prepared.proposal.id,
          version: prepared.proposal.version,
        };
      },
    },
    options,
  );
  await queryClient.invalidateQueries({
    queryKey: typefullyKeys.draft(pending.draftId),
    exact: true,
  });
  return result;
}

function connectionError(error: unknown): string {
  if (error instanceof TypefullyClientError) {
    if (error.code === "invalid_api_key") {
      return "Typefully did not accept that API key. Check it and try again.";
    }
    if (error.code === "rate_limited") {
      return "Typefully is checking too many keys right now. Try again shortly.";
    }
  }
  return "Typefully could not verify that key. Try again.";
}

export function ConnectTypefully({
  connection,
  onConnected,
  onCancel,
  onDisconnected,
}: {
  connection: PluginConnection | null;
  onConnected?: (connection: PluginConnection) => void | Promise<void>;
  onCancel?: () => void;
  onDisconnected?: () => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState(connection);
  const [replacing, setReplacing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => setCurrent(connection), [connection]);
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [],
  );

  const submit = async () => {
    if (!apiKey || pending) return;
    setPending("connect");
    setError(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      const connected = await connectPersonalTypefully(
        queryClient,
        apiKey,
        controller.signal,
      );
      if (request.current !== controller) return;
      if (keyInput.current) keyInput.current.value = "";
      setApiKey("");
      setCurrent(connected);
      setReplacing(false);
      await onConnected?.(connected);
    } catch (caught) {
      if (!controller.signal.aborted) setError(connectionError(caught));
    } finally {
      if (request.current === controller) request.current = null;
      setPending(null);
    }
  };

  const disconnect = async () => {
    if (pending) return;
    setPending("disconnect");
    setError(null);
    try {
      await disconnectPersonalTypefully(queryClient);
      setCurrent(null);
      setReplacing(false);
      await onDisconnected?.();
    } catch {
      setError("Typefully could not be disconnected. Try again.");
    } finally {
      setPending(null);
    }
  };

  if (current && !replacing) {
    return (
      <section aria-label="Typefully connection" className="space-y-3">
        <div>
          <p className="text-sm font-medium">Typefully connected</p>
          <p className="text-xs text-muted-foreground">
            {current.accountLabel || "Your personal Typefully account"}
          </p>
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending !== null}
            onClick={() => setReplacing(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Replace API key
          </Button>
          <Button
            disabled={pending !== null}
            onClick={() => void disconnect()}
            size="sm"
            type="button"
            variant="outline"
          >
            {pending === "disconnect"
              ? "Disconnecting…"
              : "Disconnect Typefully"}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <form
      aria-label="Typefully connection"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <p className="text-sm font-medium">
          {current ? "Replace your Typefully API key" : "Connect Typefully"}
        </p>
        <p className="text-xs text-muted-foreground">
          Paste a personal API v2 key. OpenBot sends it directly to its
          encrypted credential store and never adds it to a draft or Bot
          conversation.
        </p>
      </div>
      <a
        className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
        href={TYPEFULLY_API_SETTINGS}
        rel="noreferrer"
        target="_blank"
      >
        Open Typefully API settings
        <IconArrowUpRight aria-hidden="true" className="size-3" />
      </a>
      <label className="block text-xs text-muted-foreground">
        Typefully API key
        <input
          aria-describedby={error ? "typefully-key-error" : undefined}
          aria-label="Typefully API key"
          autoComplete="new-password"
          className="mt-1 w-full rounded-[4px] border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={pending !== null}
          onChange={(event) => setApiKey(event.currentTarget.value)}
          ref={keyInput}
          type="password"
          value={apiKey}
        />
      </label>
      {error ? (
        <p
          className="text-sm text-destructive"
          id="typefully-key-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {!current ? (
        <p className="text-xs text-muted-foreground">
          Your OpenBot drafts stay available locally.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!apiKey || pending !== null}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {pending === "connect"
            ? "Connecting…"
            : error
              ? "Try again"
              : current
                ? "Replace API key"
                : "Connect Typefully"}
        </Button>
        {current || onCancel ? (
          <Button
            disabled={pending !== null}
            onClick={() => {
              setError(null);
              if (current) setReplacing(false);
              else onCancel?.();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
