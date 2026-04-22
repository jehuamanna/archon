const path = require("path");

const rules = require("./webpack.rules").filter((rule) => {
  const loaderName = rule.use?.loader || "";
  return !loaderName.includes("asset-relocator");
});

rules.push({
  test: /\.css$/i,
  use: [{ loader: "style-loader" }, { loader: "css-loader" }],
});

module.exports = {
  cache: {
    type: "filesystem",
    cacheDirectory: path.join(__dirname, ".webpack-cache", "renderer-stub"),
  },
  module: { rules },
  resolve: {
    extensions: [".js", ".ts", ".tsx", ".jsx", ".json"],
    alias: {
      "@archon/ui-types": path.resolve(
        __dirname,
        "src/shared/archon-preload-public-types.ts",
      ),
      "@archon/platform": path.resolve(
        __dirname,
        "packages/archon-platform/src/index.ts",
      ),
    },
  },
  plugins: [],
};
