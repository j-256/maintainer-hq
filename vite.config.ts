import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import {
  readReleaseProfile,
  releaseOverrides,
} from "./scripts/release-profile.ts";

export default defineConfig(async ({ command, mode }) => {
  const release = mode === "release";
  const e2eState = mode === "e2e" ? process.env.HQ_E2E_STATE : undefined;
  if (release && command !== "build")
    throw new Error("Use the packaged Worker for isolated release previews");
  const reviewed = release
    ? await readReleaseProfile(process.env.HQ_RELEASE_PROFILE ?? "")
    : null;
  if (reviewed && reviewed.fingerprint !== process.env.HQ_RELEASE_REVIEW)
    throw new Error(
      "Review the exact deployment profile before building a release artifact",
    );
  return {
    cacheDir:
      mode === "e2e"
        ? e2eState
          ? resolve(e2eState, "vite-cache")
          : "node_modules/.vite-e2e"
        : command === "serve"
          ? "node_modules/.vite-development"
          : "node_modules/.vite-production",
    plugins: [
      react(),
      tailwindcss(),
      cloudflare({
        remoteBindings: false,
        ...(e2eState ? { persistState: { path: e2eState } } : {}),
        ...(reviewed
          ? {
              config(config) {
                Object.assign(config, releaseOverrides(reviewed.profile));
              },
            }
          : {}),
        configPath:
          command === "serve"
            ? mode === "e2e"
              ? "./wrangler.e2e.jsonc"
              : "./wrangler.dev.jsonc"
            : "./wrangler.jsonc",
      }),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: { host: "127.0.0.1", port: 5178, strictPort: true },
  };
});
