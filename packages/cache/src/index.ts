import { LRUCache } from 'lru-cache';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CacheStore, CacheEntry } from '@repo-xray/types';
export type { CacheStore, CacheEntry };

export class FileCache implements CacheStore {
  private cache: LRUCache<string, CacheEntry>;
  private dir: string;
  private maxDiskSize: number;
  private approxDiskBytes = 0;
  private diskBytesInitialized = false;

  constructor(dir: string = '.xray-cache', options?: { maxSize?: number }) {
    this.dir = dir;
    this.maxDiskSize = options?.maxSize || 1024 * 1024 * 1024;
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }

    this.cache = new LRUCache<string, CacheEntry>({
      maxSize: this.maxDiskSize,
      sizeCalculation: (value, key) => {
        return Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key);
      },
      dispose: (_value, key, reason) => {
        if (reason === 'evict' && typeof key === 'string') {
          const filePath = this.getFilePath(key);
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
            } catch {}
          }
        }
      }
    });

    this.startupCleanup().catch(() => {});
  }

  async getDiskUsage(): Promise<number> {
    let total = 0;
    try {
      if (!fs.existsSync(this.dir)) return 0;
      const files = await fs.promises.readdir(this.dir);
      for (const file of files) {
        const filePath = path.join(this.dir, file);
        const stat = await fs.promises.stat(filePath);
        total += stat.size;
      }
    } catch {}
    return total;
  }

  async pruneDiskCache(): Promise<void> {
    try {
      if (!fs.existsSync(this.dir)) return;
      const files = await fs.promises.readdir(this.dir);
      const fileInfos: { name: string; mtime: Date; size: number }[] = [];
      let totalSize = 0;

      for (const file of files) {
        const filePath = path.join(this.dir, file);
        const stat = await fs.promises.stat(filePath);
        fileInfos.push({ name: file, mtime: stat.mtime, size: stat.size });
        totalSize += stat.size;
      }

      fileInfos.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

      while (totalSize > this.maxDiskSize && fileInfos.length > 0) {
        const oldest = fileInfos.shift()!;
        const filePath = path.join(this.dir, oldest.name);
        if (fs.existsSync(filePath)) {
          try {
            const data = await fs.promises.readFile(filePath, 'utf-8');
            const entry: CacheEntry = JSON.parse(data);
            if (entry && entry.key) {
              this.cache.delete(entry.key);
            }
          } catch {}
          await fs.promises.unlink(filePath);
        }
        totalSize -= oldest.size;
      }
    } catch {}
  }

  async orphanCleanup(): Promise<void> {
    try {
      if (!fs.existsSync(this.dir)) return;
      const files = await fs.promises.readdir(this.dir);
      for (const file of files) {
        const filePath = path.join(this.dir, file);
        const ext = path.extname(file);
        const nameWithoutExt = path.basename(file, ext);

        if (ext !== '.json') {
          await fs.promises.unlink(filePath);
          continue;
        }

        if (!/^[a-f0-9]{64}$/i.test(nameWithoutExt)) {
          await fs.promises.unlink(filePath);
          continue;
        }

        try {
          const data = await fs.promises.readFile(filePath, 'utf-8');
          const entry: CacheEntry = JSON.parse(data);

          if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string') {
            await fs.promises.unlink(filePath);
            continue;
          }

          const expectedName = crypto.createHash('sha256').update(entry.key).digest('hex');
          if (nameWithoutExt.toLowerCase() !== expectedName.toLowerCase()) {
            await fs.promises.unlink(filePath);
            continue;
          }
        } catch {
          await fs.promises.unlink(filePath);
        }
      }
    } catch {}
  }

  async startupCleanup(): Promise<void> {
    try {
      await this.orphanCleanup();
      if (!fs.existsSync(this.dir)) return;
      const files = await fs.promises.readdir(this.dir);
      for (const file of files) {
        const filePath = path.join(this.dir, file);
        try {
          const data = await fs.promises.readFile(filePath, 'utf-8');
          const entry: CacheEntry = JSON.parse(data);
          if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
            await fs.promises.unlink(filePath);
          }
        } catch {
          await fs.promises.unlink(filePath);
        }
      }
      await this.pruneDiskCache();
    } catch {}
  }

  private getFilePath(key: string): string {
    const safeKey = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.dir, `${safeKey}.json`);
  }

  async get(key: string): Promise<CacheEntry | null> {
    const mem = this.cache.get(key);
    if (mem) {
      if (mem.expiresAt && new Date(mem.expiresAt) < new Date()) {
        await this.invalidate(key);
        return null;
      }
      return mem;
    }

    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) return null;

    try {
      const data = await fs.promises.readFile(filePath, 'utf-8');
      const entry: CacheEntry = JSON.parse(data);
      if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
        await this.invalidate(key);
        return null;
      }
      this.cache.set(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const hash = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const now = new Date();
    const entry: CacheEntry = {
      key,
      value,
      hash,
      createdAt: now.toISOString(),
      expiresAt: ttl ? new Date(now.getTime() + ttl).toISOString() : undefined,
    };

    this.cache.set(key, entry);
    const filePath = this.getFilePath(key);
    const serialized = JSON.stringify(entry);
    await fs.promises.writeFile(filePath, serialized, 'utf-8');

    // Pruning scans the whole cache dir, so amortize it: only prune when the
    // running on-disk estimate could exceed the limit.
    if (!this.diskBytesInitialized) {
      this.approxDiskBytes = await this.getDiskUsage();
      this.diskBytesInitialized = true;
    } else {
      this.approxDiskBytes += Buffer.byteLength(serialized);
    }

    if (this.approxDiskBytes > this.maxDiskSize) {
      await this.pruneDiskCache();
      this.approxDiskBytes = await this.getDiskUsage();
    }
  }

  async invalidate(key: string): Promise<void> {
    this.cache.delete(key);
    const filePath = this.getFilePath(key);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  async clear(): Promise<void> {
    this.cache.clear();
    if (fs.existsSync(this.dir)) {
      const files = await fs.promises.readdir(this.dir);
      for (const file of files) {
        await fs.promises.unlink(path.join(this.dir, file));
      }
    }
  }
}
