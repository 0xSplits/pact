# Repo Structure for `@splits/pact-mcp`

Research notes, 2026-08-19. Question: best repo structure for adding a
publishable stdio MCP server package (`packages/pact-mcp`, npm bin run via
`npx -y @splits/pact-mcp`) to this single-package Vite MPA repo, reusing the
framework-free `src/lib/chain` modules.

Checked 2026-08-19 against: modelcontextprotocol/servers@main,
modelcontextprotocol/typescript-sdk@main (2.0.0-alpha), microsoft/playwright-mcp@main
(0.0.79), upstash/context7@master (4.0.2), ChromeDevTools/chrome-devtools-mcp@main
(1.7.0), getsentry/sentry-mcp@main (0.37.0), registry.npmjs.org latest metadata +
extracted tarballs for `@upstash/context7-mcp` and `@sentry/mcp-server`,
nodejs/node@main source, nodejs.org/api/typescript.html, docs.npmjs.com (v11),
pnpm.io/workspaces, typescriptlang.org TS 5.7 release notes, vercel.com/docs/monorepos,
vite.dev/guide — plus local empirical fixtures run on node v22.20.0 / npm 10.9.3 /
pnpm 10.17.1 (scratchpad `wstest/` and `pnpmtest/`).

## 1. How first-party and popular MCP servers structure/publish npm stdio packages

