import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AgentManifestInputSchema,
  AgentManifestOutputSchema,
  AuthUrlInputSchema,
  AuthUrlOutputSchema,
  CacheStatusOutputSchema,
  CapabilitiesOutputSchema,
  ConnectionStatusInputSchema,
  ConnectionStatusOutputSchema,
  CoverageInputSchema,
  CoverageOutputSchema,
  DailyRollupInputSchema,
  DailySummaryInputSchema,
  DataInventoryOutputSchema,
  DataPointsInputSchema,
  DataTypeCatalogOutputSchema,
  EndpointDataOutputSchema,
  ExchangeCodeInputSchema,
  ExchangeCodeOutputSchema,
  PrivacyAuditOutputSchema,
  ReconcileInputSchema,
  ResponseFormatSchema,
  ResponseOnlyInputSchema,
  RevokeAccessOutputSchema,
  RollupInputSchema,
  SimpleReadInputSchema,
  SummaryOutputSchema,
  WeeklySummaryInputSchema,
  WellnessContextInputSchema,
  WellnessContextOutputSchema
} from "../schemas/common.js";
import { buildPrivacyAudit } from "../services/audit.js";
import { buildAgentManifest, formatAgentManifestMarkdown } from "../services/agent-manifest.js";
import { buildCapabilities } from "../services/capabilities.js";
import { buildConnectionStatus } from "../services/connection-status.js";
import { buildDataTypeCoveragePlan, buildLiveDataTypeCoverage, formatCoverageMarkdown } from "../services/coverage-report.js";
import { buildWellnessContext, formatWellnessContextMarkdown } from "../services/context.js";
import { getConfig } from "../services/config.js";
import { bulletList, formatDataPointsMarkdown, makeEndpointError, makeError, makeResponse, makeSummaryError } from "../services/format.js";
import { buildDataInventory, buildDataTypeCatalog, formatDataTypeCatalogMarkdown, formatInventoryMarkdown } from "../services/inventory.js";
import { applyPrivacy, resolvePrivacyMode } from "../services/privacy.js";
import { buildSyntheticDemoPayload } from "../services/synthetic-demo.js";
import {
  buildProfileSummary,
  getOnboardingFlow,
  getProfile,
  getProfilePath,
  missingCriticalFields,
  updateProfile,
  type WellnessProfileDocument
} from "../services/profile-store.js";
import { buildDailySummary, buildWeeklySummary, formatSummaryMarkdown } from "../services/summary.js";
import { GoogleHealthClient } from "../services/google-health-client.js";

function client(): GoogleHealthClient {
  return new GoogleHealthClient(getConfig());
}

function endpointOutput(endpoint: string, privacy_mode: "summary" | "structured" | "raw", data: unknown) {
  return { endpoint, privacy_mode, data };
}

