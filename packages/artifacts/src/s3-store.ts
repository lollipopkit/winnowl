import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ArtifactStore } from './store.js';

export interface S3ArtifactStoreOptions {
  bucket: string;
  /** Default us-east-1 (ignored by MinIO). */
  region?: string;
  /** Omitted: AWS. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most self-hosted stores need path-style; default true. */
  forcePathStyle?: boolean;
}

export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3ArtifactStoreOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region ?? 'us-east-1',
      forcePathStyle: opts.forcePathStyle ?? true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    });
  }

  async put(key: string, content: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: content }));
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`artifact 无内容: ${key}`);
    // Reading fully is fine: artifacts are size-capped.
    const bytes = await (res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
