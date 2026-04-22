"use client";

import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useDispatch, useSelector } from "react-redux";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  platformDeps,
  type AppDispatch,
  type RootState,
} from "../../../store";
import {
  cloudLoginThunk,
  cloudLogoutThunk,
  cloudRegisterThunk,
} from "../../../store/cloudAuthSlice";
import {
  patchCloudNoteLocal,
  runCloudSyncThunk,
  softDeleteCloudNoteLocal,
} from "../../../store/cloudNotesSlice";
import { useTheme } from "../../../theme/ThemeContext";
import { isEphemeralScratchExperience } from "../../../auth/scratch-experience";

export function CloudSyncMainView(): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const { resolvedDark } = useTheme();
  const auth = useSelector((s: RootState) => s.cloudAuth);
  const selectedId = useSelector((s: RootState) => s.cloudNotes.selectedId);
  const note = useSelector((s: RootState) =>
    selectedId ? s.cloudNotes.byId[selectedId] : undefined,
  );
  const syncError = useSelector((s: RootState) => s.cloudNotes.syncError);
  const syncStatus = useSelector((s: RootState) => s.cloudNotes.syncStatus);
  const apiBase = platformDeps.remoteApi.getBaseUrl() || "(not set)";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [previewMd, setPreviewMd] = useState(note?.content ?? "");

  useEffect(() => {
    if (note) {
      setPreviewMd(note.content);
    }
  }, [note?.id]);

  useEffect(() => {
    if (!note || note.type !== "markdown") {
      return;
    }
    const t = window.setTimeout(() => setPreviewMd(note.content), 280);
    return () => window.clearTimeout(t);
  }, [note?.content, note?.type]);

  const cmExtensions = useMemo(() => {
    if (!note) {
      return [EditorView.lineWrapping];
    }
    if (note.type === "markdown") {
      return [markdown(), EditorView.lineWrapping];
    }
    if (note.type === "code") {
      return [javascript(), EditorView.lineWrapping];
    }
    return [EditorView.lineWrapping];
  }, [note?.type]);

  if (auth.status === "signedOut") {
    return (
      <div className="box-border h-full overflow-auto p-6">
        <h2 className="text-[13px] font-semibold text-foreground">Cloud sync</h2>
        <p className="mt-1 max-w-lg text-[12px] text-muted-foreground">
          Mongo-backed notes via the Fastify sync API. Legacy workspace notes are
          unchanged. API base:{" "}
          <span className="font-mono text-[11px]">{apiBase || "see env"}</span>
        </p>
        {isEphemeralScratchExperience() ? (
          <p className="mt-3 max-w-lg rounded-md border border-amber-500/35 bg-amber-500/10 p-2 text-[11px] leading-relaxed text-muted-foreground">
            Scratch / try-out: notes use IndexedDB (and browser try-out also uses a localStorage flag) on this device
            until you authenticate. Sign in below to use the sync API (Mongo) when configured.
          </p>
        ) : null}
        <div className="mt-6 max-w-sm space-y-3">
          {auth.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {auth.error}
            </div>
          ) : null}
          <div className="flex gap-2 text-[11px]">
            <button
              type="button"
              className={`rounded px-2 py-1 ${mode === "login" ? "bg-muted font-medium" : ""}`}
              onClick={() => setMode("login")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={`rounded px-2 py-1 ${mode === "register" ? "bg-muted font-medium" : ""}`}
              onClick={() => setMode("register")}
            >
              Register
            </button>
          </div>
          <label className="block text-[12px]">
            <span className="text-muted-foreground">Email</span>
            <input
              type="email"
              autoComplete="email"
              className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5 text-[12px]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block text-[12px]">
            <span className="text-muted-foreground">Password (min 8)</span>
            <input
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5 text-[12px]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={auth.busy || !email.trim() || password.length < 8}
            className="rounded border border-input bg-background px-3 py-2 text-[12px] shadow-sm hover:bg-muted/50 disabled:opacity-50"
            onClick={() => {
              if (mode === "login") {
                void dispatch(cloudLoginThunk({ email: email.trim(), password }));
              } else {
                void dispatch(cloudRegisterThunk({ email: email.trim(), password }));
              }
            }}
          >
            {auth.busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="box-border flex h-full min-h-0 flex-col overflow-hidden p-4">
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div className="text-[12px] text-muted-foreground">
          Signed in as{" "}
          <span className="font-medium text-foreground">{auth.email}</span>
          {syncStatus === "syncing" ? (
            <span className="ml-2 text-[11px]">Syncing…</span>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-input bg-background px-2 py-1 text-[11px] hover:bg-muted/50"
            onClick={() => void dispatch(runCloudSyncThunk())}
          >
            Sync now
          </button>
          <button
            type="button"
            className="rounded border border-input bg-background px-2 py-1 text-[11px] hover:bg-muted/50"
            title="Logout: end this sync session on this device. Server-side notes remain in the cloud."
            onClick={() => void dispatch(cloudLogoutThunk())}
          >
            Logout
          </button>
        </div>
      </div>
      {syncError ? (
        <p className="mb-2 shrink-0 text-[11px] text-destructive">{syncError}</p>
      ) : null}
      {!note || note.deleted ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
          Select a cloud note in the sidebar or create a new one.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <input
            type="text"
            className="shrink-0 rounded border border-input bg-background px-2 py-1.5 text-[13px] font-medium"
            value={note.title}
            onChange={(e) =>
              dispatch(
                patchCloudNoteLocal({ id: note.id, title: e.target.value }),
              )
            }
          />
          <select
            className="shrink-0 max-w-xs rounded border border-input bg-background px-2 py-1 text-[12px]"
            value={note.type}
            onChange={(e) =>
              dispatch(
                patchCloudNoteLocal({
                  id: note.id,
                  type: e.target.value as typeof note.type,
                }),
              )
            }
          >
            <option value="markdown">markdown</option>
            <option value="text">text</option>
            <option value="code">code</option>
          </select>
          {note.type === "markdown" ? (
            <PanelGroup
              direction="horizontal"
              className="min-h-0 flex-1 rounded border border-border"
            >
              <Panel defaultSize={52} minSize={28} className="min-h-0 min-w-0">
                <div className="flex h-full min-h-[200px] flex-col border-r border-border">
                  <div className="border-b border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Editor
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden text-[12px]">
                    <CodeMirror
                      key={note.id}
                      value={note.content}
                      height="100%"
                      theme={resolvedDark ? "dark" : "light"}
                      basicSetup={{
                        lineNumbers: true,
                        foldGutter: false,
                        highlightActiveLine: true,
                      }}
                      className="archon-cloud-cm h-full min-h-0 [&_.cm-editor]:h-full [&_.cm-scroller]:min-h-[180px]"
                      extensions={cmExtensions}
                      onChange={(v) =>
                        dispatch(
                          patchCloudNoteLocal({ id: note.id, content: v }),
                        )
                      }
                    />
                  </div>
                </div>
              </Panel>
              <PanelResizeHandle className="w-1.5 shrink-0 bg-border hover:bg-muted-foreground/30" />
              <Panel defaultSize={48} minSize={22} className="min-h-0 min-w-0">
                <div className="flex h-full min-h-[200px] flex-col overflow-hidden">
                  <div className="border-b border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Preview
                  </div>
                  <div className="archon-cloud-md-preview min-h-0 flex-1 overflow-auto px-3 py-2 text-[12px] leading-relaxed text-foreground [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeSanitize]}
                    >
                      {previewMd || "*Nothing to preview*"}
                    </ReactMarkdown>
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden rounded border border-border">
              <CodeMirror
                key={note.id}
                value={note.content}
                height="100%"
                theme={resolvedDark ? "dark" : "light"}
                basicSetup={{
                  lineNumbers: note.type === "code",
                  foldGutter: false,
                  highlightActiveLine: true,
                }}
                className="archon-cloud-cm h-full min-h-0 text-[12px] [&_.cm-editor]:h-full [&_.cm-scroller]:min-h-[200px]"
                extensions={cmExtensions}
                onChange={(v) =>
                  dispatch(patchCloudNoteLocal({ id: note.id, content: v }))
                }
              />
            </div>
          )}
          <div className="shrink-0">
            <button
              type="button"
              className="text-[11px] text-destructive hover:underline"
              onClick={() => dispatch(softDeleteCloudNoteLocal(note.id))}
            >
              Delete (soft — syncs to server)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
