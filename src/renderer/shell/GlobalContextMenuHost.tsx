import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  parseInternalMarkdownNoteLink,
  type InternalMarkdownNoteLink,
} from "../../shared/markdown-internal-note-href";
import { resolveNoteIdFromVfsPath } from "../utils/resolve-note-vfs-path";
import { useToast } from "../toast/ToastContext";
import { ctxBtn } from "../notes-sidebar/notes-sidebar-utils";
import { openExternalNavigationUrl } from "./openExternalNavigationUrl";
import { useShellNavigation } from "./useShellNavigation";

const MENU_Z = "z-[110]";

type LinkPayload = {
  copyUrl: string;
  openUrl: string;
  /** http / https / mailto */
  externalScheme: boolean;
  internal: InternalMarkdownNoteLink | null;
};

type MenuModel =
  | null
  | {
      x: number;
      y: number;
      link?: LinkPayload;
      imageSrc?: string;
      codeMirror?: boolean;
      selectionText?: string;
    };

function deriveMenu(ev: MouseEvent): MenuModel {
  const t = ev.target;
  if (!(t instanceof Element)) {
    return null;
  }

  const anchor = t.closest("a[href]");
  const insideOwn = t.closest("[data-archon-own-contextmenu]");
  if (insideOwn) {
    const allowGlobalLink =
      anchor instanceof HTMLAnchorElement && !t.closest("[data-note-row]");
    if (!allowGlobalLink) {
      return null;
    }
  }

  if (anchor instanceof HTMLAnchorElement) {
    const hrefAttr = anchor.getAttribute("href") ?? "";
    let absolute: string;
    try {
      absolute = new URL(hrefAttr, window.location.href).href;
    } catch {
      return null;
    }
    let proto: string;
    try {
      proto = new URL(absolute).protocol.toLowerCase();
    } catch {
      return null;
    }
    if (proto === "javascript:") {
      return null;
    }
    const externalScheme =
      proto === "http:" || proto === "https:" || proto === "mailto:";
    const internal = parseInternalMarkdownNoteLink(hrefAttr);
    return {
      x: ev.clientX,
      y: ev.clientY,
      link: {
        copyUrl: absolute,
        openUrl: absolute,
        externalScheme,
        internal,
      },
    };
  }

  const img = t.closest("img[src]");
  if (img instanceof HTMLImageElement) {
    const src = img.currentSrc || img.src;
    if (src) {
      return { x: ev.clientX, y: ev.clientY, imageSrc: src };
    }
  }

  if (t.closest(".cm-editor")) {
    return { x: ev.clientX, y: ev.clientY, codeMirror: true };
  }

  const sel = document.getSelection()?.toString() ?? "";
  const trimmed = sel.trim();
  if (trimmed.length > 0) {
    return { x: ev.clientX, y: ev.clientY, selectionText: trimmed };
  }

  return null;
}

function cmRoot(el: Element | null): HTMLElement | null {
  if (!el) {
    return null;
  }
  return el.closest(".cm-editor") as HTMLElement | null;
}

function cmReadOnly(cm: HTMLElement): boolean {
  return cm.querySelector(".cm-content[contenteditable='false']") != null;
}

