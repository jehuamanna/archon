import { getArchon } from "../../shared/archon-host-access";
type RpcRequest =
  | {
      type: "eval";
      id: string;
      code: string;
    }
  | {
      type: "rpc";
      id: string;
      method: string;
      args: unknown[];
    };

type RpcResponse =
  | { type: "evalResult"; id: string; ok: true; value: unknown; logs: string[] }
  | { type: "evalResult"; id: string; ok: false; error: string; logs: string[] }
  | { type: "rpcResult"; id: string; ok: true; value: unknown }
  | { type: "rpcResult"; id: string; ok: false; error: string };

let iframe: HTMLIFrameElement | null = null;
let ready = false;
const pending = new Map<string, (resp: RpcResponse) => void>();

function ensureIframe(): HTMLIFrameElement {
  if (typeof document === "undefined") {
    throw new Error("Script host is only available in a browser renderer.");
  }
  if (iframe && ready) {
    return iframe;
  }

  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.position = "fixed";
    iframe.style.left = "-99999px";
    iframe.style.top = "-99999px";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    iframe.title = "Archon Script Sandbox";

    // No allow-same-origin: iframe gets an opaque origin and cannot read parent/window.
    // srcdoc keeps it self-contained.
    iframe.srcdoc = String.raw`<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <script>
      (function () {
        const parentWin = window.parent;

        // Strip a few ambient capabilities. This is not a perfect sandbox,
        // but it prevents accidental access to DOM/window and discourages networking.
        try { delete window.fetch; } catch {}
        try { delete window.XMLHttpRequest; } catch {}
        try { delete window.WebSocket; } catch {}
        try { delete window.localStorage; } catch {}
        try { delete window.sessionStorage; } catch {}

        const send = (msg) => parentWin.postMessage(msg, "*");
        const rpc = (method, args) =>
          new Promise((resolve, reject) => {
            const id = String(Date.now()) + "." + Math.random().toString(16).slice(2);
            const onMsg = (e) => {
              const d = e && e.data;
              if (!d || d.type !== "rpcResult" || d.id !== id) return;
              window.removeEventListener("message", onMsg);
              if (d.ok) resolve(d.value);
              else reject(new Error(d.error || "RPC failed"));
            };
            window.addEventListener("message", onMsg);
            send({ type: "rpc", id, method, args });
          });

        const plugins = {
          listInstalled: () => rpc("plugins.listInstalled", []),
          reloadRegistry: () => rpc("plugins.reloadRegistry", []),
          enable: (pluginId) => rpc("plugins.enable", [pluginId]),
          disable: (pluginId) => rpc("plugins.disable", [pluginId]),
          uninstall: (pluginId) => rpc("plugins.uninstall", [pluginId]),
          installFromMarket: (packageFile) => rpc("plugins.installMarketplace", [packageFile]),
        };

        function captureConsole(logs) {
          const orig = console;
          const wrap = (level) => (...args) => {
            try {
              logs.push(args.map((a) => {
                try { return typeof a === "string" ? a : JSON.stringify(a); }
                catch { return String(a); }
              }).join(" "));
            } catch {}
            try { orig[level].apply(orig, args); } catch {}
          };
          console = {
            ...orig,
            log: wrap("log"),
            info: wrap("info"),
            warn: wrap("warn"),
            error: wrap("error"),
          };
          return () => { console = orig; };
        }

        async function evalCode(code) {
          const logs = [];
          const restore = captureConsole(logs);
          try {
            // Wrap as async fn so await works.
            const body = '"use strict";\nreturn (async () => {\n' + code + '\n})();';
            const fn = new Function("plugins", body);
            const value = await fn(plugins);
            return { ok: true, value, logs };
          } catch (e) {
            return { ok: false, error: e && e.message ? String(e.message) : String(e), logs };
          } finally {
            restore();
          }
        }

        window.addEventListener("message", async (e) => {
          const d = e && e.data;
          if (!d || typeof d.id !== "string") return;
          if (d.type !== "eval" || typeof d.code !== "string") return;
          const out = await evalCode(d.code);
          send({ type: "evalResult", id: d.id, ...out });
        });

        send({ type: "ready" });
      })();
    </script>
  </body>
</html>`;

    document.body.appendChild(iframe);
  }

  const onMessage = async (e: MessageEvent) => {
    const d = e.data as unknown;
    if (!d || typeof d !== "object") return;
    const msg = d as { type?: string; id?: string };
    if (msg.type === "ready") {
      ready = true;
      return;
    }
    if (typeof msg.id === "string") {
      const cb = pending.get(msg.id);
      if (cb) {
        pending.delete(msg.id);
        cb(d as RpcResponse);
      }
    }
    if ((d as { type?: string }).type === "rpc") {
      const req = d as RpcRequest & { type: "rpc" };
      void handleRpc(req);
    }
  };

  window.addEventListener("message", onMessage);
  return iframe;
}

