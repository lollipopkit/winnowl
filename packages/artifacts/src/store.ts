import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface ArtifactStore {
  put(key: string, content: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Dev/test store; keys cannot escape baseDir. */
export class LocalArtifactStore implements ArtifactStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  private pathFor(key: string): string {
    const full = resolve(join(this.baseDir, key));
    if (full !== this.baseDir && !full.startsWith(this.baseDir + '/')) {
      throw new Error(`非法 artifact key: ${key}`);
    }
    return full;
  }

  async put(key: string, content: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
