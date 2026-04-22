import { getArchon } from "../../shared/archon-host-access";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface MainDebugLogLine {
  ts: number;
  level: string;
  text: string;
}

const RENDERER_CAP = 3000;

export function useMainDebugLogStream(): {
  mainDebugLogs: MainDebugLogLine[];
  logScrollRef: RefObject<HTMLPreElement | null>;
  clearMainDebugLogs: () => Promise<void>;
} {
  const [mainDebugLogs, setMainDebugLogs] = useState<MainDebugLogLine[]>([]);
  const logScrollRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    void (async () => {
      try {
        const initial = await getArchon().getMainDebugLogBuffer();
        setMainDebugLogs(initial);
      } catch {
        /* ignore */
      }
      unsub = getArchon().onMainDebugLog((entry) => {
        setMainDebugLogs((prev) => {
          const next = [...prev, entry];
          return next.length > RENDERER_CAP
            ? next.slice(-RENDERER_CAP)
            : next;
        });
      });
    })();
    return () => unsub?.();
  }, []);

  useEffect(() => {
    const el = logScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [mainDebugLogs]);

  const clearMainDebugLogs = useCallback(async () => {
    try {
      await getArchon().clearMainDebugLogBuffer();
      setMainDebugLogs([]);
    } catch {
      setMainDebugLogs([]);
    }
  }, []);

  return { mainDebugLogs, logScrollRef, clearMainDebugLogs };
}
