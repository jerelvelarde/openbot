/**
 * Reading from the data source, and re-reading when it says something changed.
 *
 * Screens hold no copy of their own. The source is authoritative and announces; a screen that cached
 * would be the thing that shows an approval as still pending after somebody answered it on a laptop,
 * which is precisely the failure a companion cannot have.
 */
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { DataSource } from "./data/source";

const SourceContext = createContext<DataSource | null>(null);

export function SourceProvider({
  source,
  children,
}: {
  source: DataSource;
  children: ReactNode;
}) {
  return (
    <SourceContext.Provider value={source}>{children}</SourceContext.Provider>
  );
}

export function useSource(): DataSource {
  const source = useContext(SourceContext);
  if (!source) throw new Error("No data source above this screen.");
  return source;
}

/**
 * Run a read, and run it again whenever the source announces.
 *
 * `undefined` while the first read is in flight, so a screen can tell "nothing yet" from "nothing at
 * all" — an empty approval queue and an unloaded one look identical otherwise, and only one of them
 * means there is nothing waiting on you.
 */
export function useLive<T>(
  read: (source: DataSource) => Promise<T>,
): T | undefined {
  const source = useSource();
  const [value, setValue] = useState<T | undefined>(undefined);

  /**
   * The reader, held rather than depended on.
   *
   * Callers write `useLive((s) => s.approvals())` inline, so the function is a new identity every
   * render. Depending on it would resubscribe on every render; the source is the identity that
   * actually matters, and the latest reader is always the one that runs.
   */
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    let current = true;
    const refresh = () => {
      void readRef.current(source).then((next) => {
        if (current) setValue(next);
      });
    };
    refresh();
    const stop = source.subscribe(refresh);
    return () => {
      current = false;
      stop();
    };
  }, [source]);

  return value;
}
