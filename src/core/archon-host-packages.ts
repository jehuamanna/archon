import * as fs from "fs";
import * as path from "path";

const ARCHON_SCOPE = /^@archon\//;

function shouldCopyPath(root: string, absPath: string): boolean {
  const rel = path.relative(root, absPath);
  if (rel.startsWith("..")) {
    return true;
  }
  const parts = rel.split(path.sep);
  return !parts.some((p) => p === "node_modules" || p === ".git");
}

/**
 * Remove a path so we can replace it with a real directory. Broken symlinks
 * make `fs.existsSync` false, but the name still occupies the parent — then
 * `mkdirSync` fails with ENOENT unless we `unlink` the symlink first.
 */
function removePathForCopyDestination(toRoot: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(toRoot);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || st.isFile()) {
    fs.unlinkSync(toRoot);
    return;
  }
  if (st.isDirectory()) {
    fs.rmSync(toRoot, { recursive: true, force: true });
  }
}

function copyPackageTree(fromRoot: string, toRoot: string): void {
  removePathForCopyDestination(toRoot);
  fs.mkdirSync(path.dirname(toRoot), { recursive: true });
  fs.mkdirSync(toRoot, { recursive: true });

  const walk = (fromDir: string, toDir: string): void => {
    for (const ent of fs.readdirSync(fromDir, { withFileTypes: true })) {
      const from = path.join(fromDir, ent.name);
      const to = path.join(toDir, ent.name);
      if (!shouldCopyPath(fromRoot, from)) {
        continue;
      }
      if (ent.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(from, to);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        try {
          fs.copyFileSync(from, to);
        } catch {
          /* skip broken symlinks */
        }
      }
    }
  };
  walk(fromRoot, toRoot);
}

function candidateRepoRoots(): string[] {
  const roots = new Set<string>();
  roots.add(process.cwd());
  if (path.isAbsolute(__dirname)) {
    roots.add(path.resolve(__dirname, "..", ".."));
    roots.add(path.resolve(__dirname, "..", "..", ".."));
  }
  return [...roots];
}

/**
 * Discover `@archon/*` package directories from monorepo `packages/*` and host
 * `node_modules/@archon/*`. Monorepo wins on name collision.
 */
export function discoverArchonScopedPackageDirs(): Map<string, string> {
  const map = new Map<string, string>();

  for (const root of candidateRepoRoots()) {
    const packagesDir = path.join(root, "packages");
    if (!fs.existsSync(packagesDir)) {
      continue;
    }
    for (const ent of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) {
        continue;
      }
      const pkgDir = path.join(packagesDir, ent.name);
      const pj = path.join(pkgDir, "package.json");
      if (!fs.existsSync(pj)) {
        continue;
      }
      try {
        const j = JSON.parse(fs.readFileSync(pj, "utf8")) as { name?: string };
        if (typeof j.name === "string" && ARCHON_SCOPE.test(j.name)) {
          map.set(j.name, path.resolve(pkgDir));
        }
      } catch {
        /* skip */
      }
    }
  }

  for (const root of candidateRepoRoots()) {
    const scopeDir = path.join(root, "node_modules", "@archon");
    if (!fs.existsSync(scopeDir)) {
      continue;
    }
    for (const ent of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) {
        continue;
      }
      const fullName = `@archon/${ent.name}`;
      if (map.has(fullName)) {
        continue;
      }
      const pkgDir = path.join(scopeDir, ent.name);
      const pj = path.join(pkgDir, "package.json");
      if (fs.existsSync(pj)) {
        map.set(fullName, path.resolve(pkgDir));
      }
    }
  }

  return map;
}

/** Copy every discovered `@archon/*` host package into the plugin workspace. */
export function syncHostArchonScopedPackagesIntoWorkspace(
  pluginPath: string,
): void {
  const destScope = path.join(pluginPath, "node_modules", "@archon");
  fs.mkdirSync(destScope, { recursive: true });
  for (const [name, srcRoot] of discoverArchonScopedPackageDirs()) {
    const short = name.replace(/^@archon\//, "");
    if (!short || short.includes("..") || short.includes("/")) {
      continue;
    }
    const dest = path.join(destScope, short);
    copyPackageTree(srcRoot, dest);
  }
}
