import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): unknown;
}

export interface RecorderResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are JSON-serialized; strings are sent as is. */
  body?: unknown;
}

export type Responder = (req: RecordedRequest) => RecorderResponse | Promise<RecorderResponse>;

export class RecordingHttpServer {
  private readonly server: Server;
  private responder: Responder;
  readonly requests: RecordedRequest[] = [];

  constructor(responder?: Responder) {
    this.responder = responder ?? (() => ({ status: 200, body: {} }));
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  setResponder(responder: Responder): void {
    this.responder = responder;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      body,
      json: () => (body ? JSON.parse(body) : undefined),
    };
    this.requests.push(recorded);

    let result: RecorderResponse;
    try {
      result = await this.responder(recorded);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: (error as Error).message }));
      return;
    }

    const status = result.status ?? 200;
    const payload =
      typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {});
    res.statusCode = status;
    res.setHeader('content-type', result.headers?.['content-type'] ?? 'application/json');
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      res.setHeader(key, value);
    }
    res.end(payload);
  }

  async listen(): Promise<string> {
    // The address the URL names: on `::` another process bound to 127.0.0.1 on the same port takes the requests.
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  get url(): string {
    const addr = this.server.address() as AddressInfo | null;
    if (!addr) throw new Error('server 未启动');
    return `http://127.0.0.1:${addr.port}`;
  }

  clear(): void {
    this.requests.length = 0;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.close((err) => (err ? reject(err) : resolvePromise()));
    });
  }
}
