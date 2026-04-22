const path = require("path");
const fs = require("fs");

/**
 * Dev-server CSP header (Electron Forge webpack plugin default omits media-src / archon-asset).
 * Without this, that header is AND‑merged with the page meta and blocks archon-asset in plugin
 * srcdoc (e.g. audio/video in sandboxed notes). Keep script-src compatible with eval source maps.
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline' data:",
  "script-src-elem 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: archon-asset:",
  "media-src 'self' data: blob: archon-asset:",
  "font-src 'self' data:",
  "connect-src 'self' archon-pdf-worker: ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:* https://archon.studio wss://archon.studio blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' archon-asset: blob: data: about: https://observablehq.com https://*.observablehq.com",
  "object-src 'self' archon-asset: blob: data:",
].join("; ");

const { copyPackagerMainExternals } = require("./scripts/copy-packager-main-externals");
const { copyArchonWebUi } = require("./scripts/copy-archon-web-ui-to-packaged-app");
const { execSync } = require("child_process");

module.exports = {
  /** Forge staging: packaged apps + `make/` maker outputs. Final installers are copied to `dist/` via `npm run collect:dist`. */
  outDir: "out",
  packagerConfig: {
    asar: true,
    /**
     * Webpack marks `esbuild` external; its binary must not run from inside asar.
     * Rollup optional native addons live under `@rollup/*`.
     */
    asarUnpack: [
      "**/node_modules/esbuild/**",
      "**/node_modules/@esbuild/**",
      "**/node_modules/@rollup/**",
    ],
    /** Shown in menus / .desktop; package id for installers. */
    name: "archon",
    executableName: "archon",
    productName: "Archon",
    /** Basenames become `Resources/<folderName>` — see `resolveBundledReadonlyPluginRoots` in main-helpers. */
    extraResource: [
      path.resolve(__dirname, "plugins/system"),
      path.resolve(__dirname, "plugins/user"),
    ].filter((p) => fs.existsSync(p)),
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {},
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: "Archon",
      },
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: "archon",
          productName: "Archon",
          /** Path to the Electron binary inside the packaged app (defaults to package.json name). */
          bin: "archon",
          maintainer: "Archon <archon@archon.local>",
          genericName: "Knowledge workspace",
        },
      },
    },
    {
      name: "@forkprince/electron-forge-maker-appimage",
      platforms: ["linux"],
      config: {
        productName: "Archon",
      },
    },
  ],
  hooks: {
    /** Build the shared Next.js UI (static export) before the packager copies the app tree. */
    prePackage: async () => {
      const buildEnv = { ...process.env };
      if (!buildEnv.NEXT_PUBLIC_ARCHON_SYNC_API_URL) {
        buildEnv.NEXT_PUBLIC_ARCHON_SYNC_API_URL = "https://archon.studio/api/v1";
      }
      execSync("npm run build:web:static", {
        stdio: "inherit",
        cwd: path.resolve(__dirname),
        env: buildEnv,
      });
    },
    /** After webpack plugin copies `.webpack`; populate `node_modules` for main externals + web UI. */
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      copyPackagerMainExternals(buildPath);
      copyArchonWebUi(buildPath);
    },
  },
  plugins: [
    {
      name: "@electron-forge/plugin-webpack",
      config: {
        mainConfig: "./webpack.main.config.js",
        port: 3001,
        loggerPort: 9001,
        devContentSecurityPolicy: DEV_CSP,
        renderer: {
          config: "./webpack.renderer.stub.config.js",
          entryPoints: [
            {
              html: "./src/electron-renderer-stub/index.html",
              js: "./src/electron-renderer-stub/index.tsx",
              name: "main_window",
              preload: {
                js: "./src/preload.ts",
              },
            },
          ],
        },
      },
    },
  ],
};
