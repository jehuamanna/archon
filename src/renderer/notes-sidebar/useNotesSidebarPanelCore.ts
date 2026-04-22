import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CreateNoteRelation,
  NoteListItem,
  NoteMovePlacement,
  PasteSubtreePayload,
} from "@archon/ui-types";
import { buildWorkspaceSidebarSections } from "../../shared/sidebar-assets-rows";
import {
  runWpnNoteTitleRenameWithVfsDependentsFlow,
  type VfsDependentTitleRenameChoice,
} from "../shell/wpn/vfsDependentTitleRenameChoice";
import {
  minimalSelectedRoots,
  parentMapFromNotes,
  readCollapsedIds,
  readWorkspaceSectionExpandedMap,
  visibleNotesList,
  writeCollapsedIds,
  writeWorkspaceSectionExpandedMap,
  WORKSPACE_MOUNT_ROW_RE,
  type ClipboardState,
  type ContextMenuState,
  type DropHint,
} from "./notes-sidebar-utils";
import {
  dropAllowedMany,
  dropAllowedOne,
  idsToDragForRow,
  placementFromPointer,
} from "./notes-sidebar-panel-dnd";

export interface NotesSidebarPanelCoreProps {
  notes: NoteListItem[];
  registeredTypes: string[];
  currentNoteId?: string;
  onNoteSelect: (noteId: string) => void;
  onRenameNote: (id: string, title: string, options?: { updateVfsDependentLinks?: boolean }) => Promise<void>;
  onMoveNote: (payload: {
    draggedId: string;
    targetId: string;
    placement: NoteMovePlacement;
  }) => Promise<void>;
  onMoveNotesBulk: (payload: {
    ids: string[];
    targetId: string;
    placement: NoteMovePlacement;
  }) => Promise<void>;
  workspaceRoots: string[];
  vfsRenamePrompt?: (dependentNoteCount: number) => Promise<VfsDependentTitleRenameChoice>;
}

