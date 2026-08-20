/// <reference types="vitest/config" />
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Connect, Plugin } from "vite";

import { ogOriginForDeployment, ogPageForPath } from "./src/lib/og.ts";

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const localCertificate = page(".tmp/localhost.pem");
const localCertificateKey = page(".tmp/localhost-key.pem");
const localHttps =
  existsSync(localCertificate) && existsSync(localCertificateKey)
    ? {
        cert: readFileSync(localCertificate),
        key: readFileSync(localCertificateKey),
      }
    : undefined;

// Dev/preview-server equivalent of static-host cleanUrls: /create → create.html etc.
const rewriteCleanUrls: Connect.NextHandleFunction = (req, _res, next) => {
  const pathname = new URL(req.url || "/", "http://pact.local").pathname;
  const target = (
    {
      "/create": "/create.html",
      "/status": "/status.html",
      "/buy": "/buy.html",
      "/terms": "/terms.html",
    } as Record<string, string>
  )[pathname];
  if (target && req.url)
    req.url =
      target +
      (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  next();
};
const cleanRoutes: Plugin = {
  name: "pact-clean-routes",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use(rewriteCleanUrls);
  },
  configurePreviewServer(server) {
    server.middlewares.use(rewriteCleanUrls);
  },
};

const openGraphMetadata: Plugin = {
  name: "pact-open-graph-metadata",
  transformIndexHtml: {
    order: "pre",
    handler(html, context) {
      const siteOrigin = ogOriginForDeployment({
        vercelEnvironment:
          process.env.VERCEL_ENV || process.env.VITE_VERCEL_ENV,
        vercelUrl: process.env.VERCEL_URL || process.env.VITE_VERCEL_URL,
      });
      const pageConfig = ogPageForPath(
        new URL(context.path, siteOrigin).pathname,
      );
      if (!pageConfig) return [];
      const image = new URL(pageConfig.image, siteOrigin).href;
      const url = new URL(pageConfig.path, siteOrigin).href;
      const property = (name: string, content: string) => ({
        tag: "meta",
        attrs: { property: name, content },
        injectTo: "head" as const,
      });
      const named = (name: string, content: string) => ({
        tag: "meta",
        attrs: { name, content },
        injectTo: "head" as const,
      });
      return {
        html: html.replace(
          /<title>[\s\S]*?<\/title>/i,
          `<title>${pageConfig.title}</title>`,
        ),
        tags: [
          named("description", pageConfig.description),
          property("og:type", "website"),
          property("og:site_name", "PACT"),
          property("og:title", pageConfig.title),
          property("og:description", pageConfig.description),
          property("og:url", url),
          property("og:image", image),
          property("og:image:width", "1200"),
          property("og:image:height", "630"),
          named("twitter:card", "summary_large_image"),
          named("twitter:title", pageConfig.title),
          named("twitter:description", pageConfig.description),
          named("twitter:image", image),
        ],
      };
    },
  },
};

export default defineConfig(({ isPreview }) => ({
  appType: "mpa",
  plugins: [react(), tailwindcss(), cleanRoutes, openGraphMetadata],
  server: !isPreview && localHttps ? { https: localHttps } : {},
  // Playwright owns tests/*.spec.ts; vitest only runs the colocated unit tests.
  test: { include: ["src/**/*.test.ts"] },
  // Playwright targets a stable HTTP preview URL. A developer's trusted
  // localhost certificate must not silently change the E2E server protocol.
  build: {
    rollupOptions: {
      input: {
        index: page("index.html"),
        create: page("create.html"),
        status: page("status.html"),
        buy: page("buy.html"),
        terms: page("terms.html"),
      },
    },
  },
}));
