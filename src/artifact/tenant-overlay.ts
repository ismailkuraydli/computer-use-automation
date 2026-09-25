/**
 * Tenant overlays — reuse one artifact across institutions that run the
 * same vendor product, configured differently.
 *
 * An artifact is recorded once against the base product. A tenant overlay
 * (profiles/tenants/<app>/<tenant>.json) lists only what differs for that
 * tenant: its host, UI labels ("Member ID" → "Account Holder #"), route
 * shapes (/detail?id=… → /members/…), extra interstitials, conditions and
 * sensitive fields. applyTenantOverlay produces the tenant's artifact and
 * profile; the recorded artifact is never copied or edited per tenant.
 */

import path from "path";
import { readFileSync } from "fs";
import type { CapabilityArtifact, ErrorHandler, ScreenSignature, StateGuard, TargetSpec } from "./types.js";
import type { AppProfile, Interstitial } from "./profile-types.js";
import type { SensitiveDataSpec } from "../safety/sensitive-data.js";
import { findDataFile, SAFE_NAME, type Workspace } from "../app/workspace.js";

export interface RouteRewrite {
  /** Route text in the base product, may contain {{param}} templates. */
  from: string;
  to: string;
}

export interface TenantOverlay {
  schemaVersion: string;
  app: string;
  tenant: string;
  description?: string;
  baseUrl?: string;
  /** Base UI text → tenant UI text, whole-text and case-insensitive. */
  labels?: Record<string, string>;
  routes?: RouteRewrite[];
  allowUrlPatterns?: string[];
  interstitials?: Interstitial[];
  conditions?: ErrorHandler[];
  sensitive?: SensitiveDataSpec;
}

export class TenantOverlayError extends Error {
  constructor(message: string) {
    super(`Invalid tenant overlay: ${message}`);
    this.name = "TenantOverlayError";
  }
}

export function loadTenantOverlay(ws: Workspace, app: string | undefined, tenant: string): TenantOverlay {
  if (!app) throw new TenantOverlayError("the artifact names no app profile, so it has no tenants");
  if (!SAFE_NAME.test(app) || !SAFE_NAME.test(tenant)) throw new TenantOverlayError(`bad name "${app}/${tenant}"`);

  const relative = path.join("profiles", "tenants", app, `${tenant}.json`);
  const file = findDataFile(ws, relative);
  if (!file) throw new TenantOverlayError(`no overlay at ${relative}`);
  return validateTenantOverlay(JSON.parse(readFileSync(file, "utf-8")));
}

export function validateTenantOverlay(raw: unknown): TenantOverlay {
  if (typeof raw !== "object" || raw === null) throw new TenantOverlayError("not a JSON object");
  const o = raw as TenantOverlay;
  if (typeof o.app !== "string" || typeof o.tenant !== "string") throw new TenantOverlayError('"app" and "tenant" are required');
  if (o.baseUrl !== undefined && !isHttpUrl(o.baseUrl)) throw new TenantOverlayError(`baseUrl "${o.baseUrl}" is not an http(s) URL`);
  if (o.labels && Object.values(o.labels).some((v) => typeof v !== "string")) throw new TenantOverlayError("labels must map text to text");
  if (o.routes && !o.routes.every((r) => typeof r?.from === "string" && typeof r?.to === "string")) {
    throw new TenantOverlayError('routes must be [{ "from": "...", "to": "..." }]');
  }
  return o;
}

export function applyTenantOverlay(
  artifact: CapabilityArtifact,
  profile: AppProfile,
  overlay: TenantOverlay
): { artifact: CapabilityArtifact; profile: AppProfile } {
  if (artifact.surface.app && overlay.app !== artifact.surface.app) {
    throw new TenantOverlayError(`overlay is for app "${overlay.app}", artifact is for "${artifact.surface.app}"`);
  }
  const relabel = labelMapper(overlay.labels ?? {});
  const reroute = routeMapper(overlay.routes ?? [], artifact.surface.baseUrl, overlay.baseUrl);

  const guard = (g: StateGuard | undefined): StateGuard | undefined =>
    g && {
      ...(g.anyOf ? { anyOf: g.anyOf.map((s) => signature(s, relabel, reroute)) } : {}),
      ...(g.allOf ? { allOf: g.allOf.map((s) => signature(s, relabel, reroute)) } : {}),
    };

  const tenantArtifact: CapabilityArtifact = {
    ...artifact,
    surface: { ...artifact.surface, ...(overlay.baseUrl ? { baseUrl: overlay.baseUrl } : {}) },
    allowlist: {
      ...artifact.allowlist,
      permittedDomains: unique([
        ...artifact.allowlist.permittedDomains,
        ...(overlay.baseUrl ? [new URL(overlay.baseUrl).hostname] : []),
      ]),
      permittedUrlPatterns: unique([...artifact.allowlist.permittedUrlPatterns, ...(overlay.allowUrlPatterns ?? [])]),
    },
    steps: artifact.steps.map((step) => ({
      ...step,
      ...(step.target ? { target: target(step.target, relabel) } : {}),
      ...(step.value !== undefined ? { value: step.action === "navigate" ? reroute(step.value) : step.value } : {}),
      ...(step.checkpoint ? { checkpoint: guard(step.checkpoint) } : {}),
    })),
    checkpoint: { ...artifact.checkpoint, ...signature(artifact.checkpoint, relabel, reroute) },
    metadata: { ...artifact.metadata, tenantOverrides: overlay.tenant },
  };

  const tenantProfile: AppProfile = {
    ...profile,
    interstitials: [...(overlay.interstitials ?? []), ...profile.interstitials],
    conditions: [...(overlay.conditions ?? []), ...profile.conditions],
    sensitive: {
      fields: unique([...(profile.sensitive?.fields ?? []).map(relabel), ...(overlay.sensitive?.fields ?? [])]),
      patterns: unique([...(profile.sensitive?.patterns ?? []), ...(overlay.sensitive?.patterns ?? [])]),
    },
  };

  return { artifact: tenantArtifact, profile: tenantProfile };
}

type Mapper = (text: string) => string;

function labelMapper(labels: Record<string, string>): Mapper {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const map = new Map(Object.entries(labels).map(([from, to]) => [norm(from), to]));
  return (text) => map.get(norm(text)) ?? text;
}

/** Rewrite route shapes, and move absolute URLs from the base host to the tenant's. */
function routeMapper(routes: RouteRewrite[], baseUrl: string, tenantBaseUrl?: string): Mapper {
  return (text) => {
    let out = routes.reduce((acc, r) => acc.split(r.from).join(r.to), text);
    if (tenantBaseUrl && baseUrl && out.startsWith(baseUrl)) out = tenantBaseUrl + out.slice(baseUrl.length);
    return out;
  };
}

function target(t: TargetSpec, relabel: Mapper): TargetSpec {
  return {
    ...t,
    ...(t.name !== undefined ? { name: relabel(t.name) } : {}),
    ...(t.label !== undefined ? { label: relabel(t.label) } : {}),
    ...(t.column !== undefined ? { column: relabel(t.column) } : {}),
    ...(t.row !== undefined ? { row: relabel(t.row) } : {}),
  };
}

function signature(sig: ScreenSignature, relabel: Mapper, reroute: Mapper): ScreenSignature {
  return {
    ...sig,
    ...(sig.urlPattern !== undefined ? { urlPattern: reroute(sig.urlPattern) } : {}),
    ...(sig.textContains !== undefined ? { textContains: relabel(sig.textContains) } : {}),
    ...(sig.axContains ? { axContains: sig.axContains.map((a) => ({ ...a, name: relabel(a.name) })) } : {}),
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
