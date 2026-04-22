/** Minibuffer (M-x) result echo: commands dispatch this so output appears under the input bar. */

export const ARCHON_MINIBAR_OUTPUT_EVENT = "archon-minibar-output";

export type ArchonMinibarEchoDetail = {
  text: string;
  kind?: "info" | "error";
};

export function emitArchonMinibarOutput(
  text: string,
  kind: ArchonMinibarEchoDetail["kind"] = "info",
): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<ArchonMinibarEchoDetail>(ARCHON_MINIBAR_OUTPUT_EVENT, {
        detail: { text, kind },
      }),
    );
  } catch {
    /* ignore */
  }
}
