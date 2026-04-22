import type { ShowToastOptions } from "./ToastContext";

type ToastCallback = (opts: ShowToastOptions) => void;

let globalToastCallback: ToastCallback | null = null;

export function registerGlobalToast(callback: ToastCallback): void {
  globalToastCallback = callback;
}

export function unregisterGlobalToast(): void {
  globalToastCallback = null;
}

export function showGlobalToast(opts: ShowToastOptions): void {
  if (globalToastCallback) {
    globalToastCallback(opts);
  }
}
