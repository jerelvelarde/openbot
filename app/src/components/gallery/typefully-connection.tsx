import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  ConnectTypefully,
  type PendingTypefullyOperation,
  resumeTypefullyAfterConnection,
  type TypefullyResumeResult,
} from "@/components/typefully/connect-typefully";
import {
  defineGalleryComponent,
  type GalleryComponent,
} from "@/lib/copilot/gallery-registry";
import type { PluginConnection } from "@/lib/plugins/queries";
import { Badge, GalleryFrame } from "./frame";

export const TypefullyConnectionArgs = z.strictObject({
  draftId: z.string().uuid(),
  operation: z.enum(["sync", "schedule", "prepare_publication"]),
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

type ConnectionArgs = z.infer<typeof TypefullyConnectionArgs>;
type ConnectionDecisionProps = {
  status: "inProgress" | "executing" | "complete";
  args: Partial<ConnectionArgs>;
  respond?: (result: unknown) => Promise<void>;
  result?: string;
  resumeOperation?: (
    pending: PendingTypefullyOperation,
    expectedVersion: number,
    signal: AbortSignal,
  ) => Promise<TypefullyResumeResult>;
  onOpenDraft?: (draftId: string) => void;
};

function pendingOperation(args: ConnectionArgs): PendingTypefullyOperation {
  if (args.operation === "sync") {
    return { kind: "sync", draftId: args.draftId };
  }
  return {
    kind: args.operation,
    draftId: args.draftId,
    expectedVersion: args.expectedVersion,
  };
}

export function TypefullyConnectionDecision({
  status,
  args,
  respond,
  resumeOperation,
  onOpenDraft,
}: ConnectionDecisionProps) {
  const queryClient = useQueryClient();
  const parsed = TypefullyConnectionArgs.safeParse(args);
  const answered = useRef(false);
  const mounted = useRef(true);
  const resumeController = useRef<AbortController | null>(null);
  const [resuming, setResuming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const draftId = parsed.success ? parsed.data.draftId : undefined;

  useEffect(
    () => () => {
      mounted.current = false;
      resumeController.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (draftId) onOpenDraft?.(draftId);
  }, [draftId, onOpenDraft]);

  const answer = useCallback(
    async (outcome: unknown) => {
      if (answered.current || !respond) return;
      answered.current = true;
      try {
        await respond(outcome);
      } catch (error) {
        // A failed SDK response did not resume the suspended run, so keep the decision retryable.
        answered.current = false;
        throw error;
      }
    },
    [respond],
  );

  if (status === "complete") {
    return (
      <GalleryFrame title="Typefully connection">
        <Badge tone="positive">Answered</Badge>
        <p className="mt-2 text-sm text-muted-foreground">
          The connection request is complete.
        </p>
      </GalleryFrame>
    );
  }
  if (!parsed.success || status === "inProgress") {
    return (
      <GalleryFrame title="Connect Typefully">
        <p className="text-sm text-muted-foreground" role="status">
          Preparing the secure connection request…
        </p>
      </GalleryFrame>
    );
  }

  const request = parsed.data;
  const resume = async (_connection: PluginConnection) => {
    if (resuming || answered.current) return;
    setResuming(true);
    setFailure(null);
    const controller = new AbortController();
    resumeController.current = controller;
    try {
      const outcome = await (resumeOperation
        ? resumeOperation(
            pendingOperation(request),
            request.expectedVersion,
            controller.signal,
          )
        : resumeTypefullyAfterConnection(
            queryClient,
            pendingOperation(request),
            {
              expectedVersion: request.expectedVersion,
              signal: controller.signal,
            },
          ));
      if (!mounted.current || controller.signal.aborted) return;
      await answer(outcome);
    } catch {
      if (mounted.current && !controller.signal.aborted) {
        setFailure(
          "Typefully connected, but the draft operation could not resume. Review the draft and try again.",
        );
      }
    } finally {
      if (resumeController.current === controller) {
        resumeController.current = null;
      }
      if (mounted.current) setResuming(false);
    }
  };

  return (
    <GalleryFrame
      action={<Badge tone="caution">Connection required</Badge>}
      title="Connect Typefully"
    >
      <p className="mb-3 text-sm text-muted-foreground">
        Connect your personal Typefully account to resume this draft operation.
      </p>
      {failure ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {failure}
        </p>
      ) : null}
      {resuming ? (
        <p className="text-sm text-muted-foreground" role="status">
          Rechecking the draft and Typefully access…
        </p>
      ) : (
        <ConnectTypefully
          connection={null}
          onCancel={() => {
            void answer({
              outcome: "declined",
              code: "connection_declined",
              draftId: request.draftId,
              operation: request.operation,
            }).catch(() => {
              if (mounted.current) {
                setFailure(
                  "The connection decision could not be sent. Try again.",
                );
              }
            });
          }}
          onConnected={resume}
        />
      )}
    </GalleryFrame>
  );
}

function RoutedTypefullyConnectionDecision(props: ConnectionDecisionProps) {
  const navigate = useNavigate();
  const openDraft = useCallback(
    (draftId: string) => {
      void navigate({
        to: ".",
        search: (previous) => ({
          ...previous,
          settings: undefined,
          watch: undefined,
          draft: draftId,
        }),
      });
    },
    [navigate],
  );
  return <TypefullyConnectionDecision {...props} onOpenDraft={openDraft} />;
}

export const GALLERY: GalleryComponent[] = [
  defineGalleryComponent({
    name: "connectTypefullyAccount",
    title: "Connect Typefully",
    kind: "decision",
    description:
      "Ask the person to securely connect their own Typefully API key only after a Typefully draft operation returned connection_required. Pass only the local draft id, the bounded operation, and its expected version. CRITICAL: never ask for or pass an API key in chat.",
    parameters: TypefullyConnectionArgs,
    Component:
      RoutedTypefullyConnectionDecision as GalleryComponent["Component"],
    preview: {
      status: "executing",
      args: {
        draftId: "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53",
        operation: "sync",
        expectedVersion: 3,
      },
      respond: async () => {},
    },
  }),
];
