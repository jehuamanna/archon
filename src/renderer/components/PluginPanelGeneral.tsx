import { getArchon } from "../../shared/archon-host-access";
import React, { useEffect, useState } from "react";
import { useArchonDialog } from "../dialog/ArchonDialogProvider";

interface PluginPanelGeneralProps {
  onPluginsChanged?: () => void;
}

const PluginPanelGeneral: React.FC<PluginPanelGeneralProps> = ({
  onPluginsChanged,
}) => {
  const { confirm } = useArchonDialog();
  const [path, setPath] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void getArchon()
      .getUserPluginsDirectory()
      .then((r) => {
        if (r.path) {
          setPath(r.path);
        } else {
          setPath(r.error ?? "—");
        }
      })
      .catch((e) => {
        setPath(e instanceof Error ? e.message : "Failed to load plugins directory");
      });
  }, []);

  const handleImportPlugin = async () => {
    try {
      setImporting(true);
      setMessage(null);
      const pkgPath = await getArchon().selectZipFile();
      if (!pkgPath) {
        setMessage({
          type: "info",
          text: "No plugin zip path was returned (dialog cancelled, or file picking is not available in this environment — use the Archon desktop app to import from disk).",
        });
        return;
      }
      const pre = await getArchon().validatePluginZip(pkgPath);
      if (!pre.valid) {
        setMessage({
          type: "error",
          text: `Validation failed:\n${pre.errors.join("\n")}`,
        });
        return;
      }
      if (pre.warnings.length > 0) {
        setMessage({
          type: "info",
          text: `Warnings:\n${pre.warnings.join("\n")}`,
        });
      }
      const result = await getArchon().importPlugin(pkgPath);
      if (!result.success) {
        setMessage({
          type: "error",
          text: result.error || "Failed to import plugin",
        });
        return;
      }
      const w =
        result.warnings?.length && result.warnings.length > 0
          ? `\nWarnings:\n${result.warnings.join("\n")}`
          : "";
      setMessage({
        type: "success",
        text: `Plugin imported successfully!${w}`,
      });
      onPluginsChanged?.();
      const again = await getArchon().getUserPluginsDirectory();
      if (again.path) {
        setPath(again.path);
      } else if (again.error) {
        setPath(again.error);
      }
    } catch (e) {
      setMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Failed to import plugin",
      });
    } finally {
      setImporting(false);
    }
  };

  const run = async (
    key: string,
    fn: () => Promise<{ success: boolean; error?: string }>,
    okText: string,
  ) => {
    setWorking(key);
    setMessage(null);
    try {
      const res = await fn();
      if (res.success) {
        setMessage({ type: "success", text: okText });
        onPluginsChanged?.();
        const again = await getArchon().getUserPluginsDirectory();
        if (again.path) {
          setPath(again.path);
        } else if (again.error) {
          setPath(again.error);
        }
      } else {
        setMessage({
          type: "error",
          text: res.error ?? "Operation failed",
        });
      }
    } catch (e) {
      setMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Operation failed",
      });
    } finally {
      setWorking(null);
    }
  };

  const handleDeleteBinAndCaches = async () => {
    const ok = await confirm({
      title: "Clear bin and caches",
      message:
        "Remove all plugins from bin/, clear the global npm plugin cache (app cache folder), and clear the TypeScript main cache under the plugins folder? Sources are kept.",
      confirmLabel: "Clear",
      variant: "danger",
    });
    if (!ok) {
      return;
    }
    await run(
      "bin",
      () => getArchon().deletePluginBinAndCaches(),
      "bin/, dependency cache, and plugin main cache cleared. Registry reloaded.",
    );
  };

  const handleDeleteSources = async () => {
    const ok = await confirm({
      title: "Delete plugin sources",
      message:
        "Delete everything under sources/? External IDE plugin registrations are not removed. This cannot be undone.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) {
      return;
    }
    await run(
      "sources",
      () => getArchon().deleteAllPluginSources(),
      "sources/ was emptied and the registry reloaded.",
    );
  };

  const handleFormat = async () => {
    const display = path ?? "user plugins folder";
    const ok1 = await confirm({
      title: "Format Archon plugin data",
      message: `This deletes:
• ${display}
• userData/archon-cache (including global npm plugin cache)
• Legacy ~/.archon if present

Sample markdown/tiptap sources will be re-seeded. Plugin disable flags are reset. Bundled core plugins are unchanged.`,
      confirmLabel: "Continue",
      variant: "danger",
    });
    if (!ok1) {
      return;
    }
    const ok2 = await confirm({
      title: "Confirm format",
      message: "Proceed with full format now?",
      confirmLabel: "Format",
      variant: "danger",
    });
    if (!ok2) {
      return;
    }
    await run(
      "format",
      () => getArchon().formatArchonPluginData(),
      "Format complete. Plugins folder re-seeded and registry reloaded.",
    );
  };

  return (
    <div className="flex h-full flex-col overflow-auto bg-background px-4 py-4 text-foreground">
      <header className="mb-4 border-b border-border pb-3">
        <h2 className="text-[13px] font-semibold">General</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Maintenance actions for the user plugins directory and global caches.
        </p>
      </header>

      <p className="mb-4 text-[11px] font-mono break-all rounded border border-border bg-muted/40 p-2 text-foreground">
        {path ?? "Loading path…"}
      </p>

      {message && (
        <div
          className={`mb-4 rounded-lg border p-3 text-[12px] ${
            message.type === "success"
              ? "border-border bg-muted/50 text-foreground"
              : "border-border bg-muted/70 text-foreground"
          }`}
        >
          {message.text}
        </div>
      )}

      <section className="mb-8 space-y-3">
        <h3 className="text-[12px] font-semibold text-foreground">
          Import plugin
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Import a packaged plugin file (
          <code className="rounded bg-muted px-1">.archonplugin</code> or{" "}
          <code className="rounded bg-muted px-1">.zip</code>) into your plugins
          directory.
        </p>
        <button
          type="button"
          disabled={working !== null || importing}
          className="archon-btn-neutral rounded-md px-3 py-1.5 text-[12px] font-semibold"
          onClick={() => void handleImportPlugin()}
        >
          {importing ? "Importing…" : "Import plugin…"}
        </button>
      </section>

      <section className="mb-8 space-y-3">
        <h3 className="text-[12px] font-semibold text-foreground">
          Delete all plugins (bin and cache)
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Empties <code className="rounded bg-muted px-1">bin/</code>, removes{" "}
          <code className="rounded bg-muted px-1">.plugin-main-cache</code> under
          the plugins root, and clears{" "}
          <code className="rounded bg-muted px-1">userData/archon-cache/plugin-cache</code>.
          Does not remove <code className="rounded bg-muted px-1">sources/</code>.
        </p>
        <button
          type="button"
          disabled={working !== null}
          className="archon-btn-neutral rounded-md px-3 py-1.5 text-[12px] font-semibold"
          onClick={() => void handleDeleteBinAndCaches()}
        >
          {working === "bin" ? "Working…" : "Delete bin and caches"}
        </button>
      </section>

      <section className="mb-8 space-y-3">
        <h3 className="text-[12px] font-semibold text-foreground">
          Delete all sources
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Removes and recreates the empty{" "}
          <code className="rounded bg-muted px-1">sources/</code> folder.
        </p>
        <button
          type="button"
          disabled={working !== null}
          className="archon-btn-neutral rounded-md px-3 py-1.5 text-[12px] font-semibold"
          onClick={() => void handleDeleteSources()}
        >
          {working === "sources" ? "Working…" : "Delete all sources"}
        </button>
      </section>

      <section className="space-y-3 border-t border-border pt-6">
        <h3 className="text-[12px] font-semibold text-foreground">Format</h3>
        <p className="text-[11px] text-muted-foreground">
          Removes <code className="rounded bg-muted px-1">userData/archon-cache</code>,
          legacy <code className="rounded bg-muted px-1">~/.archon</code> if present,
          and the entire plugins directory, then re-seeds sample plugins and resets
          disabled-plugin flags.
        </p>
        <button
          type="button"
          disabled={working !== null}
          className="archon-btn-neutral-strong rounded-md px-3 py-1.5 text-[12px] font-semibold"
          onClick={() => void handleFormat()}
        >
          {working === "format" ? "Formatting…" : "Format Archon plugin data"}
        </button>
      </section>
    </div>
  );
};

export default PluginPanelGeneral;
