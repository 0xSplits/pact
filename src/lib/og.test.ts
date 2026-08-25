import assert from "node:assert/strict";

import { test } from "vitest";

import {
  OG_PAGES,
  ogOriginForDeployment,
  ogPageForPath,
  SITE_ORIGIN,
} from "#lib/og.ts";

test("Vercel previews use their deployment origin", () => {
  assert.equal(
    ogOriginForDeployment({
      vercelEnvironment: "preview",
      vercelUrl: "pact-feature.vercel.app",
    }),
    "https://pact-feature.vercel.app",
  );
  assert.equal(
    ogOriginForDeployment({
      vercelEnvironment: "production",
      vercelUrl: "pact-generated.vercel.app",
    }),
    SITE_ORIGIN,
  );
  assert.equal(ogOriginForDeployment({}), SITE_ORIGIN);
});

test("every OG page has a unique route and description and shares the document image", () => {
  assert.equal(
    new Set(OG_PAGES.map((page) => page.path)).size,
    OG_PAGES.length,
  );
  assert.deepEqual(
    new Set(OG_PAGES.map((page) => page.image)),
    new Set(["/og/pact.png"]),
  );
  assert.equal(
    new Set(OG_PAGES.map((page) => page.title)).size,
    OG_PAGES.length,
  );
  assert.equal(
    new Set(OG_PAGES.map((page) => page.description)).size,
    OG_PAGES.length,
  );
});

test("HTML and clean URLs resolve to the same OG configuration", () => {
  assert.equal(ogPageForPath("/index.html")?.path, "/");
  assert.equal(ogPageForPath("/buy.html")?.title, "PACT: Allocation details");
});