| Server                                                                                                                            | Layout                                                                                          | Pkg mgr | Build                                                                                                                                                                                                                                     | bin target                                                                 | Module                        | engines                              | Ships                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/server-filesystem` / `server-everything` ([servers repo](https://github.com/modelcontextprotocol/servers)) | npm workspaces `"workspaces": ["src/*"]`, root private with `"files": []` (root `package.json`) | npm     | plain `tsc` emit to `dist/`, then `shx chmod +x dist/*.js` (`src/filesystem/package.json` → `"build": "tsc && shx chmod +x dist/*.js"`, `"prepare": "npm run build"`)                                                                     | `"bin": {"mcp-server-filesystem": "dist/index.js"}`                        | ESM (`"type": "module"`)      | none                                 | `"files": ["dist"]`; deps external (`@modelcontextprotocol/sdk`, `glob`, …)                                                                                          |
| `@modelcontextprotocol/sdk` v2 ([typescript-sdk repo](https://github.com/modelcontextprotocol/typescript-sdk))                    | pnpm workspaces + catalogs (`packageManager: "pnpm@10.26.1"`, root `package.json`)              | pnpm    | **tsdown** per package (`packages/server/package.json` → `"build": "tsdown"`, `"prepack": "pnpm run build"`), dual ESM/CJS `.mjs`/`.cjs` exports                                                                                          | n/a (library)                                                              | dual                          | `">=20"`                             | `"files": ["dist"]`; changesets publish                                                                                                                              |
| `@playwright/mcp` ([playwright-mcp repo](https://github.com/microsoft/playwright-mcp))                                            | single package at repo root                                                                     | npm     | **none** — `"build": "echo OK"`; the published bin is a checked-in plain-JS shim [`cli.js`](https://github.com/microsoft/playwright-mcp/blob/main/cli.js) that `require`s the real implementation out of `playwright-core/lib/coreBundle` | `"bin": {"playwright-mcp": "cli.js"}`                                      | CJS shim                      | `">=18"`                             | `cli.js`, `index.js`, `index.d.ts`; deps = playwright alphas                                                                                                         |
| `@upstash/context7-mcp` ([context7 repo](https://github.com/upstash/context7), `packages/mcp/package.json`)                       | pnpm workspaces `"workspaces": ["packages/*"]`                                                  | pnpm    | plain `tsc` emit: `"build": "tsc && chmod 755 dist/index.js"`                                                                                                                                                                             | `"bin": {"context7-mcp": "dist/index.js"}`                                 | ESM                           | `">=20.18.1"`                        | `"files": ["dist", "LICENSE", "README.md"]` — tarball confirmed: multi-file `dist/` tree, deps external, `dist/index.js` starts with `#!/usr/bin/env node`           |
| `chrome-devtools-mcp` ([repo](https://github.com/ChromeDevTools/chrome-devtools-mcp))                                             | single package at repo root                                                                     | npm     | `tsc` then a **rollup** `bundle` step that vendors deps and deletes `build/node_modules` (license-notice driven — `append-lighthouse-notices.ts`)                                                                                         | `"bin": {"chrome-devtools-mcp": "./build/src/bin/chrome-devtools-mcp.js"}` | ESM                           | `"^20.19.0 \|\| ^22.12.0 \|\| >=23"` | `"files": ["build/src", "LICENSE", "skills", "!*.tsbuildinfo", "!*.js.map"]`                                                                                         |
| `@sentry/mcp-server` ([sentry-mcp repo](https://github.com/getsentry/sentry-mcp), `packages/mcp-server/package.json`)             | pnpm + turbo monorepo `packages/*` (`packageManager: "pnpm@11.8.0"`)                            | pnpm    | **tsdown** (`"build": "tsdown"`); dev via `tsx src/index.ts`                                                                                                                                                                              | `"bin": {"sentry-mcp": "./dist/index.js"}`                                 | ESM (+ cjs chunks in tarball) | `">=22.13"`                          | `"files": ["./dist/*"]` — tarball confirmed: ~160 chunked files, runtime deps (`@modelcontextprotocol/sdk`, zod, `@sentry/node`) kept **external** in `dependencies` |

Registry metadata cross-checked at `https://registry.npmjs.org/<pkg>/latest`
(bin/engines/type/scripts as shown above).

Norms across the survey:

- **ESM only** (`"type": "module"`), bin pointing at a built `dist/index.js`.
- **Shebang lives in the TypeScript source** — `src/filesystem/index.ts` starts
  with `#!/usr/bin/env node` and both tsc and tsdown carry it into `dist`
  (verified in both extracted tarballs). npm's own docs: "Please make sure that
  your file(s) referenced in `bin` starts with `#!/usr/bin/env node`; otherwise,
  the scripts are started without the node executable!"
  ([package.json#bin](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bin)).
  The `chmod +x` in build scripts is only for running `dist/index.js` directly
  from the repo; npm sets the exec bit on `bin` entries at install time.
- **`files: ["dist"]`** (or equivalent) — sources and tests never ship.
- **Runtime deps stay external** in every case except chrome-devtools-mcp,
  whose rollup vendoring exists to concatenate third-party license notices,
  not as a packaging preference.
- Build tool split: plain `tsc` emit (servers monorepo, context7),
  tsdown (typescript-sdk v2, sentry), rollup (chrome-devtools), none (playwright).
- `engines`: everyone declares one except the first-party servers monorepo;
  range tracks the package's own runtime needs (>=18 … >=22.13), not the
  repo's dev toolchain.

## 2. npm vs pnpm workspaces; depending on the root package; symlinks × type stripping

### Can a workspace package depend on the repo-root package?

**npm — yes, via `file:../..`.** The npm docs define workspaces in the root
`package.json` and describe install as "automat[ing] the linking process"
into the root `node_modules`
([npm workspaces docs](https://docs.npmjs.com/cli/v11/using-npm/workspaces));
they don't discuss root-as-dependency, so this was verified empirically
(fixture: root `{"name":"rootapp","workspaces":["packages/*"],"imports":{"#lib/*":"./src/lib/*"}}`,
workspace `packages/mcp` with `"dependencies": {"rootapp": "file:../.."}`):
npm 10.9.3 installs it as a **symlink** — `node_modules/rootapp -> ..` — next
to the workspace symlink `node_modules/mcp -> ../packages/mcp`.

**pnpm — yes, via `workspace:*`.** The workspace root is itself a project in a
pnpm workspace ([pnpm.io/workspaces](https://pnpm.io/workspaces): workspace =
dir with `pnpm-workspace.yaml`; locally available packages "are linked to
`node_modules` instead of being downloaded"). Verified: pnpm 10.17.1 resolves
`"rootapp": "workspace:*"` from `packages/mcp` to the root project and creates
`packages/mcp/node_modules/rootapp -> ../../..`.

### Symlinks × Node 22 native type stripping — the exact rule

Node's refusal is a **string test on the final, realpath-resolved filename**:

- [`lib/internal/modules/typescript.js`](https://github.com/nodejs/node/blob/main/lib/internal/modules/typescript.js)
  (`stripTypeScriptModuleTypes`, ~L154):
  `if (isUnderNodeModules(filename)) { throw new ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING(filename); }`
- [`lib/internal/util.js`](https://github.com/nodejs/node/blob/main/lib/internal/util.js) (~L541):
  `const kNodeModulesRE = /^(?:.*)[\\/]node_modules[\\/]/;` —
  `isUnderNodeModules` is a pure path-string regex, no fs inspection.
- The `filename` it sees comes from module **resolution**, and the ESM resolver
  realpaths before loading: [`lib/internal/modules/esm/resolve.js`](https://github.com/nodejs/node/blob/main/lib/internal/modules/esm/resolve.js)
  `finalizeResolution` (~L276): `if (!preserveSymlinks) { const real = fs.realpathSync(path, …); resolved = pathToFileURL(real …); }` —
  `--preserve-symlinks` is off by default.

So the check runs **after** realpath: a `.ts` file reached through a workspace
symlink resolves to its real location outside `node_modules` and **is stripped
normally**. The docs sentence being dodged — "Node.js refuses to handle
TypeScript files inside folders under a `node_modules` path"
([nodejs.org/api/typescript.html](https://nodejs.org/api/typescript.html),
"Type stripping in dependencies"; stripping on by default since v22.18.0 /
v23.6.0) — only bites real files physically under `node_modules`.

Empirical confirmation (node v22.20.0):

- `node packages/mcp/src/index.ts` where `index.ts` does
  `import { price } from "rootapp/src/lib/curve.ts"` and `curve.ts` itself does
  `import { base } from "#lib/util.ts"` → runs, prints `price: 6n`. Works
  identically through the npm `file:../..` symlink and the pnpm `workspace:*`
  symlink. Note the chained detail: after realpath, the root's own `#lib/*`
  subpath imports resolve against the real root `package.json` — the app's
  alias convention keeps working when its modules are loaded via the symlink.
- Negative control: copying `util.ts` to a real (non-symlinked) path under
  `node_modules` and importing it throws `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.

Gotchas:

- The root package has **no `exports` field**, so deep specifiers like
  `splits-pact/src/lib/curve.ts` are legal (all subpaths exposed). Adding an
  `exports` field to the root later would break these imports unless the
  subpaths are exported.
- One cannot alias into the parent from the mcp package's own `imports` field:
  `imports`/`exports` targets that are paths must start with `./` and may not
  escape the package (invalid targets throw `ERR_INVALID_PACKAGE_TARGET`,
  [Node packages docs](https://nodejs.org/api/packages.html#subpath-imports)).
  Going through the root package _by name_ is the only spec-clean route.

## 3. Does the app need to move to `apps/web`? No.

- **Vite** defines project root as where `index.html` lives and looks for its
  config there; an alternative root is an explicit opt-in
  (`vite serve some/sub/dir`) ([vite.dev/guide — Index.html and Project Root](https://vite.dev/guide/#index-html-and-project-root)).
  Nothing in Vite knows or cares about npm workspaces; the four HTML shells and
  `vite.config.ts` at repo root keep working unchanged after adding
  `"workspaces": ["packages/*"]`.
- **Vercel** treats a monorepo as "one project per directory" selected via the
  Root Directory setting, which simply _defaults to the repo root_ — an app at
  root is the base case, not an exception
  ([vercel.com/docs/monorepos](https://vercel.com/docs/monorepos)). Its
  monorepo extras (skip-unaffected builds) explicitly support npm workspaces:
  "The monorepo must be using npm, yarn, pnpm, or Bun workspaces … (`workspaces`
  key in `package.json` for npm)"; package manager is auto-detected "using the
  lockfile at the repository root", and workspace package names must be unique.
  `vercel.json` `cleanUrls` is per-project config and is untouched.
- **npm** defines workspaces as "the `workspaces` property of the `package.json`"
  at the root; nothing requires the root package to be dependency-only. The
  first-party MCP `servers` repo itself gives root a real identity (deps on its
  own workspaces). Root-as-app + `workspaces: ["packages/*"]` is a supported,
  ordinary shape ([npm workspaces docs](https://docs.npmjs.com/cli/v11/using-npm/workspaces)).

Moving to `apps/web` would churn the four HTML shells, `vercel.json`, Vercel's
Root Directory setting, CI paths, and every `#` alias-relative tool config —
for zero functional gain. Skip it.

## 4. Bundle or plain tsc emit?

**The survey norm is plain tsc emit with deps external** (servers monorepo,
context7), with tsdown (a bundler, but run with deps external) used by the SDK
v2 and Sentry. Single-file/vendored bundling is the exception (chrome-devtools,
for license-notice reasons).

**But plain tsc emit cannot work for this repo's sharing shape:**

- tsc never rewrites import specifiers except under TS 5.7's
  `--rewriteRelativeImportExtensions`, which rewrites **only relative** `./`/`../`
  paths ending in `.ts/.tsx/.mts/.cts`: "Only _relative_ paths are rewritten,
  and they are written 'naively'… any path that relies on TypeScript's `baseUrl`
  and `paths` will not get rewritten… Nor will any path that might resolve
  through the `exports` and `imports` fields of a `package.json`"
  ([TS 5.7 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html)).
  Every shared pact module is reached via `#lib/*.ts` subpath imports and (from
  the mcp package) `splits-pact/src/….ts` — both categories tsc will emit
  verbatim, producing `dist` JS that still imports `.ts` files from a package
  that isn't in the consumer's `node_modules`. Dead on arrival.
- Even if specifiers were rewritable, the shared sources live _outside_ the
  publishable package (`rootDir` violation / files emitted outside `outDir`).

A bundler erases the whole problem: it inlines the shared root modules
(following the root `package.json` `imports` field — esbuild resolves subpath
imports natively) and leaves npm deps external. The repo already has the
tooling in `node_modules` via Vite: **esbuild 0.28.1** and rollup 4.62.2
(checked locally at `/Users/rooh/work/pact/node_modules`). Vite `build.lib`
could also do it, but pact-mcp isn't a Vite app; invoking esbuild directly is
smaller. tsdown is the choice the MCP SDK itself endorses, but it's a new
devDependency for what one esbuild invocation does.

One esbuild-specific trap: `--packages=external` externalizes _every_ bare
specifier — including `splits-pact` — which would defeat the inlining. Use an
explicit external list (the package's declared `dependencies`) instead, so
`splits-pact/src/…` gets bundled in while `viem` and
`@modelcontextprotocol/sdk` stay external.

## Recommendation

**Layout: root-as-app + `packages/pact-mcp`. Do not move the app.**
Add `"workspaces": ["packages/*"]` to the root `package.json` and create
`packages/pact-mcp`. Evidence: Vite root and Vercel Root Directory both default
to exactly the current shape (§3); the first-party MCP servers repo is itself
npm-workspaces with a root that has identity (§1).

**Package manager: stay npm.** npm workspaces handle everything needed —
verified including the one exotic bit, a workspace depending on the repo root
via `"splits-pact": "file:../.."` (installed as a symlink, §2). Vercel
auto-detects npm from the root lockfile. pnpm's advantages here (catalogs,
strictness, `workspace:*` sugar) solve problems this two-package repo doesn't
have; a migration would touch lockfile, CI, and Vercel for no functional gain.

**Dev-time sharing:** `packages/pact-mcp` declares `"splits-pact": "file:../.."`
in **devDependencies** (never `dependencies` — a published `file:` dep would
break every `npx` install; it's bundled away at publish). Source imports the
shared modules as `splits-pact/src/lib/chain/curve.ts` etc. Dev runs are just
`node packages/pact-mcp/src/index.ts`: Node ≥22.18 strips types through the
workspace symlink because the `node_modules` check happens on the realpath (§2,
verified). Keep the root package free of an `exports` field (or export the
subpaths if one is ever added). Typechecking: give pact-mcp a small tsconfig
extending the root one, or simply add `"packages"` to the root tsconfig
`include` — `moduleResolution: "bundler"` + `allowImportingTsExtensions` +
`erasableSyntaxOnly` already match how the package will be consumed.

**Publish pipeline (the one place this repo should diverge from the surveyed
tsc-emit norm — deciding factor: `rewriteRelativeImportExtensions` can't touch
`#`-alias or bare-package `.ts` specifiers, §4):**

- `src/index.ts` starts with `#!/usr/bin/env node` (the pattern every surveyed
  server uses; esbuild and tsc both preserve it — verified in both tarballs).
- Build: `esbuild src/index.ts --bundle --platform=node --format=esm
--outfile=dist/index.js` with `--external:` for each entry in the package's
  `dependencies` (expected: `@modelcontextprotocol/sdk` or the v2
  `@modelcontextprotocol/server`/`node` pair, `viem`, `zod`). Everything from
  root `src/lib` + `src/generated` gets inlined; wagmi/react never enter the
  graph because the reused modules are viem-only. Add `esbuild` as an explicit
  devDependency of pact-mcp rather than leaning on Vite's transitive copy.
- `package.json`: `"type": "module"`, `"bin": {"pact-mcp": "dist/index.js"}`,
  `"files": ["dist"]`, `"prepack": "npm run build"` (SDK v2 pattern; the
  servers repo's `"prepare"` also works but runs on every install),
  `"engines": {"node": ">=20"}` — follow the runtime deps (MCP SDK is `>=20`),
  not the repo's dev-only `>=22.18` (which is about type stripping, irrelevant
  to the compiled artifact). Scoped package ⇒ publish with `--access public`.
- Publish from the workspace: `npm publish --workspace packages/pact-mcp`.

Where evidence is genuinely mixed: tsc-emit vs bundler among high-quality
servers is a real split (context7/servers vs sentry/SDK-v2), and either is fine
for a self-contained package. For _this_ repo the sources being shared across
the package boundary with `.ts`-extension `#` imports settles it: bundler.
