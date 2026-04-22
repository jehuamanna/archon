#!/usr/bin/env node
/**
 * Electron Forge + webpack externals: the packaged app only includes `.webpack/` by default.
 * Main-process `require("esbuild")`, `rollup`, etc. need matching trees under `node_modules/`.
 * Copies each package from the project `node_modules` plus nested `node_modules/*` (npm may
 * hoist deps so nested packages still need top-level copies).
 */
const fs = require("fs");
const path = require("path");

const fromRoot = path.resolve(__dirname, "..");

/** Matches webpack.main.config.js externals. */
const SEEDS = [
  "esbuild",
  "rollup",
  "rollup-plugin-esbuild",
  "@rollup/plugin-commonjs",
  "@rollup/plugin-node-resolve",
  "@rollup/plugin-replace",
  "adm-zip",
];

function enqueueNestedModules(srcDir, queue) {
  const nested = path.join(srcDir, "node_modules");
  if (!fs.existsSync(nested)) {
    return;
  }
  for (const entry of fs.readdirSync(nested, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith("@")) {
      const scopePath = path.join(nested, entry.name);
      for (const sub of fs.readdirSync(scopePath, { withFileTypes: true })) {
        if (sub.isDirectory() && !sub.name.startsWith(".")) {
          const fullName = `${entry.name}/${sub.name}`;
          queue.push(fullName);
          enqueueDepsFromPackageJson(
            path.join(scopePath, sub.name, "package.json"),
            queue,
          );
        }
      }
    } else {
      queue.push(entry.name);
      enqueueDepsFromPackageJson(
        path.join(nested, entry.name, "package.json"),
        queue,
      );
    }
  }
}

function enqueueDepsFromPackageJson(pkgJsonPath, queue) {
  if (!fs.existsSync(pkgJsonPath)) {
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  } catch {
    return;
  }
  const all = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  };
  for (const dep of Object.keys(all || {})) {
    queue.push(dep);
  }
}

function copyOne(name, toRoot) {
  const src = path.join(fromRoot, "node_modules", ...name.split("/"));
  if (!fs.existsSync(src)) {
    return false;
  }
  const dest = path.join(toRoot, "node_modules", ...name.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

function copyPackagerMainExternals(buildPathArg) {
  const root = path.resolve(buildPathArg);
  const visited = new Set();
  const queue = [...SEEDS];

  while (queue.length > 0) {
    const name = queue.shift();
    if (visited.has(name)) {
      continue;
    }
    visited.add(name);
    if (!copyOne(name, root)) {
      continue;
    }
    const src = path.join(fromRoot, "node_modules", ...name.split("/"));
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
    } catch {
      enqueueNestedModules(src, queue);
      continue;
    }
    const all = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    };
    for (const dep of Object.keys(all || {})) {
      queue.push(dep);
    }
    enqueueNestedModules(src, queue);
  }

  console.log(
    `copy-packager-main-externals: copied ${visited.size} package(s) → ${path.join(root, "node_modules")}`,
  );
}

module.exports = { copyPackagerMainExternals };

if (require.main === module) {
  const buildPath = process.argv[2];
  if (!buildPath) {
    console.error("usage: copy-packager-main-externals.js <buildPath>");
    process.exit(1);
  }
  copyPackagerMainExternals(buildPath);
}
