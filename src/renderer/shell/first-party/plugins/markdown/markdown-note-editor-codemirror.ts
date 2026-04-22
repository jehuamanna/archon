import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { MutableRefObject } from "react";
import { createImagePasteExtension, type ImagePasteContext } from "../image-notes/markdown-image-paste";

export type MarkdownNoteWikiKeymapState = {
  readOnly: boolean;
  active: boolean;
  rowCount: number;
  onArrowDown: () => void;
  onArrowUp: () => void;
  onEnter: () => void;
  onEscape: () => void;
};

export type MarkdownNoteWikiKeymapRef = MutableRefObject<MarkdownNoteWikiKeymapState>;

export type MarkdownNoteSelectionSyncRef = MutableRefObject<
  ((from: number, to: number, head: number) => void) | null
>;

export type MarkdownNoteOnBlurRef = MutableRefObject<(() => void) | null>;

function markdownNoteEditorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        fontSize: "13px",
        height: "100%",
        backgroundColor: "transparent",
        color: dark ? "rgb(248 250 252)" : "rgb(15 23 42)",
      },
      ".cm-scroller": {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        overflow: "auto",
      },
      ".cm-content": {
        minHeight: "100%",
        padding: "12px",
        caretColor: dark ? "rgb(248 250 252)" : "rgb(15 23 42)",
      },
      ".cm-focused": {
        outline: "none",
      },
      ".cm-activeLine": {
        backgroundColor: dark ? "rgb(30 41 59 / 0.25)" : "rgb(241 245 249 / 0.6)",
      },
      ".cm-selectionBackground": {
        backgroundColor: dark ? "rgb(59 130 246 / 0.35)" : "rgb(59 130 246 / 0.2)",
      },
      "&.cm-editor.cm-focused": {
        outline: "none",
      },
    },
    { dark },
  );
}

function wikiLinkKeymapExtension(wikiKeymapRef: MarkdownNoteWikiKeymapRef): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: "ArrowDown",
        run: () => {
          const c = wikiKeymapRef.current;
          if (c.readOnly || !c.active || c.rowCount === 0) return false;
          c.onArrowDown();
          return true;
        },
      },
      {
        key: "ArrowUp",
        run: () => {
          const c = wikiKeymapRef.current;
          if (c.readOnly || !c.active || c.rowCount === 0) return false;
          c.onArrowUp();
          return true;
        },
      },
      {
        key: "Enter",
        run: () => {
          const c = wikiKeymapRef.current;
          if (c.readOnly || !c.active || c.rowCount === 0) return false;
          c.onEnter();
          return true;
        },
      },
      {
        key: "Escape",
        run: () => {
          const c = wikiKeymapRef.current;
          if (c.readOnly || !c.active || c.rowCount === 0) return false;
          c.onEscape();
          return true;
        },
      },
    ]),
  );
}

/**
 * CodeMirror extensions for system markdown notes (syntax, wrap, wiki-link keymap).
 *
 * `imagePasteCtxRef` is optional; when provided, the editor accepts pasted
 * image clipboard items and turns each into a child image note plus a vFS
 * reference inserted at the caret. Keeping the context in a ref lets the
 * extension list itself stay stable across React renders.
 */
export function markdownNoteEditorExtensions(opts: {
  dark: boolean;
  readOnly: boolean;
  wikiKeymapRef: MarkdownNoteWikiKeymapRef;
  selectionSyncRef: MarkdownNoteSelectionSyncRef;
  onBlurRef: MarkdownNoteOnBlurRef;
  imagePasteCtxRef?: MutableRefObject<ImagePasteContext>;
}): Extension[] {
  const {
    dark,
    readOnly,
    wikiKeymapRef,
    selectionSyncRef,
    onBlurRef,
    imagePasteCtxRef,
  } = opts;

  const extensions: Extension[] = [
    EditorState.readOnly.of(readOnly),
    markdown(),
    history(),
    indentOnInput(),
    bracketMatching(),
    EditorView.lineWrapping,
    markdownNoteEditorTheme(dark),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    wikiLinkKeymapExtension(wikiKeymapRef),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet) {
        const m = update.state.selection.main;
        selectionSyncRef.current?.(m.from, m.to, m.head);
      }
    }),
    EditorView.domEventHandlers({
      blur: () => {
        onBlurRef.current?.();
        return false;
      },
    }),
  ];

  if (imagePasteCtxRef) {
    extensions.push(createImagePasteExtension(imagePasteCtxRef));
  }

  return extensions;
}
