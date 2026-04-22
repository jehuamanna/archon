import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// @ts-ignore - Babel standalone doesn't have perfect types
const Babel = require("@babel/standalone");

export interface CompilationResult {
  success: boolean;
  code?: string;
  error?: string;
  sourceMap?: string;
}

export interface CompilationCache {
  [hash: string]: {
    code: string;
    timestamp: number;
  };
}

export class JSXCompiler {
  private cacheDir: string;
  private cache: CompilationCache = {};

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.ensureCacheDir();
    this.loadCache();
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private loadCache(): void {
    const cacheFile = path.join(this.cacheDir, "jsx-cache.json");
    if (fs.existsSync(cacheFile)) {
      try {
        const content = fs.readFileSync(cacheFile, "utf8");
        this.cache = JSON.parse(content);
      } catch (error) {
        console.warn("[JSXCompiler] Failed to load cache:", error);
        this.cache = {};
      }
    }
  }

  private saveCache(): void {
    const cacheFile = path.join(this.cacheDir, "jsx-cache.json");
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      console.error("[JSXCompiler] Failed to save cache:", error);
    }
  }

  private getFileHash(filePath: string): string {
    const content = fs.readFileSync(filePath, "utf8");
    return crypto.createHash("md5").update(content).digest("hex");
  }

  compile(filePath: string): CompilationResult {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      // Check cache
      const fileHash = this.getFileHash(filePath);
      const cached = this.cache[fileHash];
      if (cached) {
        console.log(`[JSXCompiler] Using cached compilation for ${path.basename(filePath)}`);
        return {
          success: true,
          code: cached.code,
        };
      }

      // Read source file
      const source = fs.readFileSync(filePath, "utf8");

      // Compile JSX to JavaScript
      const result = Babel.transform(source, {
        filename: path.basename(filePath),
        presets: [
          ["react", { runtime: "classic" }],
          ["env", { targets: { electron: "41" } }],
        ],
        sourceMaps: false,
        comments: false,
      });

      if (!result || !result.code) {
        return {
          success: false,
          error: "Compilation produced no output",
        };
      }

      // Cache the result
      this.cache[fileHash] = {
        code: result.code,
        timestamp: Date.now(),
      };
      this.saveCache();

      console.log(`[JSXCompiler] Compiled ${path.basename(filePath)} successfully`);

      return {
        success: true,
        code: result.code,
        sourceMap: result.map,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[JSXCompiler] Compilation failed for ${filePath}:`, errorMessage);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  compileString(source: string, filename: string = "inline.jsx"): CompilationResult {
    try {
      const result = Babel.transform(source, {
        filename,
        presets: [
          ["react", { runtime: "classic" }],
          ["env", { targets: { electron: "41" } }],
        ],
        sourceMaps: false,
        comments: false,
      });

      if (!result || !result.code) {
        return {
          success: false,
          error: "Compilation produced no output",
        };
      }

      return {
        success: true,
        code: result.code,
        sourceMap: result.map,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[JSXCompiler] Compilation failed:`, errorMessage);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  clearCache(): void {
    this.cache = {};
    this.saveCache();
    console.log("[JSXCompiler] Cache cleared");
  }

  getCacheStats(): { entries: number; size: number } {
    const entries = Object.keys(this.cache).length;
    const size = JSON.stringify(this.cache).length;
    return { entries, size };
  }
}

let jsxCompilerInstance: JSXCompiler | null = null;

/** Call from main after `app.whenReady` with `getArchonJsxCacheRoot(app.getPath("userData"))`. */
export function initJsxCompilerCache(cacheDir: string): void {
  jsxCompilerInstance = new JSXCompiler(cacheDir);
}

export function getJsxCompiler(): JSXCompiler {
  if (!jsxCompilerInstance) {
    jsxCompilerInstance = new JSXCompiler(
      path.join(os.tmpdir(), "archon-jsx-cache"),
    );
  }
  return jsxCompilerInstance;
}
