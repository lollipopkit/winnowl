import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface StartedMailpit {
  container: StartedTestContainer;
  smtpHost: string;
  smtpPort: number;
  apiUrl: string;
  messages(): Promise<MailpitMessage[]>;
  stop(): Promise<void>;
}

export interface MailpitMessage {
  subject: string;
  to: string[];
  from: string;
  body: string;
}

/** SMTP 1025 / HTTP API 8025. */
export async function startMailpit(): Promise<StartedMailpit> {
  const container = await new GenericContainer('axllent/mailpit:latest')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025).forStatusCode(200))
    .start();
  const apiUrl = `http://${container.getHost()}:${container.getMappedPort(8025)}`;
  const getJson = async <T>(path: string): Promise<T> => (await (await fetch(`${apiUrl}${path}`)).json()) as T;
  return {
    container,
    smtpHost: container.getHost(),
    smtpPort: container.getMappedPort(1025),
    apiUrl,
    async messages(): Promise<MailpitMessage[]> {
      // The list only has summaries; bodies are fetched by id.
      const list = await getJson<{ messages?: MailpitSummary[] }>('/api/v1/messages');
      return Promise.all(
        (list.messages ?? []).map(async (m) => ({
          subject: m.Subject ?? '',
          to: (m.To ?? []).map((a) => a.Address),
          from: m.From?.Address ?? '',
          body: (await getJson<{ Text?: string }>(`/api/v1/message/${m.ID}`)).Text ?? '',
        })),
      );
    },
    stop: async () => {
      await container.stop();
    },
  };
}

interface MailpitAddress {
  Address: string;
}

interface MailpitSummary {
  ID: string;
  Subject?: string;
  From?: MailpitAddress;
  To?: MailpitAddress[];
}
