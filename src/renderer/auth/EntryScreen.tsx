import React, { useMemo, useState, useEffect } from "react";
import { AuthScreen } from "./AuthScreen";
import { ArchonLogo } from "../components/ArchonLogo";
import {
  isWebScratchSession,
  resetWebScratchClearLocalData,
  setWebScratchSession,
} from "./web-scratch";

type EntryView = "marketing" | "auth";
type AuthMode = "login" | "signup";

function MarketingHome({
  onLogin,
  onSignup,
  onTryBrowserScratch,
}: {
  onLogin: () => void;
  onSignup: () => void;
  onTryBrowserScratch: () => void;
}): React.ReactElement {
  const card =
    "rounded-xl border border-border bg-background/70 p-5 shadow-sm backdrop-blur";
  const pill =
    "inline-flex items-center gap-2 rounded-full border border-border bg-muted/10 px-3 py-1 text-[11px] text-muted-foreground";

  const useCases: Array<[string, string]> = [
    ["Product requirements & PRDs", "Shape the thing before you build it."],
    ["Design docs & architecture", "The reasoning you'll want to revisit in six months."],
    ["Code guidelines & playbooks", "The rules your AI tools should be reading."],
    ["Personal notes & journals", "Think out loud. Keep the thread."],
    ["Team wikis & shared refs", "Shared context without another SaaS."],
    ["Research & reading", "PDFs, clippings, and the thoughts they sparked."],
  ];

  const formats: Array<[string, string]> = [
    ["Markdown", "Preview-first, side-by-side editing."],
    ["Rich text", "For notes that aren't code-shaped."],
    ["Excalidraw", "Whiteboard and diagram in-place."],
    ["PDF & images", "Reference material lives here too."],
    ["Video & audio", "Embed a walkthrough. Ship a voice memo."],
    ["Code notebooks", "jsNotebook: compute inside your notes."],
    ["Canvas", "Spatial thinking when you need it."],
    ["…and more", "The format list keeps growing."],
  ];

  const whyArchon: Array<[string, string]> = [
    [
      "Keyboard-first, command-driven",
      "Fast like an IDE. Learn the keys once, compose them forever.",
    ],
    [
      "Self-documenting system",
      "Built-in docs hub and commands API, searchable without leaving the app.",
    ],
    [
      "Extensible toolkit",
      "First-party plugins, embedded IDE, jsNotebook. Make Archon yours.",
    ],
    [
      "Ready for agents",
      "One source of truth your AI tools can read — so your context travels with you.",
    ],
  ];

  const [desktopRelease, setDesktopRelease] = useState<
    { tag: string; deb: string | null; appimage: string | null } | "loading"
  >("loading");
  useEffect(() => {
    fetch("https://api.github.com/repos/jehuamanna/archon/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => {
        if (!r.ok) throw new Error("not ok");
        return r.json() as Promise<{
          tag_name: string;
          assets: Array<{ name: string; browser_download_url: string }>;
        }>;
      })
      .then((data) => {
        setDesktopRelease({
          tag: data.tag_name,
          deb: data.assets.find((a) => a.name.endsWith(".deb"))?.browser_download_url ?? null,
          appimage:
            data.assets.find((a) => a.name.endsWith(".AppImage"))?.browser_download_url ?? null,
        });
      })
      .catch(() => setDesktopRelease({ tag: "", deb: null, appimage: null }));
  }, []);

  return (
    <div className="relative flex h-screen min-h-0 w-full flex-col overflow-y-auto bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-[36rem] w-[36rem] rounded-full bg-primary/15 blur-3xl" />
        <div className="absolute -bottom-48 -right-40 h-[34rem] w-[34rem] rounded-full bg-primary/10 blur-3xl" />
      </div>

      <header className="sticky top-0 z-20 mx-auto flex w-full max-w-6xl items-center justify-between gap-3 border-b border-border/40 bg-background/70 px-4 py-4 backdrop-blur sm:px-6 sm:py-5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted/10 text-primary">
            <ArchonLogo className="h-5 w-5" title="Archon" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-[13px] font-semibold tracking-tight">Archon</div>
            <div className="hidden truncate text-[11px] text-muted-foreground sm:block">
              The knowledge base for software builders
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-nowrap items-center gap-2">
          <button
            type="button"
            className="h-9 rounded-md border border-foreground/20 bg-background px-3 text-[12px] text-foreground hover:bg-foreground/6"
            onClick={onLogin}
          >
            Login
          </button>
          <button
            type="button"
            className="archon-btn-neutral h-9 rounded-md px-3 text-[12px] font-medium"
            onClick={onSignup}
          >
            Signup
          </button>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 pb-14 pt-10">
        <section className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[1.25fr_1fr]">
          <div className="min-w-0">
            <div className={pill}>
              <span className="h-2 w-2 rounded-full bg-primary" />
              <span>For builders in the AI era</span>
            </div>
            <h1 className="mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-tight md:text-[52px]">
              Knowledge, centralized.{" "}
              <span className="text-primary">Building, accelerated.</span>
            </h1>
            <p className="mt-4 max-w-xl text-pretty text-[14px] leading-6 text-muted-foreground">
              Archon is a knowledge base for software builders — and for anyone who thinks, designs, and
              ships with notes. Keep PRDs, designs, code guidelines, and personal notes in one workspace
              your team — and your AI tools — can draw from.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="archon-btn-neutral h-10 rounded-md px-4 text-[13px] font-medium"
                onClick={onTryBrowserScratch}
              >
                Try in browser
              </button>
              <button
                type="button"
                className="h-10 rounded-md border border-foreground/20 bg-background px-4 text-[13px] text-foreground hover:bg-foreground/6"
                onClick={onSignup}
              >
                Create account
              </button>
              <a
                href="#download"
                className="inline-flex h-10 items-center rounded-md border border-foreground/20 bg-background px-4 text-[13px] text-foreground hover:bg-foreground/6"
              >
                Download for Linux
              </a>
            </div>
          </div>

          <div className="min-w-0">
            <div className="rounded-2xl border border-border bg-muted/10 p-5">
              <div className="text-[12px] font-semibold">The AI-era problem</div>
              <p className="mt-2 text-pretty text-[13px] leading-6 text-muted-foreground">
                Building with AI means context is exploding: chat logs, PRDs, design sketches,
                guidelines, personal notes — scattered across files, tabs, and tools.
              </p>
              <div className="mt-4 rounded-xl border border-border bg-background px-4 py-3 text-[12px] leading-5 text-foreground">
                Archon pulls it all into one workspace. One source of truth for humans and agents.
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="mb-4 flex items-end justify-between gap-3">
            <h2 className="text-[20px] font-semibold tracking-tight">Who it's for</h2>
            <div className="text-[11px] text-muted-foreground">Personal, then team</div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className={card}>
              <div className="text-[12px] font-semibold">Small software teams (1–5)</div>
              <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
                Ship fast with AI. Keep PRDs, code guidelines, and decisions where everyone —
                including your agents — can find them.
              </div>
            </div>
            <div className={card}>
              <div className="text-[12px] font-semibold">Solo builders & thinkers</div>
              <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
                Founders, designers, researchers, writers — anyone whose work lives in notes and
                wants a serious tool for it.
              </div>
            </div>
          </div>
          <div className="mt-3 rounded-xl border border-border bg-muted/10 px-4 py-3 text-[12px] leading-5 text-muted-foreground">
            Start personal. Grow into a team workspace.{" "}
            <span className="text-foreground">Same tool, same notes.</span>
          </div>
        </section>

        <section>
          <h2 className="text-[20px] font-semibold tracking-tight">What lives in Archon</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            From first scribble to shipped artifact — one workspace.
          </p>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {useCases.map(([title, body]) => (
              <div key={title} className={card}>
                <div className="text-[12px] font-semibold">{title}</div>
                <div className="mt-1 text-[12px] leading-5 text-muted-foreground">{body}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-[20px] font-semibold tracking-tight">Every format, one workspace</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Notes aren't one-size-fits-all. Neither is Archon.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {formats.map(([title, body]) => (
              <div
                key={title}
                className="rounded-xl border border-border bg-background/70 p-4 backdrop-blur"
              >
                <div className="text-[12px] font-semibold">{title}</div>
                <div className="mt-1 text-[11px] leading-5 text-muted-foreground">{body}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-[20px] font-semibold tracking-tight">Why Archon</h2>
          <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            {whyArchon.map(([title, body]) => (
              <div key={title} className={card}>
                <div className="text-[12px] font-semibold">{title}</div>
                <div className="mt-1 text-[12px] leading-5 text-muted-foreground">{body}</div>
              </div>
            ))}
          </div>
        </section>

        <section id="download">
          <h2 className="text-[20px] font-semibold tracking-tight">Download Archon</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Linux desktop app — direct download from the latest release.
          </p>
          <div className="mt-5">
            {desktopRelease === "loading" ? (
              <p className="text-[12px] text-muted-foreground">Checking for latest release…</p>
            ) : desktopRelease.deb !== null || desktopRelease.appimage !== null ? (
              <div className="flex flex-col gap-3 sm:flex-row">
                {desktopRelease.deb !== null && (
                  <a
                    href={desktopRelease.deb}
                    className="flex flex-col items-center justify-center gap-0.5 rounded-lg border border-border bg-card px-8 py-4 shadow-sm transition-colors hover:bg-accent"
                  >
                    <span className="text-[13px] font-semibold">
                      Download .deb{desktopRelease.tag ? ` · ${desktopRelease.tag}` : ""}
                    </span>
                    <span className="text-[11px] text-muted-foreground">Debian / Ubuntu</span>
                  </a>
                )}
                {desktopRelease.appimage !== null && (
                  <a
                    href={desktopRelease.appimage}
                    className="flex flex-col items-center justify-center gap-0.5 rounded-lg border border-border bg-card px-8 py-4 shadow-sm transition-colors hover:bg-accent"
                  >
                    <span className="text-[13px] font-semibold">
                      Download .AppImage{desktopRelease.tag ? ` · ${desktopRelease.tag}` : ""}
                    </span>
                    <span className="text-[11px] text-muted-foreground">Any Linux</span>
                  </a>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground">No desktop release available yet.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-muted/10 p-6">
          <div className="text-[12px] font-semibold text-muted-foreground">A useful mental model</div>
          <p className="mt-2 text-pretty text-[15px] leading-7 text-foreground">
            If you like tools that reward learning their keys and composing small actions into powerful
            workflows, Archon will feel familiar. Think of it as{" "}
            <span className="font-medium">Emacs for note-taking</span> — with a modern UI and every
            format your work actually uses.
          </p>
        </section>

        <section className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-background/70 p-6 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold">Start centralizing your knowledge</div>
            <div className="text-[12px] text-muted-foreground">
              Try it in the browser. No signup needed to poke around.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="archon-btn-neutral h-10 rounded-md px-4 text-[13px] font-medium"
              onClick={onTryBrowserScratch}
            >
              Try in browser
            </button>
            <button
              type="button"
              className="h-10 rounded-md border border-foreground/20 bg-background px-4 text-[13px] text-foreground hover:bg-foreground/6"
              onClick={onSignup}
            >
              Create account
            </button>
          </div>
        </section>
      </main>

      <footer className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center gap-2 px-6 pb-5 text-center text-[11px] text-muted-foreground">
        <button
          type="button"
          className="text-[11px] text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          onClick={onTryBrowserScratch}
        >
          Try in the browser — opens your saved try-out if you used it before on this device
        </button>
        <button
          type="button"
          className="text-[11px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
          onClick={() => {
            if (
              window.confirm(
                "Start a new try-out session? This clears try-out data in this browser (localStorage + IndexedDB). You cannot undo this.",
              )
            ) {
              void resetWebScratchClearLocalData();
            }
          }}
        >
          New try-out session (clears try-out notes in this browser)
        </button>
        <span>Built by Jehu Shalom Amanna</span>
      </footer>
    </div>
  );
}

export function EntryScreen(): React.ReactElement {
  const [view, setView] = useState<EntryView>("marketing");
  const [authMode, setAuthMode] = useState<AuthMode>("login");

  const onTryBrowserScratch = (): void => {
    if (!isWebScratchSession()) {
      setWebScratchSession(true);
    }
    window.location.reload();
  };

  const auth = useMemo(
    () => (
      <AuthScreen
        initialMode={authMode}
        onBack={() => {
          setView("marketing");
        }}
      />
    ),
    [authMode],
  );

  if (view === "auth") {
    return auth;
  }

  const marketing = (
    <MarketingHome
      onLogin={() => {
        setAuthMode("login");
        setView("auth");
      }}
      onSignup={() => {
        setAuthMode("signup");
        setView("auth");
      }}
      onTryBrowserScratch={onTryBrowserScratch}
    />
  );

  return marketing;
}

