/**
 * The app's own version, read from `package.json` at build time. `bun build
 * --compile` bundles the JSON, so every release binary reports the version it
 * was built from — which is what the update checker compares against tags.
 */
import pkg from "../package.json"

/** `0.1.0`, never the `v0.1.0` tag form. Tags gain their `v` at release. */
export const APP_VERSION: string = pkg.version
