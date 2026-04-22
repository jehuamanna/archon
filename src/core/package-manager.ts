import * as fs from "fs";
import * as path from "path";
import { PluginManifest } from "./plugin-loader";
import { manifestValidator } from "./manifest-validator";

const AdmZip = require("adm-zip");

export interface PackageOptions {
  pluginPath: string;
  outputPath: string;
  mode: "development" | "production";
}

export interface PackageInfo {
  name: string;
  version: string;
  mode: "development" | "production";
  size: number;
  files: string[];
}

export class PackageManager {
  /**
   * Create a development mode package (.archonplugin-dev)
   * Includes source files and package.json, excludes node_modules
   */
  async createDevPackage(options: PackageOptions): Promise<string> {
    const { pluginPath, outputPath } = options;

    // Read manifest
    const manifestPath = path.join(pluginPath, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error("manifest.json not found");
    }

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    );

    // Ensure mode is development
    if (manifest.mode !== "development") {
      throw new Error(
        "Plugin manifest must have mode: 'development' for dev packages",
      );
    }

    const pkgOnDisk = path.join(pluginPath, "package.json");
    const hasPkgOnDisk = fs.existsSync(pkgOnDisk);
    let generatedPkgJson: string | null = null;
    if (
      !hasPkgOnDisk &&
      manifest.dependencies &&
      Object.keys(manifest.dependencies).length > 0
    ) {
      generatedPkgJson = JSON.stringify(
        {
          name: `@archon-plugin/${manifest.name}`,
          version: manifest.version,
          private: true,
          dependencies: { ...manifest.dependencies },
        },
        null,
        2,
      );
    }

    // Create zip file
    const zip = new AdmZip();
    const outputFile = path.join(
      outputPath,
      `${manifest.name}-${manifest.version}.archonplugin-dev`,
    );

    // Add files to zip
    const filesToInclude = this.getDevPackageFiles(pluginPath);

    for (const file of filesToInclude) {
      const fullPath = path.join(pluginPath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isFile()) {
        zip.addLocalFile(fullPath, path.dirname(file));
      }
    }

    if (generatedPkgJson) {
      zip.addFile("package.json", Buffer.from(generatedPkgJson, "utf8"));
    }

    // Write zip file
    zip.writeZip(outputFile);

    console.log(
      `[PackageManager] Created dev package: ${path.basename(outputFile)}`,
    );
    console.log(`[PackageManager] Files included: ${filesToInclude.length}`);

