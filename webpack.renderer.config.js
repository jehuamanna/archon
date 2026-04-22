/** @deprecated Legacy full renderer bundle — Forge now uses `webpack.renderer.stub.config.js`; UI lives in `apps/archon-web`. Kept for reference. */
const MonacoWebpackPlugin = require("monaco-editor-webpack-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const path = require("path");
const baseRules = require("./webpack.rules");

const cacheDir = path.join(__dirname, ".webpack-cache");

// Filter out asset-relocator-loader for renderer process
// It injects __dirname which doesn't exist in browser context
const rules = baseRules.filter((rule) => {
  const loaderName = rule.use?.loader || "";
  return !loaderName.includes("asset-relocator");
});

rules.push({
  test: /\.(css|archoncss)$/i,
  oneOf: [
    {
      resourceQuery: /raw/,
      type: "asset/source",
    },
    {
      use: [
        { loader: "style-loader" },
        { loader: "css-loader" },
        { loader: "postcss-loader" },
      ],
    },
  ],
});

rules.push({
  test: /\.ttf$/,
  type: "asset/resource",
});

module.exports = {
  cache: {
    type: "filesystem",
    cacheDirectory: cacheDir,
  },
  module: {
    rules: [
      {
        test: /\.mjs$/,
        include: /node_modules[/\\]pdfjs-dist[/\\]/,
        type: "javascript/auto",
        resolve: { fullySpecified: false },
      },
      ...rules,
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: path.join(
            path.dirname(require.resolve("pdfjs-dist/package.json")),
            "build",
            "pdf.worker.min.mjs",
          ),
          /** Same folder as `main_window/index.html` (Forge `[name]/index.html`). */
          to: "main_window/pdf.worker.min.mjs",
          /** Rebuilds can reuse `.webpack/`; overwrite instead of failing with "dest already exists". */
          force: true,
        },
      ],
    }),
    new MonacoWebpackPlugin({
      languages: [
        "javascript",
        "typescript",
        "json",
        "html",
        "css",
        "markdown",
      ],
      filename: "[name].worker.js",
      /** Pin to the same copy npm installs (bundled into the app, no CDN). */
      monacoEditorPath: path.dirname(
        require.resolve("monaco-editor/package.json"),
      ),
    }),
  ],
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css"],
    // Webpack/ts-loader often picks the CJS `min/vs` build; monaco-editor-webpack-plugin only wraps the ESM editor.main.
    alias: {
      "monaco-editor": require.resolve(
        "monaco-editor/esm/vs/editor/editor.main.js",
      ),
    },
  },
  devServer: {
    port: 3001,
    client: {
      overlay: false,
    },
  },
  node: {
    __dirname: false,
    __filename: false,
  },
};
