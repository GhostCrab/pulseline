// Dev-only lint config, driven by scripts/check.py (which feeds each page's inline
// <script> through stdin). Rules target this repo's real failure class: under
// "use strict", moving or deleting a block orphans identifiers and throws mid-function
// (docs/DEVELOPING.md, Hotspots 2). Style rules are deliberately absent.
import globals from "globals";

export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        Spotify: "readonly",          // Web Playback SDK
        PLAnalysis: "readonly",       // analysis-core.js
        EssentiaWASM: "readonly",     // vendor/essentia-wasm.web.js
        Essentia: "readonly",         // vendor/essentia.js-core.min.js
      },
    },
    rules: {
      "no-undef": "error",
      // builtinGlobals off: calendar.html deliberately uses a top-level `history` for its
      // entries list, which legally shadows window.history in a classic script.
      "no-redeclare": ["error", { builtinGlobals: false }],
      "no-dupe-keys": "error",
      "no-const-assign": "error",
      "no-unreachable": "error",
      "no-func-assign": "error",
    },
  },
];
