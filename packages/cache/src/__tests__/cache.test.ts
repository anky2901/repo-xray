import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FileCache } from '../index';

const testCacheDir = path.join(__dirname, 'test-cache-dir');

describe('FileCache eviction and disk management', () => {
  beforeEach(async () => {
    if (fs.existsSync(testCacheDir)) {
      await fs.promises.rm(testCacheDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (fs.existsSync(testCacheDir)) {
      await fs.promises.rm(testCacheDir, { recursive: true, force: true });
    }
  });

  it('should save and load entries from cache', async () => {
    const cache = new FileCache(testCacheDir);
    await cache.set('key1', 'val1');

    const entry = await cache.get('key1');
    expect(entry).not.toBeNull();
    expect(entry?.value).toBe('val1');
  });

  it('should expire entries based on TTL', async () => {
    const cache = new FileCache(testCacheDir);
    await cache.set('key1', 'val1', 5); // 5ms TTL

    await new Promise((resolve) => setTimeout(resolve, 10));

    const entry = await cache.get('key1');
    expect(entry).toBeNull();
  });

  it('should evict from memory and delete from disk when memory limit exceeded', async () => {
    const cache = new FileCache(testCacheDir, { maxSize: 50 });

    await cache.set('k1', 'a'.repeat(40));
    await cache.set('k2', 'b'.repeat(40));

    const files = await fs.promises.readdir(testCacheDir);
    expect(files.length).toBeLessThanOrEqual(1);

    const k1 = await cache.get('k1');
    expect(k1).toBeNull();
  });

  it('should clean up expired files on startup', async () => {
    const cacheDir = testCacheDir;
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const safeKey = '5573c042b4742a98f121d960f4a868e820f4c0f8623b0365773950ef550f75e2';
    const filePath = path.join(cacheDir, `${safeKey}.json`);
    const expiredEntry = {
      key: 'key1',
      value: 'val1',
      hash: 'xxx',
      createdAt: new Date(Date.now() - 10000).toISOString(),
      expiresAt: new Date(Date.now() - 5000).toISOString()
    };
    await fs.promises.writeFile(filePath, JSON.stringify(expiredEntry), 'utf-8');

    const cache = new FileCache(testCacheDir);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entry = await cache.get('key1');
    expect(entry).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('should compute correct disk usage and enforce quota limits on disk', async () => {
    const cache = new FileCache(testCacheDir, { maxSize: 250 });

    await cache.set('k1', 'a'.repeat(60));
    await cache.set('k2', 'b'.repeat(60));
    await cache.set('k3', 'c'.repeat(60));

    const usage = await cache.getDiskUsage();
    expect(usage).toBeLessThanOrEqual(250);
  });
  it('should remove pruned entries from the memory cache to keep in sync', async () => {
    const cache = new FileCache(testCacheDir, { maxSize: 500 });

    await cache.set('k1', 'value1');
    await cache.set('k2', 'value2');

    expect(await cache.get('k1')).not.toBeNull();

    await cache.set('k3', 'a'.repeat(300));

    const k1 = await cache.get('k1');
    expect(k1).toBeNull();
  });

  it('should clean up orphan files of various kinds', async () => {
    const cache = new FileCache(testCacheDir);

    await cache.set('valid-key', 'valid-val');

    await fs.promises.writeFile(path.join(testCacheDir, 'not-json.txt'), 'hello', 'utf-8');
    await fs.promises.writeFile(path.join(testCacheDir, 'short.json'), '{}', 'utf-8');
    const fakeSha = 'a'.repeat(64);
    await fs.promises.writeFile(path.join(testCacheDir, `${fakeSha}.json`), '{invalid', 'utf-8');
    const fakeSha2 = 'b'.repeat(64);
    await fs.promises.writeFile(path.join(testCacheDir, `${fakeSha2}.json`), '{"not-key":"value"}', 'utf-8');
    const fakeSha3 = 'c'.repeat(64);
    await fs.promises.writeFile(path.join(testCacheDir, `${fakeSha3}.json`), '{"key":"actual-key-that-does-not-hash-to-c","value":"val"}', 'utf-8');

    await cache.orphanCleanup();

    const files = await fs.promises.readdir(testCacheDir);
    expect(files.length).toBe(1);
    
    const validEntry = await cache.get('valid-key');
    expect(validEntry).not.toBeNull();
    expect(validEntry?.value).toBe('valid-val');
  });
});
