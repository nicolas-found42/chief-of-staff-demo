import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode a 48-bit timestamp and 80 bits of entropy as a 26-char ULID. */
export function encodeUlid(timeMs: number, entropy: Uint8Array): string {
  const timePart = timeMs % 2 ** 48;
  let out = "";
  // 10 chars of time (48 bits, 5 bits per char, top 2 bits dropped)
  for (let i = 9; i >= 0; i--) {
    out += CROCKFORD[Math.floor(timePart / 32 ** i) % 32];
  }
  // 16 chars of entropy (80 bits)
  for (let i = 0; i < 16; i++) {
    out += CROCKFORD[entropy[i] % 32];
  }
  return out;
}

/** Build a deterministic, ULID-shaped 26-char id from arbitrary seed bytes. */
export function encodeDeterministicUlid(seedBytes: Uint8Array): string {
  const chars: number[] = [];
  let acc = 0;
  let accBits = 0;
  for (const byte of seedBytes) {
    acc = acc * 256 + byte;
    accBits += 8;
    while (accBits >= 5) {
      accBits -= 5;
      chars.push(Math.floor(acc / 2 ** accBits) % 32);
      acc = acc % 2 ** accBits;
    }
    if (chars.length >= 26) {
      return chars.slice(0, 26).map((c) => CROCKFORD[c]).join("");
    }
  }
  while (chars.length < 26) {
    chars.push(0);
  }
  return chars.map((c) => CROCKFORD[c]).join("");
}

export function sha256Digest(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text, "utf8").digest());
}

export interface IdGenerator {
  /** Fresh run id: random ULID in live mode, seeded ULID in tests. */
  runId(): string;
  /** Fresh random token (session tokens, pairing codes). */
  randomToken(bytes?: number): string;
  /** Deterministic artifact id from runId, stepId, and taskIndex. */
  artifactId(runId: string, stepId: string, taskIndex: number | null): string;
  /** Deterministic invocation id from runId, stepId, taskIndex, attempt. */
  invocationId(runId: string, stepId: string, taskIndex: number | null, attempt: number): string;
  /** Deterministic tracking row id from runId and taskIndex. */
  rowId(runId: string, taskIndex: number): string;
}

function cryptoEntropy(bytes: number): Uint8Array {
  return new Uint8Array(randomBytes(bytes));
}

/** Live generator: ULID timestamps from the wall clock, entropy from crypto. */
export function createLiveIdGenerator(now: () => number = Date.now): IdGenerator {
  return {
    runId() {
      return encodeUlid(now(), cryptoEntropy(16));
    },
    randomToken(bytes = 32) {
      return randomBytes(bytes).toString("base64url");
    },
    artifactId(runId, stepId, taskIndex) {
      return encodeDeterministicUlid(
        sha256Digest(`artifact:${runId}:${stepId}:${taskIndex ?? "main"}`)
      );
    },
    invocationId(runId, stepId, taskIndex, attempt) {
      return encodeDeterministicUlid(
        sha256Digest(`invocation:${runId}:${stepId}:${taskIndex ?? "main"}:${attempt}`)
      );
    },
    rowId(runId, taskIndex) {
      return `${runId}:${String(taskIndex).padStart(4, "0")}`;
    },
  };
}

/**
 * Deterministic generator for tests: every id derives from the injected seed
 * and a monotonic counter, so identical runs produce identical ids.
 */
export function createDeterministicIdGenerator(seed: string): IdGenerator {
  let counter = 0;
  const next = (label: string): string => {
    counter += 1;
    return encodeDeterministicUlid(sha256Digest(`seed:${seed}:${label}:${counter}`));
  };
  return {
    runId() {
      return next("run");
    },
    randomToken(bytes = 32) {
      counter += 1;
      const digest = sha256Digest(`seed:${seed}:token:${counter}`);
      const out = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i++) {
        out[i] = digest[i % digest.length];
      }
      return out.toString("base64url");
    },
    artifactId(runId, stepId, taskIndex) {
      return encodeDeterministicUlid(
        sha256Digest(`artifact:${runId}:${stepId}:${taskIndex ?? "main"}`)
      );
    },
    invocationId(runId, stepId, taskIndex, attempt) {
      return encodeDeterministicUlid(
        sha256Digest(`invocation:${runId}:${stepId}:${taskIndex ?? "main"}:${attempt}`)
      );
    },
    rowId(runId, taskIndex) {
      return `${runId}:${String(taskIndex).padStart(4, "0")}`;
    },
  };
}
