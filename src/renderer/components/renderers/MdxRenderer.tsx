import { getArchon } from "../../../shared/archon-host-access";
import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { MDXProvider } from "@mdx-js/react";
import * as mdxReact from "@mdx-js/react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as runtime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import type { Note } from "@archon/ui-types";
import { pickMdxTrustMode } from "../../utils/note-mdx-format";
import { getArchonMdxFacadeComponentMap } from "../../archon-mdx-facades/component-map";
import { remarkArchonMdxFacadeImports } from "../../utils/remark-archon-mdx-facade-imports";
import { remarkArchonMdxTrust } from "../../utils/remark-archon-mdx-trust";
import {
  DocLink,
  MdxCodeBlock,
  MdxSafeImage,
  ArchonButton,
  ArchonCallout,
  ArchonCard,
  NoteContext,
  ObservableEmbed,
  ObservableRuntimeEmbed,
} from "./mdx-embed-components";
import { MdxShellProvider, useMdxShell } from "./mdx-shell-context";
import { useArchonContributionRegistryMaybe } from "../../shell/ArchonContributionContext";
import { ReactMarkdownNoteBody, type MarkdownRendererProps } from "./ReactMarkdownNoteBody";
import { markdownShellClass, useArchonMarkdownUiComponents } from "./useArchonMarkdownUiComponents";
import { shouldRenderMdx } from "../../utils/note-mdx-format";

export type MdxRendererProps = MarkdownRendererProps & {
  nestingDepth?: number;
};

const MAX_DOC_EMBED_DEPTH = 6;

