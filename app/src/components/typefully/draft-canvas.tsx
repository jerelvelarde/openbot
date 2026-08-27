import { useQuery } from "@tanstack/react-query";
import {
  draftQueryOptions,
  TypefullyClientError,
} from "@/lib/typefully/queries";
import { CanvasShell } from "./canvas-shell";

function DraftRefusal({ error }: { error: unknown }) {
  if (error instanceof TypefullyClientError) {
    if (
      error.code === "draft_not_found" ||
      error.code === "channel_forbidden" ||
      error.code === "bot_not_attached"
    ) {
      return (
        <p role="alert">
          Draft unavailable. It may have moved or you may not have access.
        </p>
      );
    }
    if (
      error.code === "connection_required" ||
      error.code === "not_connected" ||
      error.code === "access_revoked" ||
      error.code === "connection_mismatch"
    ) {
      return <p role="alert">Connect Typefully to load this draft.</p>;
    }
    if (error.code === "grant_required") {
      return <p role="alert">Typefully access is unavailable for this Bot.</p>;
    }
  }
  return <p role="alert">This draft could not load. Try again.</p>;
}

export function DraftCanvas({ draftId }: { draftId: string }) {
  const draft = useQuery(draftQueryOptions(draftId));

  if (draft.isPending) {
    return (
      <div className="p-4 text-sm text-muted-foreground" role="status">
        Loading draft…
      </div>
    );
  }
  if (draft.error || !draft.data) {
    return (
      <div className="p-4 text-sm text-destructive">
        <DraftRefusal error={draft.error} />
      </div>
    );
  }
  return <CanvasShell draft={draft.data.draft} />;
}
