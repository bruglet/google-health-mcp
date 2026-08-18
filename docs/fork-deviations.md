# Fork Deviations

This file records intentional behavior in this fork that is not part of the
upstream default. Keep it current when upstream changes the HTTP transport or
authorization model so the deviation can be reconciled instead of silently
lost during a merge.

## Optional Cloudflare Access guard for HTTP `/mcp`

### Upstream behavior

The upstream HTTP transport binds to loopback by default and does not perform
caller authentication at the MCP HTTP route. Google OAuth still authenticates
the downstream Google Health account, but it is not an authorization boundary
for the process's HTTP callers.

### Fork behavior and reasoning

This fork is intended to run on a private home server behind a Cloudflare
Tunnel and a single-user Cloudflare Access application. When explicitly
enabled, the origin validates the Cloudflare Access JWT itself before creating
an MCP transport. This preserves the security boundary if a request reaches
the origin through an unexpected path and keeps the policy decision at the
origin instead of trusting only the tunnel topology.

The guard is opt-in so normal local HTTP use remains compatible with upstream:

- `GOOGLE_HEALTH_MCP_CLOUDFLARE_ACCESS_REQUIRED` defaults to `false`.
- When it is `true`, both of these are required:
  - `GOOGLE_HEALTH_MCP_CLOUDFLARE_ACCESS_TEAM_DOMAIN`, an HTTPS origin such as
    `https://your-team.cloudflareaccess.com`.
  - `GOOGLE_HEALTH_MCP_CLOUDFLARE_ACCESS_AUD`, the Cloudflare Access
    application audience tag.
- The origin reads `Cf-Access-Jwt-Assertion` and validates its signature using
  `<team-domain>/cdn-cgi/access/certs`, with the configured team domain as
  issuer and the configured audience as the required audience.
- Missing, malformed, expired, incorrectly signed, wrong-issuer, and
  wrong-audience tokens receive the same generic `403 Forbidden` response.
- JWT contents are not logged or returned.
- Only `POST /mcp` is guarded. `/health` stays internal and unauthenticated,
  and the stdio transport is unchanged.
- Google OAuth, MCP-facing OAuth, scopes, privacy modes, and tool authorization
  are unchanged by this feature.

