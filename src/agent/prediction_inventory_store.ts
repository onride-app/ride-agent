import { constants } from "node:fs";
import { open, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

// Local operator-owned storage. The separate 0600 key authenticates producer
// checkpoints; an imported JSON file/third-party indexer flag is never a proof.
export class InventoryStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class InventoryFileStore<T extends { revision: number }> {
  constructor(private path: string) {}
  private async privateRead(path: string): Promise<string | null> {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw new InventoryStoreError("CHECKPOINT_FILE_UNSAFE");
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.size > MAX_CHECKPOINT_BYTES
      )
        throw new InventoryStoreError("CHECKPOINT_FILE_UNSAFE");
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  }
  private async key(create: boolean): Promise<Buffer> {
    let key = await this.privateRead(this.path + ".key");
    if (key === null && create) {
      const file = await open(this.path + ".key", "wx", 0o600);
      try {
        key = randomBytes(32).toString("hex");
        await file.writeFile(key);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    if (!key || !/^[a-f0-9]{64}$/.test(key))
      throw new InventoryStoreError("CHECKPOINT_KEY_UNAVAILABLE");
    return Buffer.from(key, "hex");
  }
  private async load(key: Buffer): Promise<T | null> {
    const raw = await this.privateRead(this.path);
    if (raw === null) return null;
    try {
      const envelope = JSON.parse(raw);
      if (
        typeof envelope.payload !== "string" ||
        !/^[a-f0-9]{64}$/.test(envelope.mac)
      )
        throw 0;
      const mac = createHmac("sha256", key).update(envelope.payload).digest();
      if (!timingSafeEqual(mac, Buffer.from(envelope.mac, "hex"))) throw 0;
      return JSON.parse(envelope.payload) as T;
    } catch {
      throw new InventoryStoreError("CHECKPOINT_UNTRUSTED");
    }
  }
  async read(): Promise<T | null> {
    // Never manufacture a new signing key for an existing checkpoint.
    if ((await this.privateRead(this.path)) === null) return null;
    return this.load(await this.key(false));
  }
  async transaction(update: (value: T | null) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    let lock;
    try {
      lock = await open(this.path + ".lock", "wx", 0o600);
    } catch {
      throw new InventoryStoreError("CHECKPOINT_BUSY");
    }
    let temp: string | null = null;
    try {
      // A crash leaves a lock. It is intentionally never expired automatically.
      await lock.writeFile(String(process.pid));
      await lock.sync();
      const exists = await this.privateRead(this.path);
      const key = await this.key(exists === null);
      const previous = await this.load(key),
        snapshot = JSON.stringify(previous),
        revision = previous?.revision ?? 0;
      const next = await update(previous);
      if (
        !Number.isSafeInteger(next.revision) ||
        next.revision !== revision + 1
      )
        throw new InventoryStoreError("CHECKPOINT_REVISION_INVALID");
      if (JSON.stringify(await this.load(key)) !== snapshot)
        throw new InventoryStoreError("CHECKPOINT_CAS_FAILED");
      const payload = JSON.stringify(next),
        envelope = JSON.stringify({
          payload,
          mac: createHmac("sha256", key).update(payload).digest("hex"),
        });
      if (Buffer.byteLength(envelope) > MAX_CHECKPOINT_BYTES)
        throw new InventoryStoreError("CHECKPOINT_SIZE_CAP");
      temp = this.path + ".tmp-" + randomBytes(12).toString("hex");
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(envelope);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.path);
      temp = null;
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return next;
    } finally {
      if (temp) await unlink(temp).catch(() => {});
      await lock.close();
      await unlink(this.path + ".lock");
    }
  }
}
