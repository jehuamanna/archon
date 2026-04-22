/**
 * JS notebook cells run as `new Function` with `globalThis` / `window` shadowed
 * by this proxy. Blocked names and methods cover typical DOM / CSSOM / UI event surfaces.
 *
 * This is not a hard sandbox: bundled code (e.g. @observablehq/stdlib) may still close over
 * the real `globalThis` and use `document` internally.
 */

const MSG =
  "Notebook cells cannot use DOM / layout browser APIs on globalThis or window; use @observablehq/stdlib (html, svg, md, width, Plot, …) for output, or archon for app integration.";

/** Exact global names to block (constructors, roots, collections, …). */
const DOM_GLOBAL_NAMES = new Set([
  "document",
  "Document",
  "Element",
  "HTMLElement",
  "SVGElement",
  "AbstractRange",
  "StaticRange",
  "Range",
  "Node",
  "Text",
  "Comment",
  "CDATASection",
  "DocumentFragment",
  "ShadowRoot",
  "DocumentType",
  "Attr",
  "CharacterData",
  "ProcessingInstruction",
  "HTMLDocument",
  "XMLDocument",
  "DOMImplementation",
  "NodeList",
  "HTMLCollection",
  "NamedNodeMap",
  "DOMTokenList",
  "DOMStringMap",
  "MutationObserver",
  "MutationRecord",
  "ResizeObserver",
  "ResizeObserverEntry",
  "IntersectionObserver",
  "IntersectionObserverEntry",
  "DOMParser",
  "XMLSerializer",
  "TreeWalker",
  "NodeIterator",
  "NodeFilter",
  "XPathResult",
  "XPathExpression",
  "XPathEvaluator",
  "getSelection",
  "customElements",
  "CSSStyleSheet",
  "StyleSheet",
  "MediaList",
  "CSSRule",
  "CSSStyleRule",
  "CSSImportRule",
  "CSSMediaRule",
  "CSSSupportsRule",
  "CSSLayerStatementRule",
  "CSSLayerBlockRule",
  "StyleSheetList",
  "EventTarget",
  "Event",
  "CustomEvent",
  "UIEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "WheelEvent",
  "InputEvent",
  "PointerEvent",
  "Touch",
  "TouchList",
  "TouchEvent",
  "AnimationEvent",
  "TransitionEvent",
  "SubmitEvent",
  "CompositionEvent",
  "DragEvent",
  "ClipboardEvent",
  "BeforeUnloadEvent",
  "HashChangeEvent",
  "PageTransitionEvent",
  "PopStateEvent",
  "StorageEvent",
  "MediaQueryList",
  "MediaQueryListEvent",
  "CaretPosition",
  "visualViewport",
  "screen",
  "innerWidth",
  "innerHeight",
  "outerWidth",
  "outerHeight",
  "screenX",
  "screenY",
  "screenLeft",
  "screenTop",
  "pageXOffset",
  "pageYOffset",
  "scrollX",
  "scrollY",
  "scrollbars",
  "toolbar",
  "statusbar",
  "menubar",
  "personalbar",
  "locationbar",
  "frameElement",
  "frames",
  "length",
  "parent",
  "top",
  "opener",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "CSS",
  "StylePropertyMap",
  "ComputedStyleMap",
]);

/** `window.*` methods that tie into DOM, layout, or chrome. */
const DOM_WINDOW_METHODS = new Set([
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "getComputedStyle",
  "matchMedia",
  "scroll",
  "scrollTo",
  "scrollBy",
  "open",
  "close",
  "stop",
  "blur",
  "focus",
  "moveTo",
  "moveBy",
  "resizeTo",
  "resizeBy",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "getScreenDetails",
  "querySelector",
  "querySelectorAll",
  "postMessage",
]);

function isDomGlobalName(name: string): boolean {
  if (DOM_GLOBAL_NAMES.has(name)) return true;
  if (/^HTML[A-Za-z0-9]*Element$/.test(name)) return true;
  if (/^SVG[A-Za-z0-9]*Element$/.test(name)) return true;
  if (/^MathMLElement$/.test(name)) return true;
  if (/^WebKitCSSMatrix$/.test(name)) return true;
  if (/^DOMRect(ReadOnly)?$/.test(name)) return true;
  if (/^DOMPoint(ReadOnly)?$/.test(name)) return true;
  if (/^DOMQuad$/.test(name)) return true;
  if (/^DOMMatrix(ReadOnly)?$/.test(name)) return true;
  return false;
}

function blockedMethodProxy(): () => never {
  const block = (): never => {
    throw new ReferenceError(MSG);
  };
  return new Proxy(block, {
    apply: () => block(),
    construct: () => block(),
  }) as unknown as () => never;
}

export function createNotebookCellGlobalThisProxy(): typeof globalThis {
  const target = globalThis;
  const methodPoison = blockedMethodProxy();

  const handler: ProxyHandler<typeof globalThis> = {
    get(t, prop, receiver) {
      if (typeof prop === "string") {
        if (prop === "window" || prop === "self") {
          return receiver;
        }
        if (isDomGlobalName(prop)) {
          throw new ReferenceError(MSG);
        }
        if (DOM_WINDOW_METHODS.has(prop)) {
          return methodPoison;
        }
      }
      return Reflect.get(t, prop, receiver);
    },
    set(t, prop, value, receiver) {
      if (typeof prop === "string" && isDomGlobalName(prop)) {
        throw new ReferenceError(MSG);
      }
      return Reflect.set(t, prop, value, receiver);
    },
    defineProperty(t, prop, desc) {
      if (typeof prop === "string" && isDomGlobalName(prop)) {
        throw new ReferenceError(MSG);
      }
      return Reflect.defineProperty(t, prop, desc);
    },
    deleteProperty(t, prop) {
      if (typeof prop === "string" && isDomGlobalName(prop)) {
        throw new ReferenceError(MSG);
      }
      return Reflect.deleteProperty(t, prop);
    },
    has(t, prop) {
      if (typeof prop === "string") {
        if (prop === "window" || prop === "self") {
          return true;
        }
        if (isDomGlobalName(prop)) {
          return false;
        }
      }
      return Reflect.has(t, prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      if (typeof prop === "string" && isDomGlobalName(prop)) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    ownKeys(t) {
      return Reflect.ownKeys(t).filter(
        (k) => typeof k !== "string" || !isDomGlobalName(k),
      );
    },
  };

  return new Proxy(target, handler) as typeof globalThis;
}
