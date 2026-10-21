import { RecordingHttpServer, type RecorderResponse, type RecordedRequest } from './http-recorder.js';

export interface RouteKey {
  method: string;
  /** Prefix match. */
  pathPrefix: string;
}

interface Route extends RouteKey {
  response: RecorderResponse;
}

export class FakeProviderServer {
  private readonly http: RecordingHttpServer;
  private readonly routes: Route[] = [];

  constructor() {
    this.http = new RecordingHttpServer((req) => this.respond(req));
  }

  private respond(req: RecordedRequest): RecorderResponse {
    // Longest prefix wins, so registration order does not matter (/pulls/42 vs /pulls/42/files).
    let best: Route | undefined;
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      if (!req.url.startsWith(route.pathPrefix)) continue;
      if (!best || route.pathPrefix.length > best.pathPrefix.length) {
        best = route;
      }
    }
    if (!best) {
      return { status: 404, body: { message: `no route for ${req.method} ${req.url}` } };
    }
    return best.response;
  }

  on(method: string, pathPrefix: string, response: RecorderResponse): this {
    this.routes.push({ method, pathPrefix, response });
    return this;
  }

  get requests(): readonly RecordedRequest[] {
    return this.http.requests;
  }

  listen(): Promise<string> {
    return this.http.listen();
  }

  get url(): string {
    return this.http.url;
  }

  close(): Promise<void> {
    return this.http.close();
  }
}
