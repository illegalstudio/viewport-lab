# Contributing

Viewport Lab is a plain JavaScript Manifest V3 extension. Keep installation free of build steps and production code free of dependencies. npm dependencies are for development only.

## Setup

Use Node.js 24 and run the commands in the [README](README.md#development). Load the repository folder as an unpacked extension for manual testing.

## Changes

- Preserve the real page viewport and the current page state. Do not resize the browser window or embed the site in an iframe.
- Keep dimensions within the native tab space measured at activation.
- Keep the fixed control strip and restore site styles when Viewport Lab closes.
- Write repository documentation in English. The extension UI is currently in Italian.
- Keep the version in `manifest.json`, `package.json` and `package-lock.json` consistent when preparing a release.
- Edit the vector logo in `assets/logo-mark.svg` and run `npm run icons` to update its PNG exports.

Run `npm test` before submitting a change to the extension. Describe the behavior changed and the checks performed in the pull request. For visual changes, include a screenshot of the result.

Keep browser downloads, generated test screenshots, temporary profiles and `node_modules` out of commits.
