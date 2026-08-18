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
