declare module "@observablehq/stdlib" {
  export class Library {
    constructor(resolver?: unknown);
    [key: string]: unknown;
  }
}
