function activate(context, api) {
  if (typeof api.getUiBootstrap !== "function") {
    throw new Error(
      "[code] Manifest must declare ui (hybrid plugin) for this loader.",
    );
  }

  const disposable = api.registerNoteRenderer("code", {
    render: async (note) => {
      const ui = await api.getUiBootstrap();
      return `
        window.__ARCHON_NOTE__ = ${JSON.stringify(note)};
        ${ui}
      `;
    },
  });

  context.subscriptions.push(disposable);
  console.log("[Plugin: code] Activated (Monaco, bundled core)");
}

function deactivate() {
  console.log("[Plugin: code] Deactivated");
}

module.exports = { activate, deactivate };