The runtime uses the `jose` package and its remote JWKS resolver so Cloudflare
key rotation is handled in memory without adding persistent key material to
the connector. The validation flow follows
[Cloudflare's origin JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

### Current home-server deployment

The home-server deployment now publishes the MCP endpoint at
`https://google-health-mcp.ismind.org/mcp` through the existing Cloudflare
Tunnel. Cloudflare Managed OAuth supplies the client-facing authorization
code/PKCE flow, while the container-side guard validates the resulting Access
assertion before serving MCP requests. The Access team domain and application
AUD remain only in the server's mode-0600 runtime environment file; neither
value is committed here. The public hostname is protected by Access, while
the origin continues to bind only to host loopback at `127.0.0.1:3101`.

### Merge guidance

The implementation is intentionally isolated in
`src/services/cloudflare-access.ts`, with one route middleware registration in
`src/index.ts`. If upstream changes the HTTP route, preserve the guard's
validation boundary and attach it to the equivalent MCP request route. If
upstream adds its own authorization layer, compare the guarantees before
removing this guard; do not leave two conflicting policies or silently weaken
origin validation. Revisit this file and `docs/authorization.md` whenever that
decision changes.

Future container and Quadlet artifacts for this deployment should enable the
guard explicitly and provide the team domain and audience through deployment
configuration, never by committing those values as secrets or embedding JWTs.

## GitHub Actions GHCR container publication

### Upstream behavior

The upstream repository has application CI but no workflow that builds and
publishes the production `Containerfile` to an OCI registry.

### Fork behavior and reasoning

This fork adds `.github/workflows/container-publish.yml` for the home-server
deployment. It uses the GitHub Container Registry image name derived from the
actual fork (`ghcr.io/<owner>/<repository>`) and authenticates only with the
workflow-provided `GITHUB_TOKEN`:

- `contents: read` and `packages: write` are the only workflow permissions.
- No Google Health, Google OAuth, or Cloudflare credentials are exposed to the
  build; the image has no runtime health credentials baked into it.
- The workflow runs manually, for relevant container/source changes on
  `main` or `integration/**`, and for semver tags such as `v0.7.6`.
- It publishes branch tags, `sha-<short-commit>` tags, semver tags, and
  `latest` for the default branch or semver releases. A major `0` tag is not
  published while the project remains in the `0.x` series.
- The build uses the same `Containerfile` as local deployment and targets the
  confirmed home-server architecture, `linux/amd64`; multi-architecture
  emulation is intentionally not added.
- Docker metadata labels link the image back to the fork, source revision, and
  published version.

The GHCR package's initial visibility and repository access settings remain
GitHub-side configuration; they are not represented by committed credentials
or deployment files.

### Merge guidance

If upstream adds a container workflow, compare its registry, trigger filters,
permissions, tag policy, target platforms, and metadata before merging. Keep
the build pointed at the fork's production `Containerfile`, retain the
minimal `GITHUB_TOKEN` permissions, and do not add Google or Cloudflare
secrets to the workflow. Revisit the architecture decision before adding
multi-architecture publishing.

## Days-aware wellness context window

### Upstream behavior

The upstream `google_health_wellness_context` tool accepted a `days` input but
built its result from a single daily summary. A request such as `days: 14`
therefore returned today's context rather than a 14-day lookback.

### Fork behavior and reasoning

This fork reuses the existing summary aggregation for the requested 1–30 day
window. `sleep_hours` and the activity-based `recent_training_load` represent
the window average, and the response includes `lookback_days` so downstream
agents can see which period was summarized. The public weekly-summary tool
still requires at least 7 days; shorter windows are supported only for the
wellness-context reuse path.

The change fixes a misleading accepted parameter without adding a new MCP
tool. It intentionally uses the existing daily summary primitives so privacy,
filter, and data-quality behavior remain shared with the rest of the connector.

### Merge guidance

If upstream changes `google_health_wellness_context` or the summary aggregation,
preserve the contract that every accepted `days` value controls the lookback.
Reconcile the internal minimum-days behavior and keep the average semantics and
`lookback_days` field aligned with any upstream wellness-context contract.

## Production OCI packaging

### Upstream behavior

The upstream repository does not currently provide a production OCI image
definition, a container build-context policy, or a tracked deployment
environment example.

### Fork behavior and reasoning

This fork adds a multi-stage `Containerfile` based on the Node 22 glibc image.
The build stage runs `npm ci` and `npm run build`, then removes development
dependencies before the runtime stage copies only `dist`, package metadata, and
production dependencies. The runtime defaults to the existing HTTP transport
on `0.0.0.0:3000`, structured privacy, the approved full read-only scopes,
disabled persistent SQLite caching, and the default in-memory HTTP cache.

The runtime uses the image's non-root `node` user. OAuth tokens are expected at
`/home/node/.google-health-mcp/tokens.json`, which must be supplied through a
runtime-mounted home directory or volume; no credentials, token files, local
configuration, or health data are copied into the image. `.dockerignore`
excludes those files from the build context, and `.env.example` documents safe
runtime placeholders plus the opt-in Cloudflare Access variables.

### Merge guidance

If upstream adds equivalent container packaging, compare the build inputs,
Node base image, non-root behavior, health check, environment defaults, and
secret/state exclusions before removing this fork artifact. Keep the token
path mounted rather than copied into an image, preserve the approved read-only
scope and cache defaults, and never replace placeholders in `.env.example`
with real credentials.

## Rootless Podman Quadlet deployment example

### Upstream behavior

The upstream repository does not currently provide a tracked rootless Podman
Quadlet deployment for a home server.

### Fork behavior and reasoning

This fork adds `deploy/quadlet/google-health-mcp.container` and its companion
environment example for the `host` user's Fedora IoT/Podman 5.8.4 setup. The
unit consumes the GHCR image published by this fork, uses the existing user
Quadlet search path, restarts on failure, and is pulled into the lingering
user manager's `default.target` for startup after reboot.

The server's existing `cloudflared` container uses host networking, so the MCP
origin binds only to host loopback at `127.0.0.1:3101` and maps to the
container's port 3000. Port 3000 is already used by another service. This
keeps the origin off external interfaces while leaving Cloudflare Tunnel able
to reach it locally. `/health` remains unauthenticated at the origin, while the
public hostname is protected by Cloudflare Access. The Cloudflare Access
origin guard is enabled in the current home-server runtime.

OAuth `config.json` and `tokens.json` are runtime state under
`~/settings/google-health-mcp`, mounted at the image's expected
`/home/node/.google-health-mcp` path with user-only permissions. The Quadlet
uses `UserNS=keep-id` so the host user's 0600 files remain readable by the
image's non-root `node` user without changing their host ownership. They are
not tracked, copied into the image, or represented by the example environment
file. No SQLite volume is created because persistent SQLite caching is
disabled; the default in-memory HTTP cache remains available.

### Merge guidance

If upstream adds a Quadlet or another deployment definition, compare the image
reference, user/rootless scope, host-network exposure, state mount, restart and
startup behavior, and secret exclusions before replacing this example. Keep
the origin loopback-only unless the upstream or Cloudflare deployment provides
an equivalent authenticated boundary, and preserve the approved privacy,
scope, and cache defaults.
