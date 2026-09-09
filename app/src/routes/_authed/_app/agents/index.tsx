import { IconBoxSeam, IconFileImport, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { ImportTemplate } from "@/components/agents/import-template";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * Creating and inspecting a coworker are search-parameter states so the roster remains mounted and
 * Back closes the dialog.
 */
const agentsSearchSchema = z.object({
  new: z.boolean().optional(),
  agent: z.string().optional(),
  /**
   * Reading a stranger's file is a place, not a modal.
   *
   * The consent screen is long, it is the only thing standing between somebody else's prose and a
   * model, and a person will leave it half-read to go and look at what they already have. A search
   * parameter survives that: the roster stays mounted behind it, Back closes it, and the URL can be
   * handed to a colleague who has to decide.
   */
  import: z.boolean().optional(),
  /**
   * A draft of this deployment's own, opened as the file to import.
   *
   * The round trip an author needs before sending a template anywhere: pack a coworker, then read
   * the consent screen the person on the other end will read. It is a draft id rather than a
   * document, so nothing about a template travels through a URL.
   */
  template: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: agentsSearchSchema,
  component: AgentsScreen,
});

/*
 * The roster wraps on the width it actually has, not on the window's.
 *
 * A card is a fixed 144px, so four fixed columns overlap the moment the column they sit in is
 * narrower than the card. That is not a narrow-window case: opening the detail pane takes the width
 * out of this column at any window size, so the cards behind an open Bot overlapped each other on a
 * perfectly ordinary screen. `auto-fill` tracks the container instead, which is the thing that
 * actually changed.
 *
 * The tracks are the card's own width, not `minmax(144px,1fr)`. A `1fr` track stretches to share
 * the container while the card inside it stays 144px, and the difference reads as a gap: at prose
 * width that was three 190px columns holding 144px cards, so the 15px gutter looked like 61px. The
 * home screen's Explore row is the reference — fixed cards, `gap-4`, nothing stretching.
 */
function AgentsScreen() {
  const {
    new: isCreating,
    agent: selectedAgentId,
    import: isImporting,
    template: templateId,
  } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: agents } = useQuery(agentListQueryOptions());
  const mine = agents?.filter((a) => a.mine);
  const explore = agents?.filter((a) => !a.mine && a.visibility === "public");

  // Creating wins if both are somehow set: it is the more recent intent.
  const showCreate = isCreating === true;
  const showImport = !showCreate && isImporting === true;
  const showProfile =
    !showCreate && !showImport && selectedAgentId !== undefined;
  const close = () => navigate({ search: {} });

  return (
    <>
      <SidebarToggleBar />
      <div className="max-w-2xl px-4 w-full mx-auto">
        <div className="mt-12 w-full max-w-2xl">
          <div className="flex flex-row w-full items-center justify-between">
            <h2 className="font-bold text-lg">Your agents</h2>
            <div className="flex flex-row items-center gap-1">
              {/*
               * The gallery, first of the three, because it is the only one of them that answers
               * "what could I have?" — Import assumes a file already in hand and Create assumes a
               * coworker already designed. Somebody arriving with neither has nowhere else to go.
               */}
              <Button
                variant="ghost"
                size="sm"
                render={(props) => <Link to="/agents/gallery" {...props} />}
              >
                <IconBoxSeam />
                Templates
              </Button>
              {/*
               * Beside Create rather than behind a menu, because importing one is the other way a
               * coworker comes to exist here and a person arriving with a file somebody sent them
               * should not have to guess that this is the page for it.
               */}
              <Button
                variant="ghost"
                size="sm"
                render={(props) => (
                  <Link to="/agents" search={{ import: true }} {...props} />
                )}
              >
                <IconFileImport />
                Import
              </Button>
              <Button
                variant="ghost"
                size="sm"
                render={(props) => (
                  <Link to="/agents" search={{ new: true }} {...props} />
                )}
              >
                <IconPlus />
                New agent
              </Button>
            </div>
          </div>
          {/*
           * A BLOCK, NOT A FLEX ROW. Both children below are full-width things — a grid that
           * auto-fills its columns, or the empty state — and a flex item defaults to `flex: 0 1 auto`,
           * which sizes it to its content rather than to the row. That made the grid collapse to a
           * single 144px column stacked down the left with the rest of the width unused, while
           * "Explore agents" beneath it, which has no such wrapper, filled the row correctly.
           */}
          <div className="mt-4">
            {!!mine?.length && (
              <div className="grid grid-cols-[repeat(auto-fill,144px)] gap-4">
                {mine.map((agent, index) => {
                  return (
                    <StaggerItem index={index} key={agent.id}>
                      <Link to="/agents" search={{ agent: agent.id }}>
                        <AgentCard agent={agent} />
                      </Link>
                    </StaggerItem>
                  );
                })}
              </div>
            )}
            {!mine?.length && (
              <Empty className="border border-dashed h-[180px]">
                <EmptyHeader>
                  <EmptyTitle className="text-muted-foreground">
                    You don't have any agents created.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </div>
        <div className="mt-8 w-full max-w-2xl">
          <h2 className="font-bold text-lg">Explore agents</h2>
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,144px)] gap-4">
            {!!explore?.length &&
              explore.map((agent, index) => {
                return (
                  <StaggerItem index={index} key={agent.id}>
                    <Link to="/agents" search={{ agent: agent.id }}>
                      <AgentCard agent={agent} />
                    </Link>
                  </StaggerItem>
                );
              })}
          </div>
        </div>
      </div>
      <CreateAgentDialog
        onClose={close}
        onCreated={(agentId) => navigate({ search: { agent: agentId } })}
        open={showCreate}
      />
      <AgentDialog
        agentId={selectedAgentId ?? null}
        onClose={close}
        open={showProfile}
      />
      {/*
       * Importing keeps a surface of its own, because the two screens answer different questions.
       * The gallery reads a template this deployment already ships; this is the one that takes a
       * file from a stranger, and it is the only place a person meets instructions nobody here
       * wrote. Wider than the default popup for that reason alone: the consent screen renders
       * those instructions verbatim and unabridged, and prose reflowed into a narrow column is
       * prose people skim — which is the one behaviour this screen exists to discourage.
       */}
      <Dialog onOpenChange={(next) => !next && close()} open={showImport}>
        <DialogContent className="max-w-[560px]">
          <DialogTitle className="sr-only">Import a coworker</DialogTitle>
          <DialogBody className="overflow-y-auto">
            <ImportTemplate {...(templateId ? { templateId } : {})} />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
