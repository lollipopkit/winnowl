import { describe, expect, it } from 'vitest';
import { LocalArtifactStore, S3ArtifactStore, artifactStoreFromEnv } from '../src/index.js';

describe('artifactStoreFromEnv(§42/§6.1 env → 对象存储)', () => {
  it('S3 三要素齐全 → S3ArtifactStore(MinIO/S3)', () => {
    const store = artifactStoreFromEnv({
      ARTIFACT_S3_BUCKET: 'reviewbot-artifacts',
      ARTIFACT_S3_ACCESS_KEY_ID: 'minio',
      ARTIFACT_S3_SECRET_ACCESS_KEY: 'minio123',
      ARTIFACT_S3_ENDPOINT: 'http://minio:9000',
    } as NodeJS.ProcessEnv);
    expect(store).toBeInstanceOf(S3ArtifactStore);
  });

  it('无 S3 但本地目录 → LocalArtifactStore', () => {
    const store = artifactStoreFromEnv({ ARTIFACT_LOCAL_DIR: '/tmp/art' } as NodeJS.ProcessEnv);
    expect(store).toBeInstanceOf(LocalArtifactStore);
  });

  it('S3 优先于本地目录', () => {
    const store = artifactStoreFromEnv({
      ARTIFACT_S3_BUCKET: 'b',
      ARTIFACT_S3_ACCESS_KEY_ID: 'a',
      ARTIFACT_S3_SECRET_ACCESS_KEY: 's',
      ARTIFACT_LOCAL_DIR: '/tmp/art',
    } as NodeJS.ProcessEnv);
    expect(store).toBeInstanceOf(S3ArtifactStore);
  });

  it('S3 缺 secret(不完整)→ 不构造 S3,回退本地/ null', () => {
    expect(
      artifactStoreFromEnv({ ARTIFACT_S3_BUCKET: 'b', ARTIFACT_S3_ACCESS_KEY_ID: 'a' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('无任何配置 → null', () => {
    expect(artifactStoreFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
