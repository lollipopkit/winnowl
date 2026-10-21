import { RecordingHttpServer, type RecorderResponse, type RecordedRequest } from './http-recorder.js';

export interface FakeModelReply {
  text?: string;
  toolCalls?: { name: string; arguments: unknown }[];
}

/** Accepts any POST and answers from a FIFO queue (default reply when empty); records all requests. */
export class FakeModelServer {
  private readonly http: RecordingHttpServer;
  private readonly queue: FakeModelReply[] = [];
  private defaultReply: FakeModelReply = { text: 'ok' };

  constructor() {
    this.http = new RecordingHttpServer((req) => this.respond(req));
  }

  private respond(_req: RecordedRequest): RecorderResponse {
    const reply = this.queue.shift() ?? this.defaultReply;
    return {
      status: 200,
      body: {
        id: `fake-${this.http.requests.length}`,
        model: 'fake-model',
        content: reply.text ?? '',
        tool_calls: reply.toolCalls ?? [],
      },
    };
  }

  enqueue(...replies: FakeModelReply[]): void {
    this.queue.push(...replies);
  }

  setDefault(reply: FakeModelReply): void {
    this.defaultReply = reply;
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
