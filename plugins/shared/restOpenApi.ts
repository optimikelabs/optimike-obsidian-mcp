/** Optional documentation observes registration only; never dispatches a handler. */
export type DocumentationState = "pending" | "published" | "unsupported" | "failed";
type OpenApiDescription = {
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, Record<string, Record<string, unknown>>>;
  tags?: Array<{ name: string; description?: string }>;
};
type PublicRouteApi = {
  apiVersion?: number;
  addRoute(path: string): any;
  addOpenApiDescription?: (description: OpenApiDescription) => void;
};
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function describeRestRoutes<T extends PublicRouteApi>(native: T, id: string): {
  api: T;
  publish(): DocumentationState;
  state(): DocumentationState;
} {
  let state: DocumentationState = "pending";
  const registered = new Map<string, Set<string>>();
  let observationFailed = false;
  // Do not modify the host's handle: its unregister still owns every route and
  // optional OpenAPI contribution, including on partial mount and provider reload.
  const api = new Proxy(native, {
    get(target, key) {
      if (key !== "addRoute") {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (path: string) => {
        const route = target.addRoute(path);
        let wrapped: typeof route;
        wrapped = new Proxy(route, {
          get(current, method) {
            const value = Reflect.get(current, method, current);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              // Registration failure must retain its original behavior. Only
              // record a method once the real host accepted its handler.
              const result = value.apply(current, args);
              if (typeof method === "string" && METHODS.has(method)) {
                try {
                  const methods = registered.get(path) ?? new Set<string>();
                  methods.add(method); registered.set(path, methods);
                } catch { observationFailed = true; }
              } else { observationFailed = true; }
              return result === current ? wrapped : result;
            };
          },
        });
        return wrapped;
      };
    },
  });
  return {
    api,
    state: () => state,
    publish: () => {
      if (state !== "pending") return state;
      try {
        if (!Number.isInteger(native.apiVersion) || native.apiVersion! < 3 ||
            typeof native.addOpenApiDescription !== "function") {
          state = "unsupported"; return state;
        }
        if (observationFailed || !/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("unsupported_documentation");
        const paths: Record<string, Record<string, unknown>> = {};
        const scheme = id + "-bearer";
        for (const [pattern, methods] of registered) {
          if (!pattern.startsWith("/")) throw new Error("unsupported_route");
          const params: Array<{ name: string; in: string; required: boolean; schema: { type: string } }> = [];
          const path = pattern.replace(/:([a-zA-Z][a-zA-Z0-9_]*)(\(\*\))?/g, (_match, name) => {
            params.push({ name, in: "path", required: true, schema: { type: "string" } });
            return "{" + name + "}";
          });
          if (/[():*?]/.test(path) || new Set(params.map(p => p.name)).size !== params.length)
            throw new Error("unsupported_route_pattern");
          if (Object.hasOwn(paths, path)) throw new Error("ambiguous_route_pattern");
          const item: Record<string, unknown> = { "x-optimike-express-pattern": pattern };
          for (const method of methods) item[method] = {
            tags: [id],
            summary: method.toUpperCase() + " " + path,
            description: "Authenticated Bridge route. Existing runtime permissions and mutation preconditions remain authoritative. This inventory describes paths and methods, not complete payload schemas; use the versioned Optimike contracts before invoking a mutation.",
            "x-optimike-schema-coverage": "route-and-method-only",
            security: [{ [scheme]: [] }],
            ...(params.length ? { parameters: params } : {}),
            responses: { default: { description: "Versioned Bridge response; consult the endpoint contract." } },
          };
          paths[path] = item;
        }
        native.addOpenApiDescription({
          paths,
          tags: [{ name: id, description: "Optimike Bridge authenticated route inventory (not authorization)." }],
          components: { securitySchemes: { [scheme]: { type: "http", scheme: "bearer" } } },
        });
        state = "published";
      } catch { state = "failed"; }
      return state;
    },
  };
}
