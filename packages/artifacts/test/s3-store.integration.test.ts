import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { startMinio, type StartedMinio } from '@reviewbot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ArtifactStore } from '../src/index.js';

const BUCKET = 'reviewbot-artifacts';

describe('S3ArtifactStore', () => {
  let minio: StartedMinio;
  let store: S3ArtifactStore;

  beforeAll(async () => {
    minio = await startMinio();
    // MinIO does not create buckets automatically.
    const admin = new S3Client({
      region: 'us-east-1',
      endpoint: minio.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: minio.accessKeyId, secretAccessKey: minio.secretAccessKey },
    });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    store = new S3ArtifactStore({
      bucket: BUCKET,
      endpoint: minio.endpoint,
      accessKeyId: minio.accessKeyId,
      secretAccessKey: minio.secretAccessKey,
      forcePathStyle: true,
    });
  }, 120_000);

  afterAll(async () => {
    await minio?.stop();
  });

  it('put → get 往返(内容一致)', async () => {
    const key = 'tenant-1/patch/abc';
    const content = Buffer.from('diff --git a/x b/x\n@@ boom @@', 'utf8');
    await store.put(key, content);
    const got = await store.get(key);
    expect(got.equals(content)).toBe(true);
  });

  it('二进制内容无损', async () => {
    const key = 'tenant-1/blob/bin';
    const content = Buffer.from([0, 1, 2, 255, 254, 128, 64]);
    await store.put(key, content);
    expect((await store.get(key)).equals(content)).toBe(true);
  });

  it('delete 后 get 抛错', async () => {
    const key = 'tenant-1/patch/del';
    await store.put(key, Buffer.from('x'));
    await store.delete(key);
    await expect(store.get(key)).rejects.toThrow();
  });
});
