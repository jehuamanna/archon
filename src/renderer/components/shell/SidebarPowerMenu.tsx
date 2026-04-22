import { getArchon } from "../../../shared/archon-host-access";
import React, { useEffect, useRef, useState } from "react";
import { useArchonDialog } from "../../dialog/ArchonDialogProvider";

const ABOUT_MESSAGE = `Archon is a desktop app for notes and small projects on disk, with a tree of notes where each item can use different editors and views through plugins—markdown, rich text, code, and more.

This build is a proof-of-concept: a real Electron shell with a safe boundary between core UI and third-party plugin UI.`;

const ABOUT_DETAIL = `Author: Jehu Shalom Amanna`;

const menuBtn =
  "block w-full rounded-sm px-2.5 py-2 text-left text-[12px] text-popover-foreground outline-none hover:bg-accent hover:text-accent-foreground transition-colors duration-150";

function PowerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.77 0" />
    </svg>
  );
}

type Layout = "expanded" | "collapsed";

const SidebarPowerMenu: React.FC<{ layout: Layout }> = ({ layout }) => {
  const { confirm, alert } = useArchonDialog();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDoc = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const onReload = () => {
    setOpen(false);
    void (async () => {
      const ok = await confirm({
        title: "Reload window",
        message:
          "Reload the entire app window? Anything not yet saved to disk may be lost.",
        confirmLabel: "Reload",
        variant: "default",
      });
      if (ok) {
        void getArchon().reloadWindow();
      }
    })();
  };

  const onQuit = () => {
    setOpen(false);
    void (async () => {
      const ok = await confirm({
        title: "Exit Archon",
        message: "Quit the application?",
        confirmLabel: "Exit",
        variant: "danger",
      });
      if (ok) {
        void getArchon().quitApp();
      }
    })();
  };

  const onAbout = () => {
    setOpen(false);
    void alert({
      title: "About Archon",
      message: ABOUT_MESSAGE,
      detail: ABOUT_DETAIL,
      okLabel: "Close",
    });
  };

  const iconOnly = layout === "collapsed";

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button
        type="button"
        title="Session"
        aria-label="Session menu"
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex items-center justify-center rounded-md border border-sidebar-border/60 bg-sidebar-accent/20 text-sidebar-foreground/85 outline-none transition-colors hover:bg-sidebar-accent/45 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
          iconOnly ? "h-10 w-10" : "h-9 min-w-[2.25rem] px-2"
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        <PowerIcon className="shrink-0" />
      </button>
      {open ? (
        <div
          className={`absolute z-[160] min-w-[11rem] rounded-md border border-border bg-popover py-1 shadow-md ${
            iconOnly ? "bottom-full left-0 mb-1" : "bottom-full left-0 mb-1"
          }`}
          role="menu"
        >
          <button type="button" role="menuitem" className={menuBtn} onClick={onReload}>
            Reload window
          </button>
          <button type="button" role="menuitem" className={menuBtn} onClick={onQuit}>
            Exit Archon
          </button>
          <div className="my-1 h-px bg-border" role="separator" />
          <button type="button" role="menuitem" className={menuBtn} onClick={onAbout}>
            About Archon
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default SidebarPowerMenu;
