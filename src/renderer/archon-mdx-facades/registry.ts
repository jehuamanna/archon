/**
 * Virtual `@archon/*` modules for MDX: implementations live in-app; imports are stripped at compile time
 * and JSX resolves via {@link getArchonMdxFacadeComponentMap}.
 */
export const ARCHON_MDX_FACADE_IMPORTS = ["@archon/ui", "@archon/date"] as const;

export type ArchonMdxFacadeId = (typeof ARCHON_MDX_FACADE_IMPORTS)[number];
