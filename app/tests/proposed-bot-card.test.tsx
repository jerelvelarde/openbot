import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * The card a Bot's proposed coworker stops on, and every answer it can give.
 *
 * The card IS the tool: `save_bot` has no handler, so the run suspends here and every way out is a
 * render away from a `respond` call. That makes the states worth pinning one at a time — a card that
 * answers twice resumes a turn that has already moved on, and one that answers a server refusal ends
 * the turn at the moment the person could have fixed it and pressed again.
 *
 * The property this file exists for above all the others is that the WHOLE role description is on
 * screen before anything is created. It becomes a standing instruction handed to a model on every
 * turn in every channel, written by something that heard about the job second-hand, and a clamp on
 * it would hide the second half of what somebody is agreeing to. CSS does not run in this DOM, so
 * `line-clamp` and `truncate` are invisible to `textContent` — the assertion therefore reads the
 * class attribute, which is ugly and is the only way to catch the thing that would actually go
 * wrong.
 *
 * NO MODULE MOCKS, and nothing stubbed at `fetch`: creating is a prop, so the card is exercised with
 * a plain function and the transport never enters this file.
 */
/*
 * Registered with an address, and only if nothing else has registered already. `register` throws on
 * a second call and bun walks every test file into one process, so whichever DOM file the walk
 * reaches first installs the window. The address matters too: Happy DOM defaults to `about:blank`,
 * whose origin is the STRING "null", which Better Auth rejects while it is still being imported.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
}
/*
 * A DOM before Testing Library. `screen` binds its queries to `document.body` at import time, so a
 * static import would be hoisted above the registration and bind to nothing.
 */
