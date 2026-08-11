# Deployment

The app is designed to deploy on Fly.io as one Node process serving both static
files and `/api`.

## Required Production Shape

- Docker image from `Dockerfile`
- Persistent volume mounted at `/data`
- SQLite path set to `/data/pact.sqlite`
- Splits Explorer API key configured as a secret
- Base mainnet wallet interactions happen in the user's browser wallet

## Environment Variables

Required:

```sh
PACT_DB_PATH=/data/pact.sqlite
SPLITS_EXPLORER_API_KEY=...
```

Optional:

```sh
PORT=7228
SPLITS_EXPLORER_GRAPHQL_URL=https://api.splits.org/graphql
PACT_RESET_DB=1
```

Do not set `PACT_RESET_DB=1` in production unless intentionally deleting the
SQLite database on next boot.

## Fly.io Setup

The repository includes the production `fly.toml` for the `splits-pact` Fly
app; adapt the app name and region to deploy your own.

1. Create the app:

   ```sh
   fly apps create splits-pact
   ```

2. Create the persistent volume:

   ```sh
   fly volumes create pact_data --size 1 --region sjc
   ```

3. Confirm `fly.toml` includes:

   ```toml
   [env]
     PORT = "7228"
     PACT_DB_PATH = "/data/pact.sqlite"

   [[mounts]]
     source = "pact_data"
     destination = "/data"
   ```

4. Set Fly app secrets:

   ```sh
   fly secrets set SPLITS_EXPLORER_API_KEY=...
   ```

5. Deploy manually when needed:

   ```sh
   fly deploy
   ```

6. Check health:

   ```sh
   curl https://<app-name>.fly.dev/healthz
   ```

## GitHub Auto-Deploy

Pushes to `main` deploy automatically through `.github/workflows/deploy.yml`.
The workflow:

1. Installs Node dependencies.
2. Installs Foundry.
3. Runs `npm audit --omit=dev`.
4. Runs `npm test`.
5. Runs `forge test`.
6. Runs `flyctl deploy --remote-only --config fly.toml`.

GitHub Actions requires the repository secret:

```sh
FLY_API_TOKEN=...
```

The current secret is an app-scoped Fly deploy token for `splits-pact`, expiring
after one year. Rotate it with:

```sh
fly tokens create deploy -a splits-pact -n github-actions-main-deploy -x 8760h
gh secret set FLY_API_TOKEN -R abramdawson/splits-pact
```

## Pre-Deploy Checklist

- `git status` is clean.
- `npm test` passes.
- `forge test` passes.
- `npm run test:e2e` passes or is intentionally skipped with a reason.
- `npm audit --omit=dev` passes.
- `src/generated/offering-contracts.js` contains the intended Base
  `OFFERING_FACTORY_ADDRESS`.
- `PACT_DB_PATH` points at the mounted volume path.
- `SPLITS_EXPLORER_API_KEY` is set as a Fly secret.
- App boots against an empty DB.

## Operational Notes

SQLite is acceptable for the prototype, but it makes the Fly volume the durable
source for local application state. Losing the volume loses issuance/allocation
records, though onchain offerings and Liquid Split state remain on Base.

The app currently has no signature-based login. It gates dashboard actions by
connected wallet address in the browser UI and relies on unguessable allocation
links for buyer pages.
