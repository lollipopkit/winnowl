import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface StartedMinio {
  container: StartedTestContainer;
  /** http://host:port */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  stop(): Promise<void>;
}

const ROOT_USER = 'minioadmin';
const ROOT_PASSWORD = 'minioadmin';

/** Path-style endpoint (forcePathStyle=true). */
export async function startMinio(): Promise<StartedMinio> {
  const container = await new GenericContainer('cgr.dev/chainguard/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: ROOT_USER, MINIO_ROOT_PASSWORD: ROOT_PASSWORD })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  return {
    container,
    endpoint,
    accessKeyId: ROOT_USER,
    secretAccessKey: ROOT_PASSWORD,
    stop: async () => {
      await container.stop();
    },
  };
}
