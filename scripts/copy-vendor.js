// Copies browser bundles the popover webview loads into media/vendor.
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const out = path.join(root, "media", "vendor");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, "node_modules/markdown-it/dist/markdown-it.min.js"), path.join(out, "markdown-it.min.js"));
