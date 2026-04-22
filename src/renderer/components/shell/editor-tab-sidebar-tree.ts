/** Matches `listPluginSourceFiles` placeholder when `node_modules` exists. */
export const NODE_MODULES_LIST_MARKER = "node_modules/";

export type FileTreeNode = {
  name: string;
  path: string | null;
  children: FileTreeNode[];
};

export function isNodeModulesListMarker(rel: string): boolean {
  return rel === NODE_MODULES_LIST_MARKER;
}

export function buildFileTree(paths: string[]): FileTreeNode[] {
  type Acc = {
    seg: string;
    fullPath: string | null;
    children: Map<string, Acc>;
  };
  const root = new Map<string, Acc>();
  for (const p of paths) {
    const norm = p.replace(/\\/g, "/");
    const parts = norm.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    let level = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = i === 0 ? parts[0]! : `${acc}/${parts[i]!}`;
      const isLeaf = i === parts.length - 1;
      let node = level.get(parts[i]!);
      if (!node) {
        node = {
          seg: parts[i]!,
          fullPath: isLeaf ? norm : null,
          children: new Map(),
        };
        level.set(parts[i]!, node);
      } else if (isLeaf) {
        node.fullPath = norm;
      }
      if (!isLeaf) {
        level = node.children;
      }
    }
  }
  const toArr = (m: Map<string, Acc>): FileTreeNode[] =>
    [...m.values()]
      .sort((a, b) => {
        const aDir = a.children.size > 0 || a.fullPath === null;
        const bDir = b.children.size > 0 || b.fullPath === null;
        if (aDir !== bDir) {
          return aDir ? -1 : 1;
        }
        return a.seg.localeCompare(b.seg);
      })
      .map((n) => ({
        name: n.seg,
        path: n.fullPath,
        children: toArr(n.children),
      }));
  return toArr(root);
}

export function pathLooksLikeDir(p: string | null): boolean {
  return p != null && p.endsWith("/");
}

/** Depth-first paths matching on-screen tree order (dirs then nested). */
export function collectTreePaths(
  nodes: FileTreeNode[],
  parentRel: string,
): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const dirRel = parentRel ? `${parentRel}/${n.name}` : n.name;
    const isDir =
      n.children.length > 0 || n.path === null || pathLooksLikeDir(n.path);
    if (isDir && n.children.length > 0) {
      out.push(dirRel);
      out.push(...collectTreePaths(n.children, dirRel));
    } else if (
      isDir &&
      n.children.length === 0 &&
      n.path &&
      pathLooksLikeDir(n.path)
    ) {
      out.push(n.path);
    } else if (!isDir && n.path) {
      out.push(n.path);
    }
  }
  return out;
}

/** Paths from the tree may use a trailing `/` for directories; IPC expects no trailing slash. */
export function fsRelFromTreePath(p: string): string {
  return p.replace(/\/+$/, "");
}
