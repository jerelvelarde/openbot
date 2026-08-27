import { useCallback, useEffect, useRef, useState } from "react";
import { pageCoordinates } from "./take-the-wheel";

/**
 * Low-latency screencast used while a human is driving the Bot's browser.
 *
 * The inline card keeps using cheap polling for passive watching. This view uses Chrome's
 * screencast socket so input and visual feedback stay synchronized during takeover.
 *
 * Follows Chrome DevTools' own `InputModel.ts` (BSD-3) for the event translation and
 * `steel-dev/steel-browser`'s casting handler (Apache-2.0) for the frame loop, because no maintained
 * library publishes this and every real implementation is one app-internal file.
 */

/**
 * CDP's modifier bitmask. Alt 1, Control 2, Meta 4, Shift 8.
 *
 * Needed or a capital letter typed with Shift arrives lower-case, and Ctrl+A selects nothing.
 */
function modifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

type Props = {
  /**
   * Computer identity is part of the stream URL so input and frames stay scoped to the active Bot.
   */
  computerId: string;
  /** Whether the user currently holds the wheel. Input is only sent when true. */
  driving: boolean;
  /** Called with a human-readable reason when the stream cannot be established. */
  onProblem?: (problem: string | null) => void;
};

/**
 * What document the frames are of, as the computer reports it.
 *
 * `awaitingAcceptance` is the computer saying it is holding this person's input back until they say
 * they meant to be here. It is decided there, never here: a banner the browser could dismiss on its
 * own would be decoration, and the refusal it describes is enforced on the other side of the socket.
 */
type ShowingPage = {
  url: string;
  origin: string;
  awaitingAcceptance: boolean;
};

