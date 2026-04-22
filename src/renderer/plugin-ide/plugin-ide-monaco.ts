import type { BeforeMount } from "@monaco-editor/react";
import { typescript as monacoTypescript } from "monaco-editor";
import { ARCHON_PLUGIN_UI_MONACO_URI } from "../../shared/archon-plugin-ui-monaco-uri";

export const monacoBeforeMount: BeforeMount = () => {
  const ts = monacoTypescript;
  const compilerOptions = {
    allowJs: true,
    strict: false,
    jsx: ts.JsxEmit.React,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    paths: {
      "@archon/plugin-ui": [ARCHON_PLUGIN_UI_MONACO_URI],
    },
  };
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
};
