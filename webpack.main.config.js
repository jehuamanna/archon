const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  cache: {
    type: "filesystem",
    cacheDirectory: path.join(__dirname, ".webpack-cache"),
    name: "main",
  },
  target: "electron-main",
  /** Linux: `linux-chromium-tmp-env` must evaluate before `electron` loads (TMPDIR for children). */
  entry: [
    path.resolve(__dirname, "src/main/ensure-safe-cwd.ts"),
    path.resolve(__dirname, "src/main/linux-chromium-tmp-env.ts"),
    path.resolve(__dirname, "src/main.ts"),
  ],
  module: {
    rules: [
      /** Monaco ESM pulls .css; main bundle does not need styles—avoid parse errors. */
      { test: /\.css$/i, type: "asset/source" },
      ...require("./webpack.rules"),
    ],
  },
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css", ".json"],
  },
  externalsPresets: { node: true },
  externals: {
    "adm-zip": "commonjs adm-zip",
    "./zip-handler": "commonjs ./zip-handler",
    // Rollup 4 loads @rollup/rollup-<platform> native addons; bundling breaks that resolution.
    rollup: "commonjs rollup",
    // esbuild spawns a worker with paths relative to its package root; bundling breaks that.
    esbuild: "commonjs esbuild",
    // Bundling these breaks transitive deps (e.g. is-reference) → "isReference is not a function" at bundle time.
    "@rollup/plugin-commonjs": "commonjs @rollup/plugin-commonjs",
    "@rollup/plugin-node-resolve": "commonjs @rollup/plugin-node-resolve",
    "@rollup/plugin-replace": "commonjs @rollup/plugin-replace",
    "rollup-plugin-esbuild": "commonjs rollup-plugin-esbuild",
    // MCP SDK uses ESM-only exports map; externalize so Node.js resolves it at runtime.
    "@modelcontextprotocol/sdk/client/index.js": "commonjs @modelcontextprotocol/sdk/dist/cjs/client/index.js",
    "@modelcontextprotocol/sdk/client/stdio.js": "commonjs @modelcontextprotocol/sdk/dist/cjs/client/stdio.js",
    "@modelcontextprotocol/sdk/client/sse.js": "commonjs @modelcontextprotocol/sdk/dist/cjs/client/sse.js",
    "@modelcontextprotocol/sdk/client/streamableHttp.js": "commonjs @modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js",
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: "src/core/zip-handler.js",
          to: "zip-handler.js",
          /** Rebuilds can reuse `.webpack/`; overwrite instead of failing with "dest already exists". */
          force: true,
        },
      ],
    }),
  ],
  node: {
    __dirname: true,
    __filename: true,
  },
};
