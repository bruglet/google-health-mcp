import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { RequestHandler, Response } from "express";

export const CLOUDFLARE_ACCESS_REQUIRED_ENV = "GOOGLE_HEALTH_MCP_CLOUDFLARE_ACCESS_REQUIRED";
export const CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV = "GOOGLE_HEALTH_MCP_CLOUDFLARE_ACCESS_TEAM_DOMAIN";
export const CLOUDFLARE_ACCESS_AUDIENCE_ENV = "GOOGLE_HEALTH_MCP_CLOUDFLARE_ACCESS_AUD";
export const CLOUDFLARE_ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

const CLOUDFLARE_ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";

export interface CloudflareAccessConfig {
  required: boolean;
  teamDomain?: string;
  audience?: string;
  jwksUrl?: string;
}

export interface CloudflareAccessGuardOptions {
  jwks?: JWTVerifyGetKey;
}

function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function parseRequired(value: string | undefined): boolean {
  if (!value) return false;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(
    `${CLOUDFLARE_ACCESS_REQUIRED_ENV} must be true or false when set.`
  );
}

function normalizeTeamDomain(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV} must be an HTTPS team-domain origin, for example https://your-team.cloudflareaccess.com.`
    );
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV} must be an HTTPS team-domain origin, for example https://your-team.cloudflareaccess.com.`
    );
  }

  return parsed.origin;
}

export function getCloudflareAccessConfig(
  env: Record<string, string | undefined> = process.env
): CloudflareAccessConfig {
  const required = parseRequired(readEnv(env, CLOUDFLARE_ACCESS_REQUIRED_ENV));
  const teamDomain = readEnv(env, CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV);
  const audience = readEnv(env, CLOUDFLARE_ACCESS_AUDIENCE_ENV);

  if (!required) {
    if (teamDomain || audience) {
      throw new Error(
        `${CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV} and ${CLOUDFLARE_ACCESS_AUDIENCE_ENV} require ${CLOUDFLARE_ACCESS_REQUIRED_ENV}=true.`
      );
    }
    return { required: false };
  }

  if (!teamDomain || !audience) {
    throw new Error(
      `${CLOUDFLARE_ACCESS_REQUIRED_ENV}=true requires both ${CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV} and ${CLOUDFLARE_ACCESS_AUDIENCE_ENV}.`
    );
  }

  const normalizedTeamDomain = normalizeTeamDomain(teamDomain);
  return {
    required: true,
    teamDomain: normalizedTeamDomain,
    audience,
    jwksUrl: `${normalizedTeamDomain}${CLOUDFLARE_ACCESS_CERTS_PATH}`
  };
}

function deny(res: Response): void {
  res.status(403).json({ error: "Forbidden" });
}

export function createCloudflareAccessGuard(
  config: CloudflareAccessConfig,
  options: CloudflareAccessGuardOptions = {}
): RequestHandler {
  if (!config.required) {
    return (_req, _res, next) => next();
  }

  if (!config.teamDomain || !config.audience || !config.jwksUrl) {
    throw new Error("Cloudflare Access guard configuration is incomplete.");
  }

  const jwks = options.jwks ?? createRemoteJWKSet(new URL(config.jwksUrl));

  return async (req, res, next) => {
    const token = req.get(CLOUDFLARE_ACCESS_JWT_HEADER);
    if (!token) {
      deny(res);
      return;
    }

    try {
      await jwtVerify(token, jwks, {
        issuer: config.teamDomain,
        audience: config.audience
      });
      next();
    } catch {
      // Keep all validation failures indistinguishable and never expose the JWT.
      deny(res);
    }
  };
}
