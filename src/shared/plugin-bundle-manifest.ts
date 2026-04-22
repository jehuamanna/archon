/**
 * Plugin UI bundle index row (packaged archon-web / marketplace).
 * Align with content-hashed filenames + immutable caching.
 */
export type PluginBundleManifestEntry = {
  pluginId: string;
  version: string;
  /** Hashed entry URL (relative under assetPrefix or absolute). */
  entry: string;
  /** Optional SRI for <script type="module"> loads over HTTPS. */
  integrity?: string;
  /** Host API semver range this bundle targets. */
  engine?: string;
};

export type PluginBundleIndex = {
  generatedAt: string;
  apiVersion: string;
  plugins: PluginBundleManifestEntry[];
};