export function GlobalContextMenuHost(): React.ReactElement | null {
  const [menu, setMenu] = useState<MenuModel>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { openNoteById } = useShellNavigation();
  const { showToast } = useToast();

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
      setMenu(deriveMenu(e));
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => document.removeEventListener("contextmenu", onContextMenu, true);
  }, []);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        close();
      }
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) {
        return;
      }
      const node = e.target as Node;
      if (menuRef.current?.contains(node)) {
        return;
      }
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [menu, close]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      return;
    }
    const el = menuRef.current;
    const r = el.getBoundingClientRect();
    const pad = 6;
    let left = menu.x;
    let top = menu.y;
    if (left + r.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - r.width - pad);
    }
    if (top + r.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - r.height - pad);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [menu]);

  const copyText = useCallback(
    async (text: string, errLabel: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        showToast({ severity: "error", message: errLabel });
      }
    },
    [showToast],
  );

  if (!menu) {
    return null;
  }

  const { x, y, link, imageSrc, codeMirror, selectionText } = menu;

  const cmEl =
    codeMirror && document.activeElement instanceof HTMLElement
      ? cmRoot(document.activeElement)
      : null;
  const ro = cmEl ? cmReadOnly(cmEl) : true;

  let body: React.ReactNode = null;
  if (link) {
    body = (
      <>
        {link.internal ? (
          <>
            <button
              type="button"
              role="menuitem"
              className={ctxBtn}
              onClick={() => {
                const internal = link.internal!;
                close();
                if (internal.kind === "noteId") {
                  openNoteById(internal.noteId, {
                    markdownHeadingSlug: internal.markdownHeadingSlug,
                  });
                  return;
                }
                void resolveNoteIdFromVfsPath(internal.vfsPath).then((id) => {
                  if (!id) return;
                  openNoteById(id, {
                    markdownHeadingSlug: internal.markdownHeadingSlug,
                    canonicalVfsPath: internal.vfsPath,
                  });
                });
              }}
            >
              Open note
            </button>
            <button
              type="button"
              role="menuitem"
              className={ctxBtn}
              onClick={() => {
                const internal = link.internal!;
                close();
                if (internal.kind === "noteId") {
                  openNoteById(internal.noteId, {
                    markdownHeadingSlug: internal.markdownHeadingSlug,
                    newTab: true,
                  });
                  return;
                }
                void resolveNoteIdFromVfsPath(internal.vfsPath).then((id) => {
                  if (!id) return;
                  openNoteById(id, {
                    markdownHeadingSlug: internal.markdownHeadingSlug,
                    newTab: true,
                    canonicalVfsPath: internal.vfsPath,
                  });
                });
              }}
            >
              Open note in new tab
            </button>
          </>
        ) : (
          <button
            type="button"
            role="menuitem"
            className={ctxBtn}
            onClick={() => {
              close();
              void openExternalNavigationUrl(link.openUrl);
            }}
          >
            Open in new tab
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className={ctxBtn}
          onClick={() => {
            void copyText(link.copyUrl, "Could not copy link");
            close();
          }}
        >
          Copy link
        </button>
      </>
    );
  } else if (imageSrc) {
    let openImage: React.ReactNode = null;
    try {
      const p = new URL(imageSrc).protocol.toLowerCase();
      if (p === "http:" || p === "https:") {
        openImage = (
          <button
            type="button"
            role="menuitem"
            className={ctxBtn}
            onClick={() => {
              close();
              void openExternalNavigationUrl(imageSrc);
            }}
          >
            Open image in new tab
          </button>
        );
      }
    } catch {
      /* ignore */
    }
    body = (
      <>
        <button
          type="button"
          role="menuitem"
          className={ctxBtn}
          onClick={() => {
            void copyText(imageSrc, "Could not copy image address");
            close();
          }}
        >
          Copy image address
        </button>
        {openImage}
      </>
    );
  } else if (selectionText) {
    body = (
      <button
        type="button"
        role="menuitem"
        className={ctxBtn}
        onClick={() => {
          void copyText(selectionText, "Could not copy");
          close();
        }}
      >
        Copy
      </button>
    );
  } else if (codeMirror) {
    body = (
      <>
        <button
          type="button"
          role="menuitem"
          className={ctxBtn}
          onClick={() => {
            void copyText(
              document.getSelection()?.toString() ?? "",
              "Could not copy",
            );
            close();
          }}
        >
          Copy
        </button>
        {!ro ? (
          <>
            <button
              type="button"
              role="menuitem"
              className={ctxBtn}
              onClick={() => {
                document.execCommand("cut");
                close();
              }}
            >
              Cut
            </button>
            <button
              type="button"
              role="menuitem"
              className={ctxBtn}
              onClick={() => {
                void (async () => {
                  try {
                    const t = await navigator.clipboard.readText();
                    document.execCommand("insertText", false, t);
                  } catch {
                    document.execCommand("paste");
                  }
                  close();
                })();
              }}
            >
              Paste
            </button>
          </>
        ) : null}
        <button
          type="button"
          role="menuitem"
          className={ctxBtn}
          onClick={() => {
            document.execCommand("selectAll");
            close();
          }}
        >
          Select all
        </button>
      </>
    );
  }

  if (!body) {
    return null;
  }

  const portal = (
    <div
      ref={menuRef}
      role="menu"
      className={`fixed ${MENU_Z} min-w-[200px] rounded-md border border-border bg-popover py-1 shadow-md`}
      style={{ left: x, top: y }}
    >
      {body}
    </div>
  );

  return createPortal(portal, document.body);
}
