// File-backed voucher ledger: one bare AllocationLedgerRow[] JSON file per
// offering at <dir>/<chainId>/<offering>.json, byte-compatible with the
// browser's localStorage value so the existing voucher.ts helpers run
// unchanged over it. Writes merge with what is on disk (union by
// allocationId, revokedAt wins) so a second process never drops a revocation.
import fs from "node:fs";
import path from "node:path";

import type {
  AllocationLedgerRow,
  KVStorage,
} from "splits-pact/lib/chain/voucher.ts";

const KEY_PREFIX = "pact:allocations:";

export function mergeLedgerRows(
  ...sets: AllocationLedgerRow[][]
): AllocationLedgerRow[] {
  const byId = new Map<string, AllocationLedgerRow>();
  for (const row of sets.flat()) {
    const existing = byId.get(row.allocationId);
    if (!existing) {
      byId.set(row.allocationId, row);
      continue;
    }
    const revokedAt = existing.revokedAt ?? row.revokedAt;
    byId.set(row.allocationId, {
      ...existing,
      ...row,
      ...(revokedAt != null ? { revokedAt } : {}),
    });
  }
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function fileLedgerStorage(dir: string, chainId: number): KVStorage {
  const fileFor = (key: string) =>
    path.join(dir, String(chainId), key.slice(KEY_PREFIX.length) + ".json");
  const readRows = (file: string): AllocationLedgerRow[] => {
    try {
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };
  return {
    getItem(key) {
      if (!key.startsWith(KEY_PREFIX)) return null;
      const file = fileFor(key);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    },
    setItem(key, value) {
      if (!key.startsWith(KEY_PREFIX)) return;
      const file = fileFor(key);
      const merged = mergeLedgerRows(readRows(file), JSON.parse(value));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
    },
  };
}
