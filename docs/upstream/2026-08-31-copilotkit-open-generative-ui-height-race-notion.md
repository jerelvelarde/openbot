# CopilotKit bug: Open Generative UI interfaces restored from thread history are clipped

**Status:** Diagnosed, fixed, tested — **not yet filed upstream.**

| | |
|---|---|
| Package | `@copilotkit/react-core` |
| Affected versions | `1.69.0` (OpenBot's pin) and `main` @ `302483c` (`1.69.3`) — the file is byte-identical across both |
| File | `packages/react-core/src/v2/components/OpenGenerativeUIRenderer.tsx` |
| Severity | Silent data loss in the UI — no error, no scrollbar, no visual cue |
| Duplicate check | None found (`search_issues` over `CopilotKit/CopilotKit`) |
| Blocker to filing | GitHub access was scoped to `jerelvelarde/openbot`; `issue_write` and `add_repo` both refused `CopilotKit/CopilotKit` |

---

## Symptom

Generate an interface that renders taller than the activity's `initialHeight`, then reload the page so the thread restores from persisted history.

| | Wrapper height | Correct? |
|---|---|---|
| Live-streamed | `346px` (measured `body.scrollHeight`) | ✅ |
| Restored from history | `300px` (the activity's `initialHeight`) | ❌ |

The wrapper is `overflow: hidden`, so everything below 300px is silently clipped. `autoHeight` stays `null` forever.

The `300` is the activity payload's own `initialHeight` — the model picks it per activity. The SDK's fallback when it is absent is `200`.

## Root cause

"Effect 4", the one-shot height measurement (line 434 on `main`):

```tsx
const generationDone = content.generating === false;
useEffect(() => {
  const sandbox = sandboxRef.current;
  if (!generationDone || !sandbox) return;
  // window.addEventListener("message", …) → sandbox.run(measureOnce)
  //   → postMessage __ck_resize → setAutoHeight(h)
}, [generationDone]);
```

`sandboxRef.current` is assigned **asynchronously**, inside the `import("@jetbrains/websandbox").then(...)` of Effect 1. The effect's only dependency is `generationDone`.

For a **live** generation, `content.generating` flips `true → false` *after* the sandbox already exists, so the effect re-runs at that moment and measures correctly.

For an activity **restored from persisted history**, `content.generating` is already `false` on the very first render:

1. Effect 4 runs in the first commit, while `sandboxRef.current` is still `null`.
2. It hits `if (!generationDone || !sandbox) return;` and bails.
3. `generationDone` never changes again, so the effect **never re-runs** — even though the sandbox becomes ready milliseconds later.

The `pendingQueueRef` fallback further down in the same effect was clearly meant to cover "sandbox not ready yet", but it is **unreachable** in this path: the `!sandbox` guard returns before it, so nothing is ever queued.

### Second symptom, same root cause

If `fullHtml` / `css` / `localApi` change after generation has finished, Effect 1 recreates the sandbox and its cleanup resets `autoHeight` to `null` — but Effect 4 still doesn't re-run, so the new sandbox is never measured either.

## The fix

Mirror the sandbox-ready signal as **state** so the measurement effect can depend on it:

```tsx
const [sandboxReady, setSandboxReady] = useState(false);
```

- `setSandboxReady(false)` next to the existing `sandboxReadyRef.current = false` resets (Effect 1's body and its cleanup)
- `setSandboxReady(true)` next to `sandboxReadyRef.current = true` inside `sandbox.promise.then(...)`
- Effect 4 becomes `if (!generationDone || !sandboxReady || !sandbox) return;` with `}, [generationDone, sandboxReady]);`

Because the effect then only runs when the sandbox is genuinely ready, the unreachable `pendingQueueRef` branch inside it goes away and `sandbox.run(measureOnce)` is called directly. `sandboxReadyRef` stays as-is for the synchronous "queue or run" checks in Effects 2 and 3. This also fixes the recreation case, since the state resets and re-flips per sandbox.

## Verification

The fix was validated against the **real upstream source**, not the bundle:

1. `1.69.0`'s `dist/copilotkit-ykQW_VJZ.mjs.map` carries `sourcesContent`, so the original `OpenGenerativeUIRenderer.tsx` was extracted from it and diffed against `CopilotKit@302483c` — identical modulo trailing whitespace, confirming the bug is live on `main`.
2. The renderer plus its four local imports were lifted into a standalone vitest harness (`@copilotkit/core` and `@copilotkit/shared` stubbed, `@jetbrains/websandbox` aliased — the upstream test file mocks it anyway). All **21 existing renderer tests pass unmodified** in the harness, so it is faithful.
3. Three tests were added, then the patch applied.
4. `tsc --noEmit` over the patched file reports nothing beyond the harness's own stub-resolution errors.

| Test | Before fix | After fix |
|---|---|---|
| `measures height when generation completes after the sandbox exists` (live path) | ✅ 346px | ✅ |
| `measures height when generating is already false on first render` (restored) | ❌ 0 measure calls, stuck at 300px | ✅ |
| `re-measures after the sandbox is recreated for new html` | ❌ 0 measure calls | ✅ |

**24/24 pass** with the patch (21 existing + 3 new).

There is currently **zero upstream test coverage of the height measurement** — which is how this shipped.

## Patch

Applies cleanly to `CopilotKit@302483c` (verified with `git apply --check`). The renderer change:

```diff
@@ -172,6 +172,10 @@ const OpenGenerativeUIActivityRendererInner = React.memo(
   function OpenGenerativeUIActivityRendererInner({ content }: InnerProps) {
     const initialHeight = content.initialHeight ?? 200;
     const [autoHeight, setAutoHeight] = useState<number | null>(null);
+    // Mirrors `sandboxReadyRef` as state so effects that need to wait for the
+    // sandbox can list it as a dependency and re-run once it exists. The ref
+    // stays for the synchronous "queue or run" checks below.
+    const [sandboxReady, setSandboxReady] = useState(false);
     const sandboxFunctions = useSandboxFunctions();
 
     const localApi = useMemo(() => {
@@ -324,6 +328,7 @@ const OpenGenerativeUIActivityRendererInner = React.memo(
       executedIndexRef.current = 0;
       jsFunctionsInjectedRef.current = false;
       sandboxReadyRef.current = false;
+      setSandboxReady(false);
       pendingQueueRef.current = [];
 
       // Dynamic import to avoid SSR issues (websandbox references `self` at module level)
@@ -352,6 +357,7 @@ const OpenGenerativeUIActivityRendererInner = React.memo(
           sandbox.promise.then(() => {
             if (cancelled) return;
             sandboxReadyRef.current = true;
+            setSandboxReady(true);
 
             // Prevent scrollbars — the container auto-sizes to fit content
             sandbox.run(`
@@ -388,6 +394,7 @@ const OpenGenerativeUIActivityRendererInner = React.memo(
           sandboxRef.current = null;
         }
         sandboxReadyRef.current = false;
+        setSandboxReady(false);
         setAutoHeight(null);
       };
     }, [fullHtml, css, localApi]);