async function handleRpc(req: Extract<RpcRequest, { type: "rpc" }>): Promise<void> {
  const post = (resp: RpcResponse) => {
    iframe?.contentWindow?.postMessage(resp, "*");
  };
  try {
    const api = getArchon();
    if (!api) {
      post({ type: "rpcResult", id: req.id, ok: false, error: "No host API" });
      return;
    }
    switch (req.method) {
      case "plugins.listInstalled": {
        const v = await api.getInstalledPlugins();
        post({ type: "rpcResult", id: req.id, ok: true, value: v });
        return;
      }
      case "plugins.reloadRegistry": {
        const v = await api.reloadPluginRegistry();
        post({ type: "rpcResult", id: req.id, ok: true, value: v });
        return;
      }
      case "plugins.enable": {
        const pluginId = String(req.args?.[0] ?? "").trim();
        const v = await api.setPluginEnabled(pluginId, true);
        post({ type: "rpcResult", id: req.id, ok: true, value: v });
        return;
      }
      case "plugins.disable": {
        const pluginId = String(req.args?.[0] ?? "").trim();
        const v = await api.setPluginEnabled(pluginId, false);
        post({ type: "rpcResult", id: req.id, ok: true, value: v });
        return;
      }
      case "plugins.uninstall": {
        const pluginId = String(req.args?.[0] ?? "").trim();
        const v = await api.uninstallPlugin(pluginId);
        post({ type: "rpcResult", id: req.id, ok: true, value: v });
        return;
      }
      case "plugins.installMarketplace": {
        const packageFile = String(req.args?.[0] ?? "").trim();
        const v = await api.installMarketplacePlugin(packageFile);
        post({ type: "rpcResult", id: req.id, ok: true, value: v });
        return;
      }
      default:
        post({
          type: "rpcResult",
          id: req.id,
          ok: false,
          error: `Unknown method: ${req.method}`,
        });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    iframe?.contentWindow?.postMessage(
      { type: "rpcResult", id: req.id, ok: false, error: msg } satisfies RpcResponse,
      "*",
    );
  }
}

export type EvalResult = { ok: true; value: unknown; logs: string[] } | { ok: false; error: string; logs: string[] };

export async function evalInSandbox(code: string): Promise<EvalResult> {
  const f = ensureIframe();
  const win = f.contentWindow;
  if (!win) {
    throw new Error("Sandbox iframe not ready");
  }
  const id = `${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const p = new Promise<RpcResponse>((resolve) => {
    pending.set(id, resolve);
  });
  win.postMessage({ type: "eval", id, code } satisfies RpcRequest, "*");
  const resp = await p;
  if (resp.type !== "evalResult") {
    throw new Error("Unexpected sandbox response");
  }
  if (resp.ok) return { ok: true, value: resp.value, logs: resp.logs };
  return { ok: false, error: resp.error, logs: resp.logs };
}
