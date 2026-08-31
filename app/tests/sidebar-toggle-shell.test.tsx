import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { PageShell } from "@/components/layout/page-shell";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { SIDEBAR_STORAGE_KEY } from "@/lib/sidebar";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    // bun runs every test file in ONE process, so whichever file loads first registers the
    // DOM for all of them. A second unconditional register throws, and the throw leaves an
    // empty body behind for every render that follows it.
    GlobalRegistrator.register({ url: "http://localhost:3010" });
  }
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/*
 * Queries come off the render result rather than `screen`, because `screen` binds `document.body`
 * when @testing-library/dom is imported and the DOM here is installed in `beforeAll`, after that.
 * Running this file on its own is what exposes the difference.
 */
const pane = () => document.querySelector('[data-slot="sidebar"]');

const shell = (
  <SidebarShell width="300px">
    <Sidebar>
      <SidebarContent>roster</SidebarContent>
    </Sidebar>
    <PageShell title="Preferences">body</PageShell>
  </SidebarShell>
);

/*
 * THE CASE THAT WOULD HAVE TAKEN TWO SCREENS DOWN. `/assist` and `/link/slack` draw `PageShell`
 * directly under `_authed`, which mounts no `SidebarProvider`. While the toggle read the sidebar
 * unconditionally, `useSidebar` threw during render and both screens went blank — and no existing
 * test noticed, because every other `PageShell` sits inside one of the three shells.
 */
test("PageShell renders with no SidebarProvider, and draws no toggle", () => {
  let view: ReturnType<typeof render> | undefined;
  expect(() => {
    view = render(<PageShell title="Coworker assistance">body</PageShell>);
  }).not.toThrow();

  expect(view?.getByText("Coworker assistance")).not.toBeNull();
  expect(view?.queryByLabelText("Hide sidebar")).toBeNull();
  expect(view?.queryByLabelText("Show sidebar")).toBeNull();
});

test("inside a shell, PageShell's toggle collapses the pane and remembers it", () => {
  const view = render(shell);

  expect(pane()?.getAttribute("data-state")).toBe("expanded");

  act(() => {
    fireEvent.click(view.getByLabelText("Hide sidebar"));
  });

  expect(pane()?.getAttribute("data-state")).toBe("collapsed");
  expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed");
  // The control that hid it is still on screen, naming what it will do next.
  expect(view.getByLabelText("Show sidebar")).not.toBeNull();
});

test("a stored collapse is restored on the next mount", () => {
  window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed");

  const view = render(shell);

  expect(pane()?.getAttribute("data-state")).toBe("collapsed");
  expect(view.getByLabelText("Show sidebar")).not.toBeNull();
});