function DocPageEmbed({ noteId }: { noteId: string }): React.ReactElement {
  const shell = useMdxShell();
  const [note, setNote] = useState<Note | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (shell.nestingDepth >= MAX_DOC_EMBED_DEPTH) return;
    let cancelled = false;
    const id = String(noteId ?? "").trim();
    if (!id) {
      setErr("Missing noteId");
      return;
    }
    void (async () => {
      try {
        const n = await getArchon().getNote(id);
        if (cancelled) return;
        if (!n) {
          setErr(`Note not found: ${id}`);
          setNote(null);
          return;
        }
        setErr(null);
        setNote(n);
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setNote(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, shell.nestingDepth]);

  if (shell.nestingDepth >= MAX_DOC_EMBED_DEPTH) {
    return (
      <div className="my-2 text-[12px] text-muted-foreground">
        Maximum embedded documentation depth ({MAX_DOC_EMBED_DEPTH}) reached.
      </div>
    );
  }
  if (err) {
    return (
      <div className="my-2 text-[12px] text-destructive" role="alert">
        {err}
      </div>
    );
  }
  if (!note) {
    return <div className="my-2 text-[12px] text-muted-foreground">Loading embedded page…</div>;
  }

  const nextDepth = shell.nestingDepth + 1;

  return (
    <div className="my-4 rounded-md border border-border bg-muted/15 p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Embedded: {note.title || note.id}
      </div>
      {shouldRenderMdx(note) ? (
        <MdxRenderer
          note={note}
          nestingDepth={nextDepth}
          onSamePageHeadingClick={shell.onSamePageHeadingClick}
          onInternalNoteNavigate={shell.onInternalNoteNavigate}
          onArchonCmdLink={shell.onArchonCmdLink}
          onWelcomeShellSegmentClick={shell.onWelcomeShellSegmentClick}
          isLinkTargetValid={shell.isLinkTargetValid}
        />
      ) : (
        <ReactMarkdownNoteBody
          note={note}
          onSamePageHeadingClick={shell.onSamePageHeadingClick}
          onInternalNoteNavigate={shell.onInternalNoteNavigate}
          onArchonCmdLink={shell.onArchonCmdLink}
          onWelcomeShellSegmentClick={shell.onWelcomeShellSegmentClick}
          isLinkTargetValid={shell.isLinkTargetValid}
        />
      )}
    </div>
  );
}

function mdxBaseUrl(): string {
  if (typeof import.meta !== "undefined" && typeof import.meta.url === "string" && import.meta.url.length > 0) {
    return import.meta.url;
  }
  if (typeof window !== "undefined" && window.location?.href) {
    return window.location.href;
  }
  return "https://archon.local/mdx";
}

export function MdxRenderer({
  note,
  nestingDepth = 0,
  onSamePageHeadingClick,
  onInternalNoteNavigate,
  onArchonCmdLink,
  onWelcomeShellSegmentClick,
  isLinkTargetValid,
}: MdxRendererProps): React.ReactElement {
  const trustMode = pickMdxTrustMode(note);
  const trustRemarkPlugin = useMemo(() => remarkArchonMdxTrust(trustMode), [trustMode]);
  const facadeImportsRemark = useMemo(() => remarkArchonMdxFacadeImports(), []);
  const remarkPlugins = useMemo(
    () => [remarkGfm, remarkMdx, facadeImportsRemark, trustRemarkPlugin],
    [facadeImportsRemark, trustRemarkPlugin],
  );

  const { mdxComponents: uiMdx } = useArchonMarkdownUiComponents({
    onSamePageHeadingClick,
    onInternalNoteNavigate,
    onArchonCmdLink,
    onWelcomeShellSegmentClick,
    isLinkTargetValid,
  });

  const registry = useArchonContributionRegistryMaybe();
  useSyncExternalStore(
    (onChange: () => void) => (registry ? registry.subscribe(onChange) : () => {}),
    () => (registry ? registry.getSnapshotVersion() : 0),
    () => 0,
  );
  const pluginMdxComponents = registry ? registry.getMdxComponents() : {};

  const HOST_RESERVED = new Set([
    "ObservableEmbed", "ObservableRuntimeEmbed", "DocLink", "DocPage",
    "ArchonCallout", "ArchonCard", "ArchonButton", "NoteContext",
    "img", "pre", "script", "iframe",
  ]);

  const mdxMap = useMemo(
    () => ({
      ...getArchonMdxFacadeComponentMap(),
      ...Object.fromEntries(
        Object.entries(pluginMdxComponents).filter(([k]) => !HOST_RESERVED.has(k)),
      ),
      ...uiMdx,
      ObservableEmbed,
      ObservableRuntimeEmbed,
      DocLink,
      DocPage: DocPageEmbed,
      ArchonCallout,
      ArchonCard,
      ArchonButton,
      NoteContext,
      img: MdxSafeImage,
      pre: MdxCodeBlock,
      script: (): null => null,
      iframe: (): React.ReactElement => (
        <span className="text-[12px] text-muted-foreground">Raw iframe elements are not allowed in MDX.</span>
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uiMdx, pluginMdxComponents],
  );

  const shellValue = useMemo(
    () => ({
      nestingDepth,
      note,
      onSamePageHeadingClick,
      onInternalNoteNavigate,
      onArchonCmdLink,
      onWelcomeShellSegmentClick,
      isLinkTargetValid,
    }),
    [
      nestingDepth,
      note,
      onSamePageHeadingClick,
      onInternalNoteNavigate,
      onArchonCmdLink,
      onWelcomeShellSegmentClick,
      isLinkTargetValid,
    ],
  );

  const [Content, setContent] = useState<React.ComponentType | null>(null);
  const [compileErr, setCompileErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const src = note.content ?? "";
    setContent(null);
    setCompileErr(null);
    void (async () => {
      try {
        const { evaluate } = await import("@mdx-js/mdx");
        const isDev = process.env.NODE_ENV === "development";
        const mod = await evaluate(src, {
          ...mdxReact,
          ...runtime,
          ...(isDev ? { jsxDEV: jsxDevRuntime.jsxDEV } : {}),
          baseUrl: mdxBaseUrl(),
          remarkPlugins: [...remarkPlugins],
          development: isDev,
        });
        if (!cancelled) {
          setContent(() => mod.default);
        }
      } catch (e) {
        if (!cancelled) {
          setCompileErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [note.content, remarkPlugins]);

  return (
    <MdxShellProvider value={shellValue}>
      <div className={`p-4 archon-typography max-w-none min-w-0 ${markdownShellClass}`}>
        {compileErr ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive whitespace-pre-wrap">
            {compileErr}
          </div>
        ) : Content ? (
          <MDXProvider components={mdxMap}>
            <Content />
          </MDXProvider>
        ) : (
          <div className="text-[13px] text-muted-foreground">Compiling MDX…</div>
        )}
      </div>
    </MdxShellProvider>
  );
}
