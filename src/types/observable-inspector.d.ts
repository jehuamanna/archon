declare module "@observablehq/inspector" {
  export class Inspector {
    constructor(node: Element);
    pending(): void;
    fulfilled(value: unknown, name?: string): void;
    rejected(error: unknown, name?: string): void;
    static into(container: Element | string): () => Inspector;
  }
}
