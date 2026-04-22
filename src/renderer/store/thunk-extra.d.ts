import type { ArchonPlatformDeps } from "@archon/platform";

declare module "@reduxjs/toolkit" {
  interface AsyncThunkConfig {
    extra: ArchonPlatformDeps;
  }
}

export {};