@@ -428,13 +435,20 @@ const OpenGenerativeUIActivityRendererInner = React.memo(
       }
     }, [content.jsExpressions?.length]);
 
-    // Effect 4 — One-shot height measurement (fires once when generation completes)
+    // Effect 4 — One-shot height measurement (fires once generation is done and
+    // the sandbox is ready). Both conditions are dependencies: an activity
+    // restored from persisted thread history arrives with `generating: false`
+    // already set, so this effect first runs before the asynchronously created
+    // sandbox exists and has to run again once it does. Without `sandboxReady`
+    // in the dependency list the measurement would never happen for restored
+    // activities and the wrapper would stay at `initialHeight`, clipping any
+    // taller interface (the wrapper is `overflow: hidden`).
     // Uses body.scrollHeight (not documentElement.scrollHeight) because the latter
     // is clamped to the iframe viewport and can never shrink below the current size.
     const generationDone = content.generating === false;
     useEffect(() => {
       const sandbox = sandboxRef.current;
-      if (!generationDone || !sandbox) return;
+      if (!generationDone || !sandboxReady || !sandbox) return;
 
       let handled = false;
       const onMessage = (e: MessageEvent) => {
@@ -464,16 +478,12 @@ const OpenGenerativeUIActivityRendererInner = React.memo(
         })();
       `;
 
-      if (sandboxReadyRef.current) {
-        sandbox.run(measureOnce);
-      } else {
-        pendingQueueRef.current.push(measureOnce);
-      }
+      sandbox.run(measureOnce);
 
       return () => {
         window.removeEventListener("message", onMessage);
       };
-    }, [generationDone]);
+    }, [generationDone, sandboxReady]);
 
     const height = autoHeight ?? initialHeight;
```

The full patch — including the 168-line `describe("height measurement")` test block for `__tests__/OpenGenerativeUIRenderer.test.tsx` — is in the `.patch` file linked below.

## Impact on OpenBot

Not workaroundable from outside the SDK: the height is written inline by the SDK's own `overflow: hidden` wrapper element. OpenBot has to wait for an upstream release, or patch the dependency locally.

## Where things live

Branch `jerel/nifty-brown-wglmxr` in `jerelvelarde/openbot`:

- `docs/upstream/2026-08-31-copilotkit-open-generative-ui-height-race.md` — the GitHub issue body, ready to post verbatim against CopilotKit's bug-report template
- `docs/upstream/2026-08-31-copilotkit-open-generative-ui-height-race.patch` — the full patch (renderer + tests)
- `docs/upstream/2026-08-31-copilotkit-open-generative-ui-height-race-notion.md` — this document

## Next step

File at https://github.com/CopilotKit/CopilotKit/issues/new with:

- **Title:** 🐛 Bug: Open Generative UI interfaces restored from thread history are clipped to `initialHeight` (height-measurement/sandbox race)
- **Label:** `bug`

Then open the PR from the patch. Per CopilotKit's `CONTRIBUTING.md`, the issue goes first.