    return outputFile;
  }

  /**
   * Create a production mode package (.archonplugin)
   * Includes compiled bundles, excludes source files
   */
  async createProductionPackage(options: PackageOptions): Promise<string> {
    const { pluginPath, outputPath } = options;

    // Read manifest
    const manifestPath = path.join(pluginPath, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error("manifest.json not found");
    }

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    );

    // Ensure mode is production
    if (manifest.mode !== "production") {
      throw new Error(
        "Plugin manifest must have mode: 'production' for production packages",
      );
    }

    // Create zip file
    const zip = new AdmZip();
    const outputFile = path.join(
      outputPath,
      `${manifest.name}-${manifest.version}.archonplugin`,
    );

    // Add files to zip
    const filesToInclude = this.getProductionPackageFiles(pluginPath);

    for (const file of filesToInclude) {
      const fullPath = path.join(pluginPath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isFile()) {
        zip.addLocalFile(fullPath, path.dirname(file));
      }
    }

    // Write zip file
    zip.writeZip(outputFile);

    console.log(
      `[PackageManager] Created production package: ${path.basename(outputFile)}`,
    );
    console.log(`[PackageManager] Files included: ${filesToInclude.length}`);

    return outputFile;
  }

  /**
   * Extract a plugin package (dev or production) to a directory
   */
  async extractPackage(
    packagePath: string,
    targetDir: string,
  ): Promise<PackageInfo> {
    if (!fs.existsSync(packagePath)) {
      throw new Error(`Package not found: ${packagePath}`);
    }

    // Determine package mode from extension
    const ext = path.extname(packagePath).toLowerCase();
    const mode =
      ext === ".archonplugin-dev"
        ? "development"
        : ext === ".archonplugin"
          ? "production"
          : null;

    if (!mode) {
      throw new Error(
        "Invalid package extension. Must be .archonplugin or .archonplugin-dev",
      );
    }

    // Extract zip
    const zip = new AdmZip(packagePath);
    zip.extractAllTo(targetDir, true);

    // Read manifest
    const manifestPath = path.join(targetDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error("Package does not contain manifest.json");
    }

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    );

    // Verify mode matches
    if (manifest.mode !== mode) {
      console.warn(
        `[PackageManager] Package extension (${ext}) doesn't match manifest mode (${manifest.mode})`,
      );
    }

    // Get package info
    const entries = zip.getEntries();
    const files = entries.map((e: { entryName: string }) => e.entryName);
    const size = fs.statSync(packagePath).size;

    console.log(`[PackageManager] Extracted ${mode} package: ${manifest.name}`);

    return {
      name: manifest.name,
      version: manifest.version,
      mode: manifest.mode,
      size,
      files,
    };
  }

  /**
   * Get list of files to include in development package
   */
  private getDevPackageFiles(pluginPath: string): string[] {
    const files: string[] = [];
    const excludePatterns = [
      /node_modules/,
      /\.git/,
      /\.DS_Store/,
      /\.bundle\.js$/,
      /dist\//,
      /build\//,
    ];

    const scanDir = (dir: string, baseDir: string = "") => {
      const items = fs.readdirSync(dir);

      for (const item of items) {
        const fullPath = path.join(dir, item);
        const relativePath = path.join(baseDir, item);

        // Check if should exclude
        if (excludePatterns.some((pattern) => pattern.test(relativePath))) {
          continue;
        }

        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          scanDir(fullPath, relativePath);
        } else {
          files.push(relativePath);
        }
      }
    };

    scanDir(pluginPath);
    return files;
  }

  /**
   * Get list of files to include in production package
   */
  private getProductionPackageFiles(pluginPath: string): string[] {
    const files: string[] = [];
    const includePatterns = [
      /manifest\.json$/,
      /\.bundle\.js$/,
      /\.bundle\.js\.map$/,
      /^dist\/workers\//,
      /\.html$/,
      /\.css$/,
      /\.woff2?$/,
      /\.ttf$/,
      /\.eot$/,
      /\.svg$/,
      /\.png$/,
      /\.jpg$/,
      /\.jpeg$/,
      /\.gif$/,
      /\.ico$/,
      /README\.md$/,
      /LICENSE$/,
    ];

    const scanDir = (dir: string, baseDir: string = "") => {
      const items = fs.readdirSync(dir);

      for (const item of items) {
        const fullPath = path.join(dir, item);
        const relativePath = path.join(baseDir, item);

        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          // Skip node_modules and hidden directories
          if (item === "node_modules" || item.startsWith(".")) {
            continue;
          }
          scanDir(fullPath, relativePath);
        } else {
          // Check if should include
          if (includePatterns.some((pattern) => pattern.test(relativePath))) {
            files.push(relativePath);
          }
        }
      }
    };

    scanDir(pluginPath);
    return files;
  }

  /**
   * Validate a package before extraction
   */
  async validatePackage(packagePath: string): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Check file exists
      if (!fs.existsSync(packagePath)) {
        errors.push("Package file not found");
        return { valid: false, errors, warnings };
      }

      // Check extension
      const ext = path.extname(packagePath).toLowerCase();
      const extOk =
        ext === ".archonplugin" ||
        ext === ".archonplugin-dev" ||
        ext === ".zip";
      if (!extOk) {
        errors.push(
          "Invalid package extension. Use .archonplugin, .archonplugin-dev, or .zip",
        );
      }

      // Try to open zip
      const zip = new AdmZip(packagePath);
      const entries = zip.getEntries();

      // Check for manifest.json
      const hasManifest = entries.some(
        (e: { entryName: string }) => e.entryName === "manifest.json",
      );
      if (!hasManifest) {
        errors.push("Package does not contain manifest.json");
        return { valid: false, errors, warnings };
      }

      const manifestEntry = zip.getEntry("manifest.json");
      const manifestContent = zip.readAsText(manifestEntry);
      const manifest = JSON.parse(manifestContent);

      const vr = manifestValidator.validate(manifest);
      if (!vr.valid) {
        for (const e of vr.errors) {
          errors.push(`[${e.field}] ${e.message}`);
        }
      }
      for (const w of vr.warnings) {
        warnings.push(`[${w.field}] ${w.message}`);
      }

      // Check mode matches extension (.zip treated like dev archive)
      const expectedMode =
        ext === ".archonplugin-dev" ||
        ext === ".zip"
          ? "development"
          : "production";
      if (extOk && manifest.mode !== expectedMode) {
        errors.push(
          `Manifest mode (${manifest.mode}) doesn't match package extension (${ext})`,
        );
      }

      return { valid: errors.length === 0, errors, warnings };
    } catch (error) {
      errors.push(
        `Package validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { valid: false, errors, warnings };
    }
  }

  /**
   * Get package information without extracting
   */
  async getPackageInfo(packagePath: string): Promise<PackageInfo> {
    const zip = new AdmZip(packagePath);
    const manifestEntry = zip.getEntry("manifest.json");

    if (!manifestEntry) {
      throw new Error("Package does not contain manifest.json");
    }

    const manifestContent = zip.readAsText(manifestEntry);
    const manifest: PluginManifest = JSON.parse(manifestContent);

    const entries = zip.getEntries();
    const files = entries.map((e: { entryName: string }) => e.entryName);
    const size = fs.statSync(packagePath).size;

    return {
      name: manifest.name,
      version: manifest.version,
      mode: manifest.mode,
      size,
      files,
    };
  }
}

export const packageManager = new PackageManager();
