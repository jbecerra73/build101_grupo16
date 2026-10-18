// HTTP client for the dashboard API. The MCP server talks to FrictionSwarm only through it.

/** A failed API call: the route's `error` text, or why the dashboard could not be reached (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The route's `errors` list when it gives more than the headline (e.g. which flow fields are invalid). */
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetch: typeof fetch;

  constructor(o: { baseUrl: string; token?: string; fetch?: typeof fetch }) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.token = o.token || undefined;
    this.fetch = o.fetch ?? globalThis.fetch;
  }

  get<T>(path: string): Promise<T> {
    return this.request("GET", path).then((r) => r.json() as Promise<T>);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request("POST", path, body).then((r) => r.json() as Promise<T>);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request("PUT", path, body).then((r) => r.json() as Promise<T>);
  }

  /** A text file (e.g. the PR diff); undefined when the route answers 404. */
  async getText(path: string): Promise<string | undefined> {
    try {
      return await (await this.request("GET", path)).text();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, `Can't reach the dashboard at ${this.baseUrl}`);
    }
    if (res.ok) return res;
    const err = (await res.json().catch(() => undefined)) as { error?: unknown; errors?: unknown } | undefined;
    const message =
      res.status === 401
        ? "Unauthorized: set FS_API_TOKEN to the dashboard's DASHBOARD_API_TOKEN"
        : typeof err?.error === "string"
          ? err.error
          : `${method} ${path} failed (HTTP ${res.status})`;
    const details = Array.isArray(err?.errors) ? err.errors.filter((e): e is string => typeof e === "string" && e !== message) : [];
    throw new ApiError(res.status, message, details);
  }
}
