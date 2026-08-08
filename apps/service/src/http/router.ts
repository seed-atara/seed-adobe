import type { IncomingMessage, ServerResponse } from "node:http";
import { SeedError } from "@seed-ae/domain";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Correlation id echoed back on every response and used in logs. */
  correlationId: string;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

export interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** Routes marked public skip session-token auth (liveness only). */
  isPublic: boolean;
}

export interface RouteOptions {
  isPublic?: boolean;
}

/**
 * A deliberately small router. The service exposes a handful of JSON endpoints
 * on loopback; a framework would add dependencies without removing much work.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(
    method: string,
    pattern: string,
    handler: Handler,
    options: RouteOptions = {},
  ): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(pattern),
      handler,
      isPublic: options.isPublic ?? false,
    });
    return this;
  }

  get(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add("GET", pattern, handler, options);
  }

  post(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add("POST", pattern, handler, options);
  }

  match(
    method: string,
    pathname: string,
  ): { route: Route; params: Record<string, string> } {
    const segments = splitPath(pathname);
    let pathMatched = false;

    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method.toUpperCase()) return { route, params };
    }

    throw new SeedError(
      pathMatched ? "bad_request" : "not_found",
      pathMatched
        ? `method ${method} is not allowed for ${pathname}`
        : `no route for ${pathname}`,
      pathMatched ? { httpStatus: 405 } : undefined,
    );
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i] as string;
    const received = actual[i] as string;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(received);
    } else if (expected !== received) {
      return undefined;
    }
  }
  return params;
}

export function isPublicRoute(route: { isPublic: boolean }): boolean {
  return route.isPublic;
}
