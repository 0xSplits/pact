import test from "node:test";
import assert from "node:assert/strict";
import {
  OG_PAGES,
  OG_SITE_ORIGIN,
  ogOriginForDeployment,
  ogPageForPath,
} from "./og.ts";

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
    OG_SITE_ORIGIN,
  );
  assert.equal(ogOriginForDeployment({}), OG_SITE_ORIGIN);
});

test("every OG page has a unique route and shares the document image", () => {
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
  assert.deepEqual(
    new Set(OG_PAGES.map((page) => page.description)),
    new Set(["Raise a friends & family round without the paperwork."]),
  );
});

test("HTML and clean URLs resolve to the same OG configuration", () => {
  assert.equal(ogPageForPath("/index.html")?.path, "/");
  assert.equal(ogPageForPath("/buy.html")?.title, "PACT: Allocation details");
});
