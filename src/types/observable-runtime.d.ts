declare module "@observablehq/runtime" {
  export class Runtime {
    constructor(builtins?: unknown, globalFn?: unknown);
    module(): {
      variable: (observer?: unknown) => {
        define: (
          name: string,
          inputs: string[],
          definition: (...args: unknown[]) => unknown,
        ) => unknown;
      };
    };
    dispose(): void;
  }
}