const { cleanup, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const userEvent = (await import("@testing-library/user-event")).default;
const { ProposedBotCard } = await import("@/components/agents/proposed-bot");
const { botCardAnswer, createdBotIdIn, wasCreated } = await import(
  "@/lib/agents/proposal"
);

afterEach(cleanup);

/** The instruction under test, long enough that a clamp would visibly cost somebody the end of it. */
const INSTRUCTIONS =
  "Chase overdue invoices and draft the follow-up a person sends. Work only from the ledger you were given, quote the line each amount came from, and never invent a date the record does not carry. Where an invoice is disputed rather than late, say so and stop.";

/** A proposal that passes the fields, so each test varies only the thing it is about. */
const DRAFT = {
  name: "Renewal Desk",
  title: "Accounts Receivable",
  roleDescription: INSTRUCTIONS,
  skills: ["find-a-document", "check-a-claim"],
};

const MADE = {
  agentId: "agent_1",
  name: "Renewal Desk",
  granted: ["find-a-document", "check-a-claim"],
  failed: [],
};

/** A real router over a memory history, so the completed card's `Link` resolves without a mock. */
function routed(node: ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => node,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/agents",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // The app's router is registered globally for typing; this one only has to resolve /agents.
  return <RouterProvider router={router as never} />;
}

test("a proposal still streaming shows nothing to press", async () => {
  /*
   * `respond` is absent until the arguments are complete. A button drawn before then would create a
   * coworker out of half an instruction — and unlike a skill, a coworker cannot be quietly replaced
   * by proposing it again.
   */
  render(
    routed(
      <ProposedBotCard args={{ name: "Renewal" }} create={async () => MADE} />,
    ),
  );

  // Awaited rather than read synchronously: the router mounts its route on a later tick, so nothing
  // at all is in the document on the first one.
  expect(await screen.findByText("Writing the coworker…")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("the whole instruction is on screen, unclipped, before anything is created", async () => {
  let created = 0;
  render(
    routed(
      <ProposedBotCard
        args={DRAFT}
        create={async () => {
          created += 1;
          return MADE;
        }}
        respond={async () => {}}
      />,
    ),
  );

  const instruction = await screen.findByText(INSTRUCTIONS);
  // The regression this guards: a clamp or a truncate on the one field somebody is agreeing to.
  expect(instruction.className).not.toContain("line-clamp");
  expect(instruction.className).not.toContain("truncate");
  expect(instruction.className).toContain("overflow-y-auto");

  expect(screen.getByText("Renewal Desk")).toBeTruthy();
  expect(screen.getByText("Accounts Receivable")).toBeTruthy();
  expect(screen.getByText("/find-a-document, /check-a-claim")).toBeTruthy();
  // Rendering the card writes nothing. The press is the write.
  expect(created).toBe(0);
});

test("pressing creates once and answers with what was made", async () => {
  const answers: string[] = [];
  let created = 0;
  render(
    routed(
      <ProposedBotCard
        args={DRAFT}
        create={async () => {
          created += 1;
          return MADE;
        }}
        respond={async (result) => {
          answers.push(String(result));
        }}
      />,
    ),
  );

  await userEvent.click(await screen.findByText("Create it"));

  await waitFor(() => expect(answers.length).toBe(1));
  expect(created).toBe(1);
  expect(answers[0]).toBe(botCardAnswer.created(MADE));
  expect(answers[0]).toContain("Renewal Desk now exists and is private");
  // The line that stops somebody believing the coworker arrived able to reach things.
  expect(answers[0]).toContain("granted no connector, no tool and no address");
});

/**
 * The half-done outcome, said out loud.
 *
 * Creating the coworker and putting a skill on it are two calls, so a grant can fail after the
 * coworker exists. Rolling back would delete something the person just watched being made over a
 * skill they can add in two clicks, so the card keeps the coworker and reports the shortfall — and
 * the sentence has to name the skills that did not land, or somebody walks away believing in one.
 */
test("a skill that did not land is named rather than rounded up", async () => {
  const answers: string[] = [];
  const partial = {
    agentId: "agent_2",
    name: "Renewal Desk",
    granted: ["find-a-document"],
    failed: ["check-a-claim"],
  };
  render(
    routed(
      <ProposedBotCard
        args={DRAFT}
        create={async () => partial}
        respond={async (result) => {
          answers.push(String(result));
        }}
      />,
    ),
  );

  await userEvent.click(await screen.findByText("Create it"));

  await waitFor(() => expect(answers.length).toBe(1));
  expect(answers[0]).toContain("/check-a-claim could not be put on it");
  expect(answers[0]).toContain("/find-a-document");
});

/**
 * A refusal from the server stays on the card, and the run stays suspended.
 *
 * Answering the tool with the error would end the turn at the exact moment the person could have
 * fixed what the refusal named and pressed again, leaving them to retype the whole request.
 */
test("a refusal keeps the run open with the buttons still live", async () => {
  const answers: string[] = [];
  render(
    routed(
      <ProposedBotCard
        args={DRAFT}
        create={async () => {
          throw new Error("A coworker called Renewal Desk already exists.");
        }}
        respond={async (result) => {
          answers.push(String(result));
        }}
      />,
    ),
  );

  await userEvent.click(await screen.findByText("Create it"));

  await screen.findByText("A coworker called Renewal Desk already exists.");
  expect(answers).toEqual([]);
  expect((screen.getByText("Create it") as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("declining answers without creating anything", async () => {
  const answers: string[] = [];
  let created = 0;
  render(
    routed(
      <ProposedBotCard
        args={DRAFT}
        create={async () => {
          created += 1;
          return MADE;
        }}
        respond={async (result) => {
          answers.push(String(result));
        }}
      />,
    ),
  );

  await userEvent.click(await screen.findByText("Don't create"));

  await waitFor(() => expect(answers.length).toBe(1));
  expect(answers[0]).toBe(botCardAnswer.declined());
  expect(created).toBe(0);
});

/**
 * A proposal the fields refuse is answered, not shown as a question.
 *
 * There is nothing for the person to decide: the model can fix it, and the problems name their
 * field so it can. Asking somebody to press a button on a coworker that cannot be created teaches
 * them the button is unreliable.
 */
test("an unwritable proposal is answered without asking anybody", async () => {
  const answers: string[] = [];
  let created = 0;
  render(
    routed(
      <ProposedBotCard
        args={{ name: "", title: "Accounts Receivable", roleDescription: "" }}
        create={async () => {
          created += 1;
          return MADE;
        }}
        respond={async (result) => {
          answers.push(String(result));
        }}
      />,
    ),
  );

  await waitFor(() => expect(answers.length).toBe(1));
  expect(answers[0]).toContain("Not created, and the person was not asked");
  expect(answers[0]).toContain("name:");
  expect(created).toBe(0);
  expect(screen.queryByText("Create it")).toBeNull();
});

/**
 * The completed card, rendered the way the SDK renders one after a reload: the arguments and the
 * recorded answer, and nothing this component remembered.
 *
 * That is the whole reason the id travels in the sentence. A card that kept it in state would draw
 * this link once, for the person who pressed the button, and then silently stop drawing it for
 * anybody who refreshed the page — which is not a failure anything would report.
 */
test("a completed card links to the coworker, rebuilt from the answer alone", async () => {
  render(
    routed(
      <ProposedBotCard
        args={DRAFT}
        create={async () => MADE}
        result={botCardAnswer.created(MADE)}
      />,
    ),
  );

  const link = await screen.findByText("Open Renewal Desk");
  expect(link.closest("a")?.getAttribute("href")).toContain("agent=agent_1");
});

/**
 * The sentence and the reader of the sentence, pinned together.
 *
 * They are two literals in one module and a reword can separate them, at which point the link stops
 * appearing and nothing says why. This is the test that makes that loud.
 */
test("the created answer carries an id the card can read back", () => {
  const answer = botCardAnswer.created(MADE);

  expect(wasCreated(answer)).toBe(true);
  expect(createdBotIdIn(answer)).toBe("agent_1");
  // A declined card is not a created one, and carries no coworker to link to.
  expect(wasCreated(botCardAnswer.declined())).toBe(false);
  expect(createdBotIdIn(botCardAnswer.declined())).toBeNull();
});
