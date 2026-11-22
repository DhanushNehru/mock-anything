'use strict';

// Routing table for multi-upstream recording. One recorder can front several
// upstream APIs, routed by local path prefix:
//
//   mock-anything record --target api=https://api.stripe.com --prefix api=/stripe \
//                        --target auth=https://auth.example.com --prefix auth=/auth
//
// A request to /stripe/v1/charges is forwarded to https://api.stripe.com/v1/charges
// (the prefix is stripped). A plain `--target <url>` (no name) is the default
// route and receives every path no prefix matches, exactly like before.

function parseTargetValue(value) {
  // "name=https://..." names an upstream; a bare URL is the default route.
  const m = /^([A-Za-z0-9_-]+)=(https?:\/\/.+)$/.exec(value);
  if (m) return { name: m[1], url: m[2] };
  if (/^[A-Za-z0-9_-]+=/.test(value)) {
    throw new Error(`--target "${value}" looks like name=<url> but the value after "=" must be an http(s) URL`);
  }
  return { name: null, url: value };
}

function parsePrefixValue(value) {
  // "name=/prefix" binds to the named target; "/prefix" binds to the last --target.
  const m = /^([A-Za-z0-9_-]+)=(\/.+)$/.exec(value);
  if (m) return { name: m[1], prefix: m[2] };
  if (value.startsWith('/')) return { name: null, prefix: value };
  throw new Error(`--prefix "${value}" must look like /path or name=/path`);
}

// targets/prefixes are the raw flag values in the order they appeared.
// Returns [{ name, url: URL, prefix }] — the default route has prefix null.
function buildRoutes({ targets = [], prefixes = [], target } = {}) {
  const allTargets = target ? [...targets, target] : targets;
  if (allTargets.length === 0) throw new Error('record needs at least one --target <url>');

  const routes = allTargets.map((raw) => {
    const { name, url } = parseTargetValue(raw);
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`--target "${raw}" is not a valid URL`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`--target "${raw}" must be an http(s) URL`);
    }
    return { name, url: u, prefix: null };
  });

  const names = new Set();
  for (const r of routes) {
    if (r.name) {
      if (names.has(r.name)) throw new Error(`duplicate --target name "${r.name}"`);
      names.add(r.name);
    }
  }

  for (const raw of prefixes) {
    const { name, prefix } = parsePrefixValue(raw);
    const route = name ? routes.find((r) => r.name === name) : routes[routes.length - 1];
    if (!route) {
      throw new Error(name ? `--prefix ${name}=${prefix}: no --target named "${name}"` : '--prefix given before any --target');
    }
    if (route.prefix) throw new Error(`--target "${route.name || route.url.href}" already has prefix ${route.prefix}`);
    route.prefix = prefix;
  }

  for (const r of routes) {
    if (r.name && !r.prefix) {
      throw new Error(`named --target "${r.name}" needs a prefix, e.g. --prefix ${r.name}=/path`);
    }
  }
  const defaults = routes.filter((r) => !r.name);
  if (defaults.length > 1) {
    throw new Error('at most one plain --target <url> (the default route) is allowed alongside named targets');
  }
  return routes;
}

function singleRoute(target) {
  return [{ name: null, url: new URL(target), prefix: null }];
}

// Longest matching prefix wins. A prefix matches the exact path and any
// subpath, but not a sibling that merely shares a string prefix
// (/stripe matches /stripe and /stripe/v1, not /stripey).
function matchRoute(routes, reqPath) {
  let best = null;
  for (const r of routes) {
    if (!r.prefix) continue;
    if (reqPath === r.prefix || reqPath.startsWith(r.prefix + '/')) {
      if (!best || r.prefix.length > best.prefix.length) best = r;
    }
  }
  if (best) return best;
  return routes.find((r) => !r.prefix) || null;
}

// The path sent upstream: the local prefix is stripped.
function upstreamPath(route, reqPath) {
  if (!route.prefix) return reqPath;
  if (reqPath === route.prefix) return '/';
  return reqPath.slice(route.prefix.length);
}

function describeRoutes(routes) {
  return routes
    .map((r) => (r.prefix ? `${r.prefix} -> ${r.url.href} (${r.name})` : `${r.url.href} (default)`))
    .join(', ');
}

module.exports = { buildRoutes, singleRoute, matchRoute, upstreamPath, describeRoutes };
