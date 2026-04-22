/** postMessage types: legacy sandboxed plugin iframe ↔ host (being phased out). */

export const PLUGIN_IFRAME_ASSET_LIST = "archon_plugin_iframe_asset_list";
export const PLUGIN_IFRAME_ASSET_PICK = "archon_plugin_iframe_asset_pick";
export const PLUGIN_IFRAME_ASSET_RESPONSE = "archon_plugin_iframe_asset_response";

/** Plugin iframe ↔ host: per-PDF bookmarks in host `localStorage`. */
export const PLUGIN_IFRAME_PDF_BOOKMARKS_GET =
  "archon_plugin_iframe_pdf_bookmarks_get";
export const PLUGIN_IFRAME_PDF_BOOKMARKS_SET =
  "archon_plugin_iframe_pdf_bookmarks_set";
export const PLUGIN_IFRAME_PDF_BOOKMARKS_RESPONSE =
  "archon_plugin_iframe_pdf_bookmarks_response";
