import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface StartedVault {
  container: StartedTestContainer;
  /** http://host:port */
  endpoint: string;
  token: string;
  stop(): Promise<void>;
}

const ROOT_TOKEN = 'root-test-token';

/** Dev mode (in-memory, fixed root token): tests only. */
export async function startVault(): Promise<StartedVault> {
  const container = await new GenericContainer('hashicorp/vault:latest')
    .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: ROOT_TOKEN, VAULT_DEV_LISTEN_ADDRESS: '0.0.0.0:8200' })
    .withExposedPorts(8200)
    .withWaitStrategy(Wait.forHttp('/v1/sys/health', 8200).forStatusCode(200))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(8200)}`;
  return {
    container,
    endpoint,
    token: ROOT_TOKEN,
    stop: async () => {
      await container.stop();
    },
  };
}