export function LiveScreen({ computerId, driving, onProblem }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** The size of the frames Chrome is sending, which is what input coordinates are relative to. */
  const frameSize = useRef<{ width: number; height: number } | null>(null);
  const [connected, setConnected] = useState(false);
  const [showing, setShowing] = useState<ShowingPage | null>(null);

  useEffect(() => {
    // Same origin, so the scheme follows the page: wss when the app is served over https.
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/api/computers/${encodeURIComponent(computerId)}/stream`,
    );
    socketRef.current = socket;
    let closed = false;

    socket.onopen = () => {
      setConnected(true);
      onProblem?.(null);
    };

    socket.onmessage = async (event) => {
      let message: {
        type: string;
        data?: string;
        width?: number;
        height?: number;
        error?: string;
        url?: string;
        origin?: string;
        awaitingAcceptance?: boolean;
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "error") {
        onProblem?.(message.error ?? "The screen could not be shown.");
        return;
      }
      /*
       * Which document these frames are of.
       *
       * The screen said nothing about this until a Bot began following the windows a site opens, and
       * then it had to: the page being cast is chosen by the site, the swap happens within a second,
       * and a person typing a password into a screen has no other way to tell whose page it is.
       */
      if (message.type === "page") {
        setShowing({
          url: message.url ?? "",
          origin: message.origin ?? "",
          awaitingAcceptance: message.awaitingAcceptance === true,
        });
        return;
      }
      if (message.type !== "frame" || !message.data) return;

      const canvas = canvasRef.current;
      if (!canvas || closed) return;

      frameSize.current = {
        width: message.width ?? 1280,
        height: message.height ?? 800,
      };

      /**
       * Decoded off the main thread and drawn as a bitmap.
       *
       * `createImageBitmap` rather than assigning a data URI to an `<img>`: the image path decodes
       * synchronously on the main thread for every frame, which at screencast rates is the difference
       * between a smooth page and one that stutters while you are trying to click something on it.
       */
      try {
        const binary = Uint8Array.from(atob(message.data), (c) =>
          c.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([binary], { type: "image/jpeg" }),
        );
        if (closed) {
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        // Ignore a single corrupt frame; the next frame replaces it.
      }
    };

    socket.onerror = () => onProblem?.("The live screen could not be reached.");
    socket.onclose = () => setConnected(false);

    return () => {
      closed = true;
      socket.close();
      socketRef.current = null;
    };
    // The socket is per Bot; switching Bot must close this stream and open the next one.
  }, [computerId, onProblem]);

  const send = useCallback(
    (message: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (!driving || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message));
    },
    [driving],
  );

  /**
   * The person saying they meant to be on the window that took their screen.
   *
   * Sent bare: which origin is being agreed to is decided by the computer, from what it is actually
   * holding back, so a message from here cannot accept an address the person was never shown. The
   * banner does not clear itself either — it goes when the computer says the page is accepted, which
   * is the same fact that lets input through.
   */
  const acceptPage = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "accept-page" }));
  }, []);

  /**
   * Convert from displayed canvas coordinates to page coordinates with the shared, tested helper.
   * A screencast frame is the viewport, so its frame size stands in for natural image size.
   */
  const at = useCallback((event: React.MouseEvent) => {
    const canvas = canvasRef.current;
    const size = frameSize.current;
    if (!canvas || !size) return null;
    return pageCoordinates(
      { naturalWidth: size.width, naturalHeight: size.height },
      canvas.getBoundingClientRect(),
      event,
    );
  }, []);

  const onMouse = useCallback(
    (kind: "pressed" | "released" | "moved") =>
      (event: React.MouseEvent<HTMLCanvasElement>) => {
        const point = at(event);
        if (!point) return;
        send({
          type: "mouse",
          event: kind,
          ...point,
          button:
            event.button === 2
              ? "right"
              : event.button === 1
                ? "middle"
                : "left",
          clickCount: kind === "moved" ? 0 : 1,
          modifiers: modifierBits(event),
        });
      },
    [at, send],
  );

  /**
   * Keystrokes, forwarded while driving.
   *
   * Listen on window because canvas cannot hold focus. `preventDefault` keeps Tab and typing directed
   * at the remote page while takeover is active.
   */
  useEffect(() => {
    if (!driving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return; // Escape still closes the view.
      event.preventDefault();
      send({
        type: "key",
        event: "down",
        key: event.key,
        code: event.code,
        // Only a printable character carries text. Sending text for Backspace makes Chrome insert a
        // character instead of deleting one.
        ...(event.key.length === 1 ? { text: event.key } : {}),
        modifiers: modifierBits(event),
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      event.preventDefault();
      send({
        type: "key",
        event: "up",
        key: event.key,
        code: event.code,
        modifiers: modifierBits(event),
      });
    };
    /** Paste arrives as one block; CDP inserts it as text rather than key events. */
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text");
      if (!text) return;
      event.preventDefault();
      send({ type: "text", text });
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  }, [driving, send]);

  const blocked = driving && showing?.awaitingAcceptance === true;

  return (
    <div className="relative">
      {/*
        The address, above the picture, for the same reason a browser puts one there.

        Always, not only while driving: somebody watching a Bot work should be able to see where it
        has got to, and a bar that appeared only at the moment of danger would be a bar nobody had
        learned to read. The origin rather than the whole URL, because the rest of a URL is where a
        lookalike hides its real host behind a long and reassuring path.
      */}
      {showing ? (
        <div
          className="flex items-center gap-2 border-white/10 border-b bg-black/60 px-3 py-1.5 font-mono text-white/80 text-xs"
          title={showing.url}
        >
          <span className="shrink-0 text-white/40">Showing</span>
          <span className="truncate">{showing.origin}</span>
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className={`block h-auto w-full ${driving ? "cursor-crosshair" : ""}`}
        // Only forward input during takeover.
        {...(driving
          ? {
              onMouseDown: onMouse("pressed"),
              onMouseUp: onMouse("released"),
              onMouseMove: onMouse("moved"),
              onContextMenu: (event: React.MouseEvent) =>
                event.preventDefault(),
              onWheel: (event: React.WheelEvent<HTMLCanvasElement>) => {
                const point = at(event);
                if (!point) return;
                event.preventDefault();
                send({
                  type: "wheel",
                  ...point,
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                  modifiers: modifierBits(event),
                });
              },
            }
          : {})}
        aria-label={
          driving
            ? "The assistant's screen. You have control: click and type here."
            : "The assistant's screen, live"
        }
        data-connected={connected}
      />
      {/*
        A window nobody asked for, and the one moment a person can still catch it.

        Every click a Bot makes is a user gesture, so a page carrying a compromised script can open a
        window at any address and have it take this screen within a second — arriving, in a sign-in
        the Bot has just handed over for, exactly when a sign-in window is expected. The computer is
        refusing input until this is answered; this draws what it is refusing and why.

        Over the page rather than beside it. The picture underneath is the convincing part, and a
        notice below the fold is one nobody reads before typing.
      */}
      {blocked && showing ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 p-6 text-center">
          <p className="font-medium text-sm text-white">
            A window opened by itself and took this screen.
          </p>
          <p className="max-w-md break-all font-mono text-sm text-white/90">
            {showing.origin}
          </p>
          <p className="max-w-md text-white/70 text-xs">
            Nothing you type reaches it until you continue. Check that address
            is the site you meant to sign in to — if it is not the one you
            expect, hand the wheel back instead.
          </p>
          <button
            type="button"
            onClick={acceptPage}
            className="rounded-md bg-white px-3 py-1.5 font-medium text-black text-xs"
          >
            I meant to go here — continue
          </button>
        </div>
      ) : null}
    </div>
  );
}
