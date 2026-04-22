#!/usr/bin/env python3
"""One-off: split src/core/plugin-loader.ts into an inheritance chain (<500 LOC each)."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src/core/plugin-loader.ts.bak"
OUT = ROOT / "src/core"
BARREL = ROOT / "src/core/plugin-loader.ts"

HEADER = '''import { execFileSync, spawn } from "child_process";
import * as crypto from "crypto";
import { app } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getArchonDerivedCacheRoot } from "./archon-paths";
import { Registry } from "./registry";
import {
  isSafePluginName,
  isSafeRelativePluginSourcePath,
} from "../shared/validators";
import { manifestValidator } from "./manifest-validator";
import { packageManager } from "./package-manager";
import { pluginCacheManager } from "./plugin-cache-manager";
import { npmPackageExistsOnRegistry } from "./npm-registry-stub";
import { emitPluginProgress } from "./plugin-progress";
import { pluginBundler } from "./plugin-bundler";
import * as esbuild from "esbuild";
import {
  typecheckPluginWorkspace,
  type TypecheckDiagnostic,
} from "./plugin-typecheck";
import { toFileUri } from "../shared/file-uri";
import { designSystemWarning } from "../shared/design-system";
import {
  readDisabledPluginIds,
  writeDisabledPluginIds,
} from "./plugin-disabled-store";
import { syncHostArchonScopedPackagesIntoWorkspace } from "./archon-host-packages";
import { seedSamplePluginsToUserDir } from "./seed-user-plugins";
import type { NoteRenderer } from "../shared/plugin-api";
import { writeHybridPluginScaffoldFiles } from "./plugin-loader-scaffold-writer";
import type { PluginManifest } from "./plugin-loader-types";
'''

INVALIDATE = '''  protected invalidateDevUiCacheForWorkspace(workspaceRoot: string): void {
    for (const key of [...this.devUiBundleCache.keys()]) {
      if (key.startsWith(`${workspaceRoot}:`)) {
        this.devUiBundleCache.delete(key);
      }
    }
  }
'''


def privatize(s: str) -> str:
    s = s.replace(
        "private static readonly RESERVED_TOP_LEVEL",
        "protected static readonly RESERVED_TOP_LEVEL",
    )
    s = re.sub(r"^  private ", "  protected ", s, flags=re.MULTILINE)
    return s


def slice_lines(lines: list[str], start_1: int, end_1: int) -> str:
    """Inclusive 1-based line numbers."""
    return "\n".join(lines[start_1 - 1 : end_1])


def main() -> None:
    lines = SRC.read_text().splitlines()

    base = slice_lines(lines, 56, 351) + "\n" + slice_lines(lines, 391, 434)
    base = privatize(base)
    base = base.replace("export class PluginLoader {", "export class PluginLoaderBase {")
    base = base.replace("PluginLoader.RESERVED_TOP_LEVEL", "PluginLoaderBase.RESERVED_TOP_LEVEL")

    (OUT / "plugin-loader-base.ts").write_text(
        HEADER + "\n" + base + "\n" + INVALIDATE + "}\n"
    )

    runtime = slice_lines(lines, 354, 390) + "\n" + slice_lines(lines, 458, 579)
    runtime = privatize(runtime)
    runtime = runtime.replace(
        "PluginLoader.RESERVED_TOP_LEVEL",
        "PluginLoaderBase.RESERVED_TOP_LEVEL",
    )

    registry = slice_lines(lines, 580, 784)
    registry = privatize(registry)
    registry = registry.replace(
        "PluginLoader.RESERVED_TOP_LEVEL",
        "PluginLoaderBase.RESERVED_TOP_LEVEL",
    )
    load_user = privatize(slice_lines(lines, 436, 455))
    registry = registry + "\n" + load_user

    bundle = privatize(slice_lines(lines, 1181, 1277)).replace(
        "PluginLoader.RESERVED_TOP_LEVEL",
        "PluginLoaderBase.RESERVED_TOP_LEVEL",
    )

    deps = privatize(slice_lines(lines, 1282, 1718)).replace(
        "PluginLoader.RESERVED_TOP_LEVEL",
        "PluginLoaderBase.RESERVED_TOP_LEVEL",
    )

    sources_head = privatize(slice_lines(lines, 1720, 1756)).replace(
        "PluginLoader.RESERVED_TOP_LEVEL",
        "PluginLoaderBase.RESERVED_TOP_LEVEL",
    )

    parent_file = {
        "PluginLoaderBase": "plugin-loader-base",
        "PluginLoaderRuntime": "plugin-loader-runtime",
        "PluginLoaderRegistry": "plugin-loader-registry",
        "PluginLoaderZipExport": "plugin-loader-zip-export",
        "PluginLoaderBundle": "plugin-loader-bundle",
        "PluginLoaderDeps": "plugin-loader-deps",
        "PluginLoaderSources": "plugin-loader-sources",
        "PluginLoaderSourcesExt": "plugin-loader-sources-ext",
        "PluginLoaderImportTree": "plugin-loader-import-tree",
        "PluginLoaderIdeTypings": "plugin-loader-ide-typings",
    }

    def write_layer(fname: str, cls: str, parent: str, chunk: str) -> None:
        pf = parent_file[parent]
        (OUT / fname).write_text(
            HEADER
            + f'import {{ {parent} }} from "./{pf}";\n\n'
            + f"export class {cls} extends {parent} {{\n"
            + chunk
            + "\n}\n"
        )

    write_layer("plugin-loader-runtime.ts", "PluginLoaderRuntime", "PluginLoaderBase", runtime)
    write_layer("plugin-loader-registry.ts", "PluginLoaderRegistry", "PluginLoaderRuntime", registry)
    zip_chunk = privatize(slice_lines(lines, 785, 1179)).replace(
        "PluginLoader.RESERVED_TOP_LEVEL",
        "PluginLoaderBase.RESERVED_TOP_LEVEL",
    )
    write_layer("plugin-loader-zip-export.ts", "PluginLoaderZipExport", "PluginLoaderRegistry", zip_chunk)

    write_layer("plugin-loader-bundle.ts", "PluginLoaderBundle", "PluginLoaderZipExport", bundle)
    write_layer("plugin-loader-deps.ts", "PluginLoaderDeps", "PluginLoaderBundle", deps)

    # sources / import-tree / ide (unchanged ranges)
    sources_tail = privatize(slice_lines(lines, 1758, 1949)).replace(
        "PluginLoader.RESERVED_TOP_LEVEL",
        "PluginLoaderBase.RESERVED_TOP_LEVEL",
    )
    sources_chunk = sources_head + "\n" + sources_tail

    sources_ext = privatize(slice_lines(lines, 1951, 2214)).replace(
        "PluginLoader.RESERVED_TOP_LEVEL",
        "PluginLoaderBase.RESERVED_TOP_LEVEL",
    )

    write_layer("plugin-loader-sources.ts", "PluginLoaderSources", "PluginLoaderDeps", sources_chunk)
    write_layer(
        "plugin-loader-sources-ext.ts",
        "PluginLoaderSourcesExt",
        "PluginLoaderSources",
        sources_ext,
    )

    chain_tail = [
        ("plugin-loader-import-tree.ts", "PluginLoaderImportTree", "PluginLoaderSourcesExt", 2215, 2476),
        ("plugin-loader-ide-typings.ts", "PluginLoaderIdeTypings", "PluginLoaderImportTree", 2477, 2689),
    ]

    for fname, cls, parent, start, end in chain_tail:
        if fname == "plugin-loader-import-tree.ts":
            a = slice_lines(lines, start, 2265)
            b = slice_lines(lines, 2273, end)
            chunk = a + "\n" + b
        else:
            chunk = slice_lines(lines, start, end)
        chunk = privatize(chunk)
        chunk = chunk.replace(
            "PluginLoader.RESERVED_TOP_LEVEL",
            "PluginLoaderBase.RESERVED_TOP_LEVEL",
        )
        write_layer(fname, cls, parent, chunk)

    finish = privatize(slice_lines(lines, 2691, 2773))
    (OUT / "plugin-loader-finish.ts").write_text(
        HEADER
        + 'import { PluginLoaderIdeTypings } from "./plugin-loader-ide-typings";\n\n'
        + "export class PluginLoader extends PluginLoaderIdeTypings {\n"
        + finish
        + "\n}\n"
    )

    barrel = '''export type {
  NetworkConfig,
  ArchonAPI,
  Permission,
  Plugin,
  PluginManifest,
  PluginMode,
  PluginType,
} from "./plugin-loader-types";

export { PluginLoader } from "./plugin-loader-finish";
'''
    BARREL.write_text(barrel)


if __name__ == "__main__":
    main()
