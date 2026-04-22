import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { resolveArchonPluginUiEntry } from "./resolve-archon-plugin-ui";

function mergeArchonPluginUiForWorkspace(
  configDir: string,
  parsed: ts.ParsedCommandLine,
): void {
  const sdkEntry = resolveArchonPluginUiEntry();
  if (!sdkEntry) {
    return;
  }
  const mappedEntry = path.resolve(sdkEntry);
  const prevPaths = parsed.options.paths ?? {};
  const baseUrl = parsed.options.baseUrl ?? configDir;
  parsed.options = {
    ...parsed.options,
    baseUrl,
    paths: {
      ...prevPaths,
      "@archon/plugin-ui": [mappedEntry.split(path.sep).join("/")],
    },
  };
  const absSdk = path.resolve(sdkEntry);
  if (!parsed.fileNames.some((f) => path.resolve(f) === absSdk)) {
    parsed.fileNames = [...parsed.fileNames, absSdk];
  }
}

export interface TypecheckDiagnostic {
  relativePath: string;
  line: number;
  column: number;
  message: string;
  category: "error" | "warning" | "suggestion";
  code: number | undefined;
}

function formatHost(root: string): ts.FormatDiagnosticsHost {
  return {
    getCurrentDirectory: () => root,
    getCanonicalFileName: (f) => f,
    getNewLine: () => "\n",
  };
}

function diagnosticToRow(
  d: ts.Diagnostic,
  rootAbs: string,
): TypecheckDiagnostic | null {
  if (d.file === undefined || d.start === undefined) {
    return null;
  }
  const pos = d.file.getLineAndCharacterOfPosition(d.start);
  let rel = path.relative(rootAbs, d.file.fileName);
  rel = rel.split(path.sep).join("/");
  if (rel.startsWith("..")) {
    return null;
  }
  const cat =
    d.category === ts.DiagnosticCategory.Error
      ? "error"
      : d.category === ts.DiagnosticCategory.Warning
        ? "warning"
        : "suggestion";
  return {
    relativePath: rel,
    line: pos.line + 1,
    column: pos.character + 1,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    category: cat,
    code: d.code,
  };
}

/**
 * Run `tsc`-equivalent typecheck on a plugin workspace (on-disk files).
 * Optional extra @types roots (e.g. dependency cache) improve resolution when
 * node_modules lives outside the workspace.
 */
export function typecheckPluginWorkspace(
  rootAbs: string,
  extraTypesRoots?: string[],
): {
  success: boolean;
  error?: string;
  diagnostics: TypecheckDiagnostic[];
} {
  const root = path.resolve(rootAbs);
  if (!fs.existsSync(root)) {
    return { success: false, error: "Workspace not found", diagnostics: [] };
  }

  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  let parsed: ts.ParsedCommandLine;

  if (configPath) {
    const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
    if (readResult.error) {
      const msg = ts.formatDiagnostic(readResult.error, formatHost(root));
      return { success: false, error: msg, diagnostics: [] };
    }
    parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );
  } else {
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.React,
      strict: false,
      noEmit: true,
      allowJs: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
    };
    const typeRoots = (extraTypesRoots ?? []).filter((p) => fs.existsSync(p));
    if (typeRoots.length > 0) {
      compilerOptions.typeRoots = typeRoots;
    }
    parsed = ts.parseJsonConfigFileContent(
      {
        compilerOptions,
        include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
        exclude: ["node_modules", "dist", "bin", ".git"],
      },
      ts.sys,
      root,
      undefined,
      path.join(root, "tsconfig.json"),
    );
  }

  const configDir = configPath ? path.dirname(configPath) : root;
  mergeArchonPluginUiForWorkspace(configDir, parsed);

  if (parsed.errors.length > 0) {
    const msg = parsed.errors
      .map((e) => ts.formatDiagnostic(e, formatHost(root)))
      .join("\n");
    return { success: false, error: msg, diagnostics: [] };
  }

  if (parsed.fileNames.length === 0) {
    return {
      success: true,
      diagnostics: [],
    };
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    configFileParsingDiagnostics: parsed.errors,
  });

  const semantic = ts.getPreEmitDiagnostics(program);
  const diagnostics: TypecheckDiagnostic[] = [];

  for (const d of semantic) {
    const row = diagnosticToRow(d, root);
    if (row) {
      diagnostics.push(row);
    }
  }

  const hasError = diagnostics.some((x) => x.category === "error");
  return {
    success: !hasError,
    diagnostics,
  };
}