export function registerGoogleHealthTools(server: McpServer): void {
  server.registerTool("google_health_data_inventory", {
    title: "Google Health Data Inventory",
    description: "Use this to orient the model before working with Google Health: it returns supported data domains, OAuth scopes, privacy modes, and a recommended call sequence without calling Google APIs. Use google_health_list_data_types instead when the immediate need is a valid data_type slug and its supported operations.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: DataInventoryOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    const inventory = buildDataInventory();
    return makeResponse(inventory, response_format, formatInventoryMarkdown(inventory));
  });

  server.registerTool("google_health_list_data_types", {
    title: "List Google Health Data Types",
    description: "List the canonical kebab-case data_type slugs accepted by the data point, reconcile and rollup tools, with each slug's unit, OAuth scope family, and which endpoint verbs (list/reconcile/rollup) support it. Call this before list_data_points, reconcile_data_points, daily_rollup or rollup to choose a valid data_type instead of guessing a slug. Static metadata; does not call Google APIs.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: DataTypeCatalogOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    const catalog = buildDataTypeCatalog();
    return makeResponse(catalog, response_format, formatDataTypeCatalogMarkdown(catalog));
  });

  server.registerTool("google_health_data_type_coverage", {
    title: "Google Health Data Type Coverage",
    description: "Use this when the user asks which data types should work or wants a safe availability test across an authenticated account. Static mode builds a coverage plan; live mode performs read-only checks and returns only redacted statuses and point-count buckets, not health measurements. Do not use it to retrieve data points or summaries.",
    inputSchema: CoverageInputSchema.shape,
    outputSchema: CoverageOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ live, date, data_source_family, data_types, response_format }) => {
    const options = { date, dataSourceFamily: data_source_family, dataTypes: data_types };
    const report = live
      ? await buildLiveDataTypeCoverage(client(), options)
      : buildDataTypeCoveragePlan(options);
    return makeResponse(report, response_format, formatCoverageMarkdown(report));
  });

  server.registerTool("google_health_agent_manifest", {
    title: "Google Health Agent Manifest",
    description: "Use this when installing or configuring the server for a particular MCP client; it returns machine-readable package, OAuth, runtime, troubleshooting, and client-specific guidance. It does not inspect the current connection, call Google Health, or return health data or secrets; use google_health_connection_status for live local readiness.",
    inputSchema: AgentManifestInputSchema.shape,
    outputSchema: AgentManifestOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ client: targetClient, response_format }) => {
    const manifest = buildAgentManifest(targetClient);
    return makeResponse(manifest, response_format, formatAgentManifestMarkdown(manifest));
  });

  server.registerTool("google_health_capabilities", {
    title: "Google Health MCP Capabilities",
    description: "Use this when the user asks what this connector can do, what data and privacy modes it supports, or what its beta and API boundaries are. It returns static capability and workflow guidance; use google_health_data_inventory for a domain-first catalog or google_health_connection_status for this installation's readiness.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: CapabilitiesOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    const capabilities = buildCapabilities();
    return makeResponse(capabilities, response_format, bulletList("Google Health MCP Capabilities", {
      project: capabilities.project,
      status: capabilities.status,
      api_boundary: capabilities.api_boundary.source,
      recommended_first_tools: "google_health_connection_status, google_health_data_inventory, google_health_daily_summary",
      docs: capabilities.links.docs
    }));
  });

  server.registerTool("google_health_quickstart", {
    title: "Google Health Quickstart",
    description: "Personalized 3-step setup walkthrough for the human user. Adapts to current state (env vars set? token present? what's next?). Call this first when the user asks 'how do I connect Google Health?'",
    inputSchema: ResponseOnlyInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    const status = await buildConnectionStatus();
    const hasEnv = status.missing_env.length === 0;
    const hasToken = status.ready_for_google_health_api;
    const steps = [
      {
        step: 1,
        title: hasEnv ? "(done) Google Cloud OAuth client configured" : "Create a Google Cloud OAuth client and enable Google Health API v4",
        action: hasEnv
          ? "GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET, GOOGLE_HEALTH_REDIRECT_URI are all set."
          : `Open https://console.cloud.google.com/apis/library/health.googleapis.com to enable the API, create an OAuth 2.0 client (type: Desktop), register a redirect URI (use ${status.redirect_uri ?? "http://127.0.0.1:3000/callback"}), then set: ${status.missing_env.join(", ")}.`,
        done: hasEnv,
      },
      {
        step: 2,
        title: hasToken ? "(done) Local token present — ready to read Google Health data" : "Run the OAuth dance",
        action: hasToken
          ? "Tokens stored under ~/.google-health-mcp/tokens.json. The connector will refresh automatically when needed."
          : "Run `google-health-mcp-server auth` (or call google_health_get_auth_url + google_health_exchange_code from the agent). Open the URL, grant access, paste the code.",
        done: hasToken,
      },
      {
        step: 3,
        title: "Verify with the agent",
        action: "Call google_health_connection_status, then google_health_daily_summary or google_health_wellness_context. Pair with wellness-nourish for sleep-aware meal coaching.",
        example: hasToken
          ? "google_health_wellness_context() → sleep + activity load handoff for nourish/cycle-coach."
          : "Until step 2 is done, the data tools will surface a clear 'auth required' message.",
        done: false,
      },
    ];
    const payload = {
      ok: true,
      ready: hasEnv && hasToken,
      steps,
      next: steps.find((s) => !s.done) ?? steps[steps.length - 1],
      migration_note: "Fitbit accounts are migrating to Google Health Connect. If you previously used fitbit-mcp-unofficial and now own a Pixel Watch (or installed Google Health Connect on Android), google-health-mcp-unofficial is the forward-looking connector — your tokens are different but the data domains overlap.",
      cross_connector_hints: [
        "Pair Google Health sleep + steps with wellness-nourish for sleep-aware meal coaching.",
        "Pair Google Health HRV with wellness-cycle-coach for late-luteal load adjustments.",
        "Pair Google Health resting heart rate with wellness-cgm-mcp glucose for metabolic-stress signals.",
      ],
    };
    const markdown = bulletList("Google Health Quickstart", {
      ready: payload.ready,
      next: payload.next.title,
      migration: "Fitbit -> Google Health Connect migration: this connector is the forward path for Pixel Watch + Android.",
    });
    return makeResponse(payload, response_format, markdown);
  });

  server.registerTool("google_health_demo", {
    title: "Google Health Demo",
    description: "Use this to preview realistic example outputs for daily summary, wellness context, and daily rollup before OAuth is ready or when testing model integration. The returned Pixel-Watch-style payloads are synthetic contract examples, not the authenticated user's health data; use the corresponding live tools for real results.",
    inputSchema: ResponseOnlyInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    const payload = buildSyntheticDemoPayload();
    const markdown = bulletList("Google Health Demo", {
      is_demo: true,
      steps: 9180,
      sleep_score: 81,
      resting_heart_rate: 54,
      hrv_ms: 46,
      recommendation: payload.sample.google_health_wellness_context.recommendation,
    });
    return makeResponse(payload, response_format, markdown);
  });

  server.registerTool("google_health_get_auth_url", {
    title: "Get Google Health OAuth URL",
    description: "Use this after the user chooses to connect Google Health and connection status shows no usable token. It returns the authorization URL, redirect URI, requested scopes, and PKCE code_verifier; have the user authorize in a browser, then pass the returned code and this verifier to google_health_exchange_code. Do not use it to check whether an existing connection works.",
    inputSchema: AuthUrlInputSchema.shape,
    outputSchema: AuthUrlOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (params) => {
    try {
      const config = getConfig();
      const { authUrl, codeVerifier } = new GoogleHealthClient(config).authUrl(params.state, params.scopes);
      const output = {
        auth_url: authUrl,
        redirect_uri: config.redirectUri,
        scopes: params.scopes?.length ? params.scopes : config.scopes,
        code_verifier: codeVerifier,
        next_step: "Open auth_url, approve access, then pass the returned code (or full redirect URL) AND code_verifier to google_health_exchange_code."
      };
      return makeResponse(output, params.response_format, bulletList("Google Health OAuth URL", output));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool("google_health_exchange_code", {
    title: "Exchange Google Health OAuth Code",
    description: "Use this only after the user explicitly completes the authorization URL flow from google_health_get_auth_url. Pass the returned authorization code (or full redirect URL) and matching PKCE code_verifier; the tool stores tokens locally with 0600 permissions and never returns token values. Do not call it autonomously or reuse a code/verifier from another flow.",
    inputSchema: ExchangeCodeInputSchema.shape,
    outputSchema: ExchangeCodeOutputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (params) => {
    try {
      const result = await client().exchangeCode(params.code, params.code_verifier);
      const output = { ...result, note: "Token values were stored locally and intentionally omitted from this response." };
      return makeResponse(output, params.response_format, bulletList("Google Health OAuth Exchange", output));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool("google_health_get_identity", {
    title: "Get Google Health Identity",
    description: "Use this when the user asks about their authenticated Google Health identity mapping, especially during a Fitbit-to-Google migration. It requires a connected account and returns identity linkage rather than health measurements; do not use it for profile attributes, settings, or activity data.",
    inputSchema: SimpleReadInputSchema.shape,
    outputSchema: EndpointDataOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ response_format, privacy_mode, explicit_user_intent }) => {
    const endpoint = "/v4/users/me/identity";
    let mode: "summary" | "structured" | "raw" = privacy_mode ?? "structured";
    try {
      const config = getConfig();
      mode = resolvePrivacyMode(config, privacy_mode, { explicit_user_intent });
      const data = applyPrivacy(endpoint, await new GoogleHealthClient(config).getIdentity(), mode);
      return makeResponse(endpointOutput(endpoint, mode, data), response_format, bulletList("Google Health Identity", data as Record<string, unknown>));
    } catch (error) {
      return makeEndpointError(endpoint, mode, (error as Error).message, response_format);
    }
  });

  server.registerTool("google_health_get_profile", {
    title: "Get Google Health Profile",
    description: "Use this when the user asks for profile attributes held by Google Health for the authenticated account. It requires the profile scope and applies the selected privacy mode; do not confuse it with google_health_profile_get, which reads the separate local Delx Wellness profile.",
    inputSchema: SimpleReadInputSchema.shape,
    outputSchema: EndpointDataOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ response_format, privacy_mode, explicit_user_intent }) => {
    const endpoint = "/v4/users/me/profile";
    let mode: "summary" | "structured" | "raw" = privacy_mode ?? "structured";
    try {
      const config = getConfig();
      mode = resolvePrivacyMode(config, privacy_mode, { explicit_user_intent });
      const data = applyPrivacy(endpoint, await new GoogleHealthClient(config).getProfile(), mode);
      return makeResponse(endpointOutput(endpoint, mode, data), response_format, bulletList("Google Health Profile", data as Record<string, unknown>));
    } catch (error) {
      return makeEndpointError(endpoint, mode, (error as Error).message, response_format);
    }
  });

  server.registerTool("google_health_get_settings", {
    title: "Get Google Health Settings",
    description: "Use this when the user asks which units or timezone Google Health has configured for the authenticated account. It requires the settings scope and returns account settings, not server configuration or the local wellness profile.",
    inputSchema: SimpleReadInputSchema.shape,
    outputSchema: EndpointDataOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ response_format, privacy_mode, explicit_user_intent }) => {
    const endpoint = "/v4/users/me/settings";
    let mode: "summary" | "structured" | "raw" = privacy_mode ?? "structured";
    try {
      const config = getConfig();
      mode = resolvePrivacyMode(config, privacy_mode, { explicit_user_intent });
      const data = applyPrivacy(endpoint, await new GoogleHealthClient(config).getSettings(), mode);
      return makeResponse(endpointOutput(endpoint, mode, data), response_format, bulletList("Google Health Settings", data as Record<string, unknown>));
    } catch (error) {
      return makeEndpointError(endpoint, mode, (error as Error).message, response_format);
    }
  });

  server.registerTool("google_health_list_data_points", {
    title: "List Google Health Data Points",
    description: "Use this when the user needs detailed, source-level records for one data type, including provenance metadata when Google supplies it. First use google_health_list_data_types to choose a supported kebab-case data_type, and use filters or page_token for time bounds and pagination. Prefer reconcile for a deduplicated cross-source stream and rollup tools for aggregates; list is the right choice when individual dataSource metadata matters.",
    inputSchema: DataPointsInputSchema.shape,
    outputSchema: EndpointDataOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    const endpoint = `/v4/users/me/dataTypes/${params.data_type}/dataPoints`;
    let mode: "summary" | "structured" | "raw" = params.privacy_mode ?? "structured";
    try {
      const config = getConfig();
      mode = resolvePrivacyMode(config, params.privacy_mode, { explicit_user_intent: (params as { explicit_user_intent?: boolean }).explicit_user_intent });
      const data = applyPrivacy(endpoint, await new GoogleHealthClient(config).listDataPoints({
        dataType: params.data_type,
        filter: params.filter,
        pageSize: params.page_size,
        pageToken: params.page_token
      }), mode);
      return makeResponse(endpointOutput(endpoint, mode, data), params.response_format, formatDataPointsMarkdown("Google Health Data Points", { endpoint, data_type: params.data_type }, data));
    } catch (error) {
      return makeEndpointError(endpoint, mode, (error as Error).message, params.response_format);
    }
  });

  server.registerTool("google_health_reconcile_data_points", {
    title: "Reconcile Google Health Data Points",
    description: "Use this when the user wants one reconciled, deduplicated stream for a data type across all or a selected source family. First use google_health_list_data_types to confirm reconcile support; choose all-sources, google-wearables, or google-sources and paginate with the returned token. Reconciled records may omit per-point dataSource metadata, so use google_health_list_data_points when provenance is required, or a rollup tool for aggregates.",
    inputSchema: ReconcileInputSchema.shape,
    outputSchema: EndpointDataOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    const endpoint = `/v4/users/me/dataTypes/${params.data_type}/dataPoints:reconcile`;
    let mode: "summary" | "structured" | "raw" = params.privacy_mode ?? "structured";
    try {
      const config = getConfig();
      mode = resolvePrivacyMode(config, params.privacy_mode, { explicit_user_intent: (params as { explicit_user_intent?: boolean }).explicit_user_intent });
      const data = applyPrivacy(endpoint, await new GoogleHealthClient(config).reconcileDataPoints({
        dataType: params.data_type,
        filter: params.filter,
        pageSize: params.page_size,
        pageToken: params.page_token,
        dataSourceFamily: params.data_source_family
      }), mode);
      return makeResponse(endpointOutput(endpoint, mode, data), params.response_format, formatDataPointsMarkdown("Google Health Reconciled Data", { endpoint, data_type: params.data_type, data_source_family: params.data_source_family ?? "all" }, data));
    } catch (error) {
      return makeEndpointError(endpoint, mode, (error as Error).message, params.response_format);
    }
  });

  server.registerTool("google_health_daily_rollup", {
    title: "Google Health Daily Rollup",
    description: "Use this for totals or summaries grouped by civil-date windows, such as daily steps, distance, calories, active minutes, weight, or heart metrics. First use google_health_list_data_types to confirm rollup support; end_date is exclusive, and window_size_days controls days per aggregate. Use google_health_rollup for exact timestamp intervals, or daily/weekly summary for a ready-made multi-metric narrative.",
    inputSchema: DailyRollupInputSchema.shape,
    outputSchema: EndpointDataOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    const endpoint = `/v4/users/me/dataTypes/${params.data_type}/dataPoints:dailyRollUp`;
    let mode: "summary" | "structured" | "raw" = params.privacy_mode ?? "structured";
    try {
      const config = getConfig();
      mode = resolvePrivacyMode(config, params.privacy_mode, { explicit_user_intent: (params as { explicit_user_intent?: boolean }).explicit_user_intent });
      const data = applyPrivacy(endpoint, await new GoogleHealthClient(config).dailyRollup({
        dataType: params.data_type,
        startDate: params.start_date,
        endDate: params.end_date,
        windowSizeDays: params.window_size_days,
        pageSize: params.page_size,
        pageToken: params.page_token,
        dataSourceFamily: params.data_source_family
      }), mode);
      return makeResponse(endpointOutput(endpoint, mode, data), params.response_format, formatDataPointsMarkdown("Google Health Daily Rollup", { endpoint, data_type: params.data_type, data_source_family: params.data_source_family }, data));
    } catch (error) {
      return makeEndpointError(endpoint, mode, (error as Error).message, params.response_format);
    }
  });

  server.registerTool("google_health_rollup", {
    title: "Google Health Physical-Time Rollup",
    description: "Use this to aggregate one data type into fixed physical-time windows between exact offset-aware timestamps, such as hourly values. First use google_health_list_data_types to confirm rollup support, and express window_size in protobuf seconds such as 3600s. Use google_health_daily_rollup for civil-day grouping or list/reconcile when individual records are needed.",
    inputSchema: RollupInputSchema.shape,
    outputSchema: EndpointDataOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    const endpoint = `/v4/users/me/dataTypes/${params.data_type}/dataPoints:rollUp`;
    let mode: "summary" | "structured" | "raw" = params.privacy_mode ?? "structured";
    try {
      const config = getConfig();
      mode = resolvePrivacyMode(config, params.privacy_mode, { explicit_user_intent: (params as { explicit_user_intent?: boolean }).explicit_user_intent });
      const data = applyPrivacy(endpoint, await new GoogleHealthClient(config).rollup({
        dataType: params.data_type,
        startTime: params.start_time,
        endTime: params.end_time,
        windowSize: params.window_size,
        pageSize: params.page_size,
        pageToken: params.page_token,
        dataSourceFamily: params.data_source_family
      }), mode);
      return makeResponse(endpointOutput(endpoint, mode, data), params.response_format, formatDataPointsMarkdown("Google Health Rollup", { endpoint, data_type: params.data_type, data_source_family: params.data_source_family }, data));
    } catch (error) {
      return makeEndpointError(endpoint, mode, (error as Error).message, params.response_format);
    }
  });

  server.registerTool("google_health_connection_status", {
    title: "Google Health Connection Status",
    description: "Use this first when setup, authentication, scopes, or client readiness may be the problem. It checks local configuration, token state, Node version, privacy mode, cache, and optional MCP-client readiness without calling Google APIs or exposing secrets. It does not prove that a particular health data type contains data; use live coverage for that.",
    inputSchema: ConnectionStatusInputSchema.shape,
    outputSchema: ConnectionStatusOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format, client: targetClient }) => {
    const status = await buildConnectionStatus({ client: targetClient });
    return makeResponse(status, response_format, bulletList("Google Health Connection Status", {
      ok: status.ok,
      ready_for_google_health_api: status.ready_for_google_health_api,
      missing_env: status.missing_env.join(", ") || "none",
      scope_status: status.oauth.scope_status,
      token_path: status.token.path,
      token_exists: status.token.exists,
      privacy_mode: status.privacy_mode,
      next_steps: status.next_steps.join(" | ")
    }));
  });

  server.registerTool("google_health_cache_status", {
    title: "Google Health Cache Status",
    description: "Use this when the user asks whether caching is enabled or wants cache entry and in-memory HTTP hit/miss statistics. It reports local cache state only and does not read Google Health data; use google_health_privacy_audit for the broader privacy and storage posture.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: CacheStatusOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    try {
      const status = client().cacheStatus();
      return makeResponse(status, response_format, bulletList("Google Health Cache Status", status));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool("google_health_privacy_audit", {
    title: "Google Health Privacy Audit",
    description: "Use this when the user asks for a privacy or secret-handling audit of the connector. It returns privacy-mode, GPS-redaction, cache, token-path, file-permission, and required-environment presence posture without secret values or health data. Use connection status instead for authentication and operational readiness.",
    inputSchema: ResponseOnlyInputSchema.shape,
    outputSchema: PrivacyAuditOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ response_format }) => {
    const audit = buildPrivacyAudit();
    return makeResponse(audit, response_format, bulletList("Google Health Privacy Audit", audit));
  });

  server.registerTool("google_health_revoke_access", {
    title: "Revoke Google Health OAuth Access",
    description: "Revoke the current Google OAuth grant and delete the local token file. Use only when the user explicitly wants to disconnect Google Health. Gated: requires explicit user intent — agents must not call this autonomously.",
    inputSchema: {
      explicit_user_intent: z
        .boolean()
        .optional()
        .describe("Must be true after the user explicitly asked to disconnect. Prevents agents from revoking autonomously."),
      response_format: ResponseFormatSchema
    },
    outputSchema: RevokeAccessOutputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ explicit_user_intent, response_format }) => {
    try {
      if (explicit_user_intent !== true) {
        return makeError(
          "USER_ACTION_REQUIRED: explicit_user_intent must be true to revoke access. Ask the user to confirm disconnect first."
        );
      }

      const result = await client().revokeAccess();
      const output = { ...result, note: "Google Health access was revoked and local tokens were removed. Re-authorize before future API calls." };
      return makeResponse(output, response_format, bulletList("Google Health Access Revoked", output));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool("google_health_daily_summary", {
    title: "Google Health Daily Summary",
    description: "Use this for a ready-made, single-day health check-in combining available activity, sleep, heart, and missing-data context from rollups and reconciled streams. It is read-only, beta, and non-medical; use daily_rollup when the user needs one metric's aggregate records rather than a practical multi-metric summary.",
    inputSchema: DailySummaryInputSchema.shape,
    outputSchema: SummaryOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    try {
      const summary = await buildDailySummary(client(), params);
      return makeResponse(summary, params.response_format, formatSummaryMarkdown(summary));
    } catch (error) {
      return makeSummaryError("daily_summary", (error as Error).message, params.response_format);
    }
  });

  server.registerTool("google_health_weekly_summary", {
    title: "Google Health Weekly Review",
    description: "Use this when the user asks for recent trends, a weekly review, or comparison with a prior period. It returns an activity, sleep, and heart scorecard with missing-data awareness; set compare_days=0 when no baseline is wanted. It is read-only, beta, and non-medical, and is preferable to manually chaining daily summaries for trend analysis.",
    inputSchema: WeeklySummaryInputSchema.shape,
    outputSchema: SummaryOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    try {
      const summary = await buildWeeklySummary(client(), params);
      return makeResponse(summary, params.response_format, formatSummaryMarkdown(summary));
    } catch (error) {
      return makeSummaryError("weekly_summary", (error as Error).message, params.response_format);
    }
  });

  server.registerTool("google_health_wellness_context", {
    title: "Google Health Wellness Context",
    description: "Use this when another wellness or recommendation workflow needs normalized activity, sleep, recent-training-load, soreness, and injury context over a 1–30 day lookback. It returns the shared wellness_context shape for downstream coaching rather than a user-facing trend report; use daily_summary or weekly_summary when the user primarily wants a readable review. Include soreness, injuries, and notes only when the user supplied them.",
    inputSchema: WellnessContextInputSchema.shape,
    outputSchema: WellnessContextOutputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    try {
      const context = await buildWellnessContext(client(), params);
      return makeResponse(context, params.response_format, formatWellnessContextMarkdown(context));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });

  server.registerTool(
    "google_health_profile_get",
    {
      title: "Get Delx Wellness Profile",
      description:
        "Use this when the user asks for their saved cross-connector wellness preferences or when another wellness tool needs stable goals, devices, training, nutrition, exercise, agent preferences, or safety flags. It reads the local shared Delx Wellness profile and never contains OAuth tokens or API secrets; do not confuse it with google_health_get_profile, which reads the authenticated Google Health account profile.",
      inputSchema: ResponseOnlyInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ response_format }) => {
      try {
        const profile = await getProfile();
        const payload = {
          ok: true,
          profile,
          summary: buildProfileSummary(profile),
          missing_critical: missingCriticalFields(profile),
          storage_path: getProfilePath()
        };
        return makeResponse(payload, response_format, bulletList("Delx Wellness Profile", {
          summary: payload.summary,
          missing_critical: payload.missing_critical,
          storage_path: payload.storage_path
        }));
      } catch (error) {
        return makeError((error as Error).message);
      }
    }
  );

  server.registerTool(
    "google_health_profile_update",
    {
      title: "Update Delx Wellness Profile",
      description:
        "Use this only when the user explicitly asks to save or change fields in the shared Delx Wellness profile. Pass a partial top-level patch for profile, goals, devices, training, nutrition, preferences, safety, or notes and set explicit_user_intent=true; secret-like fields are rejected. Use google_health_onboarding first when the required profile fields are unknown, and do not use this to modify Google Health account data.",
      inputSchema: {
        patch: z.record(z.string(), z.unknown()).describe("Partial WellnessProfileDocument object containing only fields the user wants changed. Allowed top-level keys are profile, goals, devices, training, nutrition, preferences, safety, and notes; obtain missing answers from google_health_onboarding."),
        explicit_user_intent: z.boolean().optional().describe("Set true only after the user explicitly asks to persist this profile patch; required for any write."),
        response_format: ResponseFormatSchema
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ patch, explicit_user_intent, response_format }) => {
      try {
        if (explicit_user_intent !== true) {
          return makeResponse(
            {
              ok: false,
              error: "USER_ACTION_REQUIRED",
              message: "Profile update requires explicit_user_intent=true. Confirm with the user before persisting."
            },
            response_format,
            bulletList("Delx Wellness Profile Update", {
              ok: false,
              error: "USER_ACTION_REQUIRED",
              hint: "Set explicit_user_intent=true once the user has confirmed."
            })
          );
        }
        const updated = await updateProfile(patch as Partial<WellnessProfileDocument>);
        const payload = {
          ok: true,
          profile: updated,
          summary: buildProfileSummary(updated),
          missing_critical: missingCriticalFields(updated),
          storage_path: getProfilePath()
        };
        return makeResponse(payload, response_format, bulletList("Delx Wellness Profile Updated", {
          summary: payload.summary,
          missing_critical: payload.missing_critical,
          storage_path: payload.storage_path
        }));
      } catch (error) {
        return makeError((error as Error).message);
      }
    }
  );

  server.registerTool(
    "google_health_onboarding",
    {
      title: "Delx Wellness Onboarding Flow",
      description:
        "Use this when the user wants to set up their shared wellness profile or when required profile context is missing. It returns the localized 11-question flow, current profile state, and missing fields without persisting anything; after the user answers, pass only the requested changes to google_health_profile_update with explicit intent. The resulting profile is shared across Delx Wellness connectors.",
      inputSchema: {
        locale: z.enum(["en", "pt-BR"]).optional().describe("Onboarding locale. Defaults to en."),
        response_format: ResponseFormatSchema
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ locale, response_format }) => {
      try {
        const flow = getOnboardingFlow(locale ?? "en");
        const profile = await getProfile();
        const payload = {
          ok: true,
          flow,
          current_profile: profile,
          missing_critical: missingCriticalFields(profile),
          cross_connector_hint:
            "This profile is shared across all Delx Wellness connectors. Answering once populates context for whoop, garmin, oura, fitbit, strava, polar, withings, apple-health, samsung-health, google-health, nourish, cycle-coach, cgm, and air."
        };
        return makeResponse(payload, response_format, bulletList("Delx Wellness Onboarding", {
          locale: flow.locale,
          questions: `${flow.questions.length} questions`,
          storage_path: flow.storage_path,
          missing_critical: payload.missing_critical,
          privacy_note: flow.privacy_note
        }));
      } catch (error) {
        return makeError((error as Error).message);
      }
    }
  );

  // The planned log_nutrition WRITE tool registers here. It is intentionally not shipped yet; the
  // supporting rails (input schema, write gate, nutrient normalizer, v4 DataPoint builder, client
  // method) already exist. See CONTRIBUTING.md → "Planned: nutrition write" for the wiring plan and
  // the open TO-VERIFY items before enabling a live POST.
}