export function useNotesSidebarPanelCore({
  notes,
  registeredTypes,
  currentNoteId,
  onNoteSelect,
  onRenameNote,
  onMoveNote,
  onMoveNotesBulk,
  workspaceRoots,
  vfsRenamePrompt,
}: NotesSidebarPanelCoreProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(readCollapsedIds);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState>(null);
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const [workspaceSectionExpanded, setWorkspaceSectionExpanded] = useState<
    Record<string, boolean>
  >(() => readWorkspaceSectionExpandedMap());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingBulkCount, setDraggingBulkCount] = useState(0);
  const draggingRef = useRef<string | null>(null);
  const draggingIdsRef = useRef<string[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const parents = useMemo(() => parentMapFromNotes(notes), [notes]);

  const lastTopLevelId = useMemo(() => {
    let last: string | null = null;
    for (const n of notes) {
      if (n.depth === 0 && !WORKSPACE_MOUNT_ROW_RE.test(n.id)) {
        last = n.id;
      }
    }
    return last;
  }, [notes]);

  const noteIdSet = useMemo(() => new Set(notes.map((n) => n.id)), [notes]);

  const hasChildrenMap = useMemo(() => {
    const m = new Set<string>();
    for (const n of notes) {
      if (n.parentId) {
        m.add(n.parentId);
      }
    }
    return m;
  }, [notes]);

  const visibleNotes = useMemo(
    () => visibleNotesList(notes, collapsedIds, parents),
    [notes, collapsedIds, parents],
  );

  useEffect(() => {
    setCollapsedIds((prev) => {
      const next = new Set([...prev].filter((id) => noteIdSet.has(id)));
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) {
        return prev;
      }
      writeCollapsedIds(next);
      return next;
    });
  }, [noteIdSet]);

  useEffect(() => {
    setSelectedNoteIds((prev) => {
      const next = new Set([...prev].filter((id) => noteIdSet.has(id)));
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) {
        return prev;
      }
      return next;
    });
  }, [noteIdSet]);

  useEffect(() => {
    if (!currentNoteId || !noteIdSet.has(currentNoteId)) {
      return;
    }
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      let p = parents.get(currentNoteId) ?? null;
      let changed = false;
      while (p) {
        if (next.has(p)) {
          next.delete(p);
          changed = true;
        }
        p = parents.get(p) ?? null;
      }
      if (!changed) {
        return prev;
      }
      writeCollapsedIds(next);
      return next;
    });
  }, [currentNoteId, parents, noteIdSet]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedNoteIds(new Set());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const closeMenu = () => setMenu(null);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) {
        return;
      }
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      writeCollapsedIds(next);
      return next;
    });
  };

  const toggleWorkspaceSection = useCallback((sectionKey: string) => {
    setWorkspaceSectionExpanded((prev) => {
      const wasOpen = prev[sectionKey] !== false;
      const next = { ...prev };
      if (wasOpen) {
        next[sectionKey] = false;
      } else {
        delete next[sectionKey];
      }
      writeWorkspaceSectionExpandedMap(next);
      return next;
    });
  }, []);

  const getTypeBadgeClass = (type: string): string => {
    switch (type) {
      case "markdown":
      case "mdx":
        return "bg-badge-markdown-bg text-badge-markdown-fg";
      case "text":
        return "bg-badge-text-bg text-badge-text-fg";
      case "code":
        return "bg-badge-code-bg text-badge-code-fg";
      default:
        return "bg-badge-default-bg text-badge-default-fg";
    }
  };

  const openRename = (id: string, title: string) => {
    closeMenu();
    setRenameTarget({ id, title });
    setRenameDraft(title);
  };

  const submitRename = async () => {
    if (!renameTarget) {
      return;
    }
    const t = renameDraft.trim();
    if (!t) {
      return;
    }

    if (vfsRenamePrompt) {
      const outcome = await runWpnNoteTitleRenameWithVfsDependentsFlow({
        noteId: renameTarget.id,
        currentTitle: renameTarget.title,
        newTitle: t,
        prompt: vfsRenamePrompt,
        rename: async (updateVfsDependentLinks) => {
          await onRenameNote(renameTarget.id, t, { updateVfsDependentLinks });
        },
      });
      if (outcome === "cancelled") {
        setRenameTarget(null);
        return;
      }
      if (outcome === "unchanged") {
        setRenameTarget(null);
        return;
      }
    } else {
      await onRenameNote(renameTarget.id, t);
    }

    setRenameTarget(null);
  };

  const dropOne = (draggedId: string, targetId: string, placement: NoteMovePlacement) =>
    dropAllowedOne(draggedId, targetId, placement, parents);

  const dropMany = (draggedIds: string[], targetId: string, placement: NoteMovePlacement) =>
    dropAllowedMany(draggedIds, targetId, placement, parents);

  const dragIdsForRow = (noteId: string) =>
    idsToDragForRow(noteId, selectedNoteIds, parents);

  const workspaceSections = useMemo(
    () => buildWorkspaceSidebarSections(visibleNotes, workspaceRoots),
    [visibleNotes, workspaceRoots],
  );

  const padForSectionNote = (note: NoteListItem, depthTrim: number) =>
    6 + Math.max(0, note.depth - depthTrim) * 12;

  const multiSelectCount = selectedNoteIds.size;
  const bulkDeleteRoots =
    multiSelectCount > 1
      ? minimalSelectedRoots(selectedNoteIds, parents)
      : [];

  const handleRowClick = (
    noteId: string,
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    const idx = visibleNotes.findIndex((n) => n.id === noteId);
    if (e.shiftKey && selectionAnchorRef.current) {
      const a = visibleNotes.findIndex((n) => n.id === selectionAnchorRef.current);
      if (a >= 0 && idx >= 0) {
        const lo = Math.min(a, idx);
        const hi = Math.max(a, idx);
        const next = new Set<string>();
        for (let i = lo; i <= hi; i++) {
          next.add(visibleNotes[i]!.id);
        }
        setSelectedNoteIds(next);
        void onNoteSelect(noteId);
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelectedNoteIds((prev) => {
        const next = new Set(prev);
        if (next.has(noteId)) {
          next.delete(noteId);
        } else {
          next.add(noteId);
        }
        return next;
      });
      selectionAnchorRef.current = noteId;
      void onNoteSelect(noteId);
      return;
    }
    setSelectedNoteIds(new Set([noteId]));
    selectionAnchorRef.current = noteId;
    void onNoteSelect(noteId);
  };

  return {
    collapsedIds,
    selectedNoteIds,
    setSelectedNoteIds,
    selectionAnchorRef,
    menu,
    setMenu,
    clipboard,
    setClipboard,
    renameTarget,
    setRenameTarget,
    renameDraft,
    setRenameDraft,
    dropHint,
    setDropHint,
    workspaceSectionExpanded,
    draggingId,
    setDraggingId,
    draggingBulkCount,
    setDraggingBulkCount,
    draggingRef,
    draggingIdsRef,
    menuRef,
    parents,
    lastTopLevelId,
    hasChildrenMap,
    visibleNotes,
    closeMenu,
    toggleCollapsed,
    toggleWorkspaceSection,
    getTypeBadgeClass,
    openRename,
    submitRename,
    placementFromPointer,
    dropAllowedOne: dropOne,
    dropAllowedMany: dropMany,
    idsToDragForRow: dragIdsForRow,
    workspaceSections,
    padForSectionNote,
    handleRowClick,
    multiSelectCount,
    bulkDeleteRoots,
    notes,
    registeredTypes,
    currentNoteId,
    onNoteSelect,
    onMoveNote,
    onMoveNotesBulk,
    workspaceRoots,
  };
}
