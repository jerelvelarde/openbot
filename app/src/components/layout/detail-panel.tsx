import { IconX } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { EASE_OUT } from "@/lib/motion";

/**
 * A main pane with a detail pane that slides in beside it.
 *
 * The open/closed state belongs to the caller, in practice a search parameter, so opening a detail
 * is a real navigation: it survives a reload, it can be linked to, and Back closes it.
 *
 * The pane is animated by width and the content inside it is given that width outright, so the
 * content is laid out once and the pane reveals it.
 */

const ANIMATION_DURATION_SECONDS = 0.3;
const DEFAULT_DETAIL_WIDTH = 400;
const MINIMUM_SPLIT_MAIN_WIDTH = 320;

/**
 * The content overlaps the tail of the pane rather than following it.
 *
 * Delaying content slightly but ending with the pane keeps the reveal as one motion.
 */
const CONTENT_ENTRANCE_SECONDS = 0.18;
const CONTENT_ENTRANCE_DELAY_SECONDS = 0.12;
const CONTENT_ENTRANCE_OFFSET = "translateY(8px)";

export function DetailPanel({
  open,
  onClose,
  title,
  detail,
  detailWidth = DEFAULT_DETAIL_WIDTH,
  collapseAtNarrow = false,
  focusKey,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Rendered at the left of the detail pane's header row, beside the close button. */
  title?: ReactNode;
  detail?: ReactNode;
  /** Open width of the detail pane, in pixels. */
  detailWidth?: number;
  /** On the app's narrow layout, let a large detail replace the main surface instead of squeezing it. */
  collapseAtNarrow?: boolean;
  /**
   * Opts this pane into focus entry/restoration. Change the value when an already-open pane becomes
   * a new user focus destination, such as a selected draft. Automatic panes should leave it unset.
   */
  focusKey?: string;
  children: ReactNode;
}) {
  // Reduced motion keeps the fade, which explains the change, and drops the movement.
  const shouldReduceMotion = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const managedFocusRef = useRef(false);
  const previousFocusKeyRef = useRef<string | undefined>(undefined);
  const hasTitle = title !== undefined && title !== null;
  const collapsed =
    collapseAtNarrow &&
    open &&
    (availableWidth === null ||
      availableWidth < detailWidth + MINIMUM_SPLIT_MAIN_WIDTH);

  useLayoutEffect(() => {
    if (!collapseAtNarrow) return;
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () =>
      setAvailableWidth(panel.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [collapseAtNarrow]);

  useEffect(() => {
    const shouldMoveFocus =
      open &&
      focusKey !== undefined &&
      (!managedFocusRef.current || focusKey !== previousFocusKeyRef.current);
    if (shouldMoveFocus) {
      if (!managedFocusRef.current) {
        const active = document.activeElement;
        returnFocusRef.current =
          active instanceof HTMLElement && active !== document.body
            ? active
            : null;
      }
      queueMicrotask(() => {
        const destination = hasTitle ? headingRef.current : closeRef.current;
        if (destination?.isConnected) destination.focus();
      });
    }
    const leavingManagedPane =
      managedFocusRef.current && (!open || focusKey === undefined);
    if (leavingManagedPane) {
      const origin = returnFocusRef.current;
      queueMicrotask(() => {
        const fallback = document.querySelector<HTMLElement>(
          "[data-channel-focus-fallback]",
        );
        const destination = origin?.isConnected ? origin : fallback;
        destination?.focus();
      });
      returnFocusRef.current = null;
    }
    managedFocusRef.current = open && focusKey !== undefined;
    previousFocusKeyRef.current = focusKey;
  }, [focusKey, hasTitle, open]);

  return (
    <div
      className="flex h-full min-h-0"
      data-layout={open ? (collapsed ? "collapsed" : "split") : "closed"}
      data-detail-width={detailWidth}
      data-testid="detail-panel"
      ref={panelRef}
    >
      <div
        className={`flex flex-1 min-w-0 flex-col ${collapsed ? "hidden" : ""}`}
        data-testid="detail-panel-main"
      >
        {children}
      </div>
      <motion.div
        animate={{ width: open ? (collapsed ? "100%" : detailWidth) : 0 }}
        className={`shrink-0 overflow-hidden ${collapsed ? "flex-1" : ""}`}
        data-testid="detail-panel-pane"
        // No entry animation on first paint: URL-opened panels should appear as initial state.
        initial={false}
        transition={{
          duration: shouldReduceMotion ? 0 : ANIMATION_DURATION_SECONDS,
          ease: EASE_OUT,
        }}
      >
        <div
          className="flex h-full flex-col bg-sidebar border-l border-border"
          data-testid="detail-panel-content"
          style={{ width: collapsed ? "100%" : detailWidth }}
        >
          {open ? (
            <>
              <div className="h-12 shrink-0 sticky top-0 flex flex-row items-center justify-between px-2 gap-2">
                {hasTitle ? (
                  <h2
                    className="flex min-w-0 w-full items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    ref={headingRef}
                    tabIndex={-1}
                  >
                    {title}
                  </h2>
                ) : (
                  <div className="flex min-w-0 w-full items-center gap-1.5" />
                )}
                <div className="flex flex-row gap-1.5">
                  <Button
                    aria-label="Close detail panel"
                    onClick={onClose}
                    ref={closeRef}
                    variant="ghost"
                    size="icon"
                  >
                    <IconX className="size-4.5" />
                  </Button>
                </div>
              </div>
              <motion.div
                animate={{ opacity: 1, transform: "translateY(0px)" }}
                className="flex-1 min-h-0 overflow-y-auto"
                initial={{
                  opacity: 0,
                  transform: shouldReduceMotion
                    ? "none"
                    : CONTENT_ENTRANCE_OFFSET,
                }}
                transition={{
                  delay: shouldReduceMotion
                    ? 0
                    : CONTENT_ENTRANCE_DELAY_SECONDS,
                  duration: CONTENT_ENTRANCE_SECONDS,
                  ease: EASE_OUT,
                }}
              >
                {detail}
              </motion.div>
            </>
          ) : null}
        </div>
      </motion.div>
    </div>
  );
}
