import { S3ArtifactStore } from './s3-store.js';
import { LocalArtifactStore, type ArtifactStore } from './store.js';

/** Precedence: `ARTIFACT_S3_*` > `ARTIFACT_LOCAL_DIR` > null. Path-style unless `ARTIFACT_S3_FORCE_PATH_STYLE=false`. */
export function artifactStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ArtifactStore | null {
  if (env.ARTIFACT_S3_BUCKET && env.ARTIFACT_S3_ACCESS_KEY_ID && env.ARTIFACT_S3_SECRET_ACCESS_KEY) {
    return new S3ArtifactStore({
      bucket: env.ARTIFACT_S3_BUCKET,
      accessKeyId: env.ARTIFACT_S3_ACCESS_KEY_ID,
      secretAccessKey: env.ARTIFACT_S3_SECRET_ACCESS_KEY,
      ...(env.ARTIFACT_S3_ENDPOINT ? { endpoint: env.ARTIFACT_S3_ENDPOINT } : {}),
      ...(env.ARTIFACT_S3_REGION ? { region: env.ARTIFACT_S3_REGION } : {}),
      forcePathStyle: env.ARTIFACT_S3_FORCE_PATH_STYLE !== 'false',
    });
  }
  if (env.ARTIFACT_LOCAL_DIR) return new LocalArtifactStore(env.ARTIFACT_LOCAL_DIR);
  return null;
}
