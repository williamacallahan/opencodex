import { closeSync, openSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import type { Pointer } from "bun:ffi";

/**
 * A kernel `flock` the owner of a home's `ocx.pid` and `runtime-port.json` holds while it owns them.
 *
 * The kernel drops the lock when its holder dies, however it dies: SIGKILL, the OOM killer, a crash,
 * `docker kill`, a host reboot. So a runtime record whose writer held the lock on a filesystem whose
 * locks live in one kernel (`ownerLock: "kernel"`), read on such a filesystem while that lock is
 * free, names an owner that is gone, whatever PID number it had and whichever container or PID
 * namespace it ran in. That is the proof the PID and
 * owner-scope checks cannot give after a reboot or a recreated container, where the new process
 * often gets the very PID the stale record names. A live owner in another container on the same
 * machine still holds the lock, so its record keeps refusing a second writer.
 *
 * The lock is advisory and only as wide as the filesystem's lock domain. A free lock proves the
 * owner gone only when both the writer and the reader reached the directory through a local Linux
 * filesystem ({@link lockDomainIsKernel}), because a network or FUSE mount can confine locks to one
 * client (NFS `nolock` or `local_lock`): a hub writing over NFS from machine B holds a lock the
 * reader on the exporting machine A cannot see. macOS reports no stable filesystem type to tell the
 * two apart. Elsewhere the owner still holds the lock and stamps `ownerLock: true`, which proves a
 * live owner while the lock is held and nothing once it is free ({@link ownerLockState}).
 *
 * The owner drops the lock when it removes its own runtime record ({@link releaseOwnerLock}), so a
 * restart replacement started while the old process drains can take it.
 *
 * Linux and macOS only. Anywhere `flock` cannot be loaded or fails, the owner claims nothing and the
 * reader proves nothing, so the existing checks decide as before.
 */
const LOCK_FILE = "ocx.owner.lock";
const LOCK_EX = 2;
const LOCK_NB = 4;

/** `locked`, `contended` (another open file description holds it), or `failed` (any other error). */
type Flock = (fd: number, operation: number) => "locked" | "contended" | "failed";
let flockFn: Flock | null | undefined;

function loadFlock(): Flock | null {
  if (flockFn !== undefined) return flockFn;
  const linux = process.platform === "linux";
  const library = linux ? "libc.so.6" : process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null;
  flockFn = null;
  if (library === null) return null;
  // errno is thread-local, so it is read through the libc accessor right after the failed call.
  const errnoSymbol = linux ? "__errno_location" : "__error";
  const EWOULDBLOCK = linux ? 11 : 35;
  try {
    const { dlopen, FFIType, read } = require("bun:ffi") as typeof import("bun:ffi");
    const libc = dlopen(library, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      [errnoSymbol]: { args: [], returns: FFIType.ptr },
    });
    const errnoAt = libc.symbols[errnoSymbol] as () => Pointer | null;
    flockFn = (fd, operation) => {
      if (libc.symbols.flock(fd, operation) === 0) return "locked";
      const at = errnoAt();
      return at !== null && read.i32(at, 0) === EWOULDBLOCK ? "contended" : "failed";
    };
  } catch {
    // musl, a missing libc, or a runtime without bun:ffi: no lock evidence.
  }
  return flockFn;
}

/** Open descriptors, one per state directory, kept open while this process owns that directory's records. */
const held = new Map<string, number>();

/** Take this state directory's owner lock until {@link releaseOwnerLock} or exit; false if not held. */
export function holdOwnerLock(stateDir: string): boolean {
  const path = join(stateDir, LOCK_FILE);
  if (held.has(path)) return true;
  const flock = loadFlock();
  if (!flock) return false;
  recordOwnedConfigPath(stateDir, path);
  let fd: number;
  try { fd = openSync(path, "a", 0o600); } catch { return false; }
  if (flock(fd, LOCK_EX | LOCK_NB) !== "locked") {
    closeSync(fd);
    return false;
  }
  held.set(path, fd);
  return true;
}

/** Drop this state directory's owner lock; call only after this process's own runtime record is gone. */
export function releaseOwnerLock(stateDir: string): void {
  const path = join(stateDir, LOCK_FILE);
  const fd = held.get(path);
  if (fd === undefined) return;
  held.delete(path);
  closeSync(fd);
}

/**
 * This state directory's owner lock as a reader sees it: `held` by a live process (this one
 * included), `free` with proof that no owner holds it, or `unproved` (no `flock`, no lock file, a
 * `flock` error other than contention, or a filesystem whose locks can be local to one client). Never creates the file: a missing one proves
 * nothing, because a live owner can still hold the lock on a file someone unlinked.
 */
export function ownerLockState(stateDir: string): "held" | "free" | "unproved" {
  const flock = loadFlock();
  if (!flock) return "unproved";
  let fd: number;
  // Read-write: NFS emulates flock with byte-range locks, and an exclusive one needs write access.
  try { fd = openSync(join(stateDir, LOCK_FILE), "r+"); } catch { return "unproved"; }
  let result: ReturnType<Flock>;
  try { result = flock(fd, LOCK_EX | LOCK_NB); } finally { closeSync(fd); }
  // Only contention is evidence of a live holder; any other failure proves nothing either way.
  if (result === "contended") return "held";
  return result === "locked" && lockDomainIsKernel(stateDir) ? "free" : "unproved";
}

/** Whether this directory's filesystem keeps its locks in the one kernel that mounts it. */
export function lockDomainIsKernel(stateDir: string): boolean {
  try { return isSingleKernelLockFilesystem(process.platform, statfsSync(stateDir).type); } catch { return false; }
}

/**
 * `statfs` magic numbers of Linux filesystems whose locks live in the kernel that mounts them, so a
 * lock no process holds is free for every process that could own the directory. Network (NFS, SMB,
 * Ceph, 9p), FUSE (virtiofs, sshfs) and unknown filesystems are left out: their locks can be local
 * to one client while another client still runs the owner.
 */
const SINGLE_KERNEL_LOCK_FILESYSTEMS: ReadonlySet<number> = new Set([
  0xEF53, // ext2, ext3, ext4
  0x58465342, // xfs
  0x9123683E, // btrfs
  0x01021994, // tmpfs
  0x858458F6, // ramfs
  0x794C7630, // overlayfs
  0x2FC12FC1, // zfs
  0xF2F52010, // f2fs
  0xCA451A4E, // bcachefs
]);

/** Whether a filesystem of this `statfs` type keeps its locks in one kernel. */
export function isSingleKernelLockFilesystem(platform: NodeJS.Platform, filesystemType: number): boolean {
  // Node reports the magic as a signed 32-bit number (btrfs reads -0x6EDC97C2).
  return platform === "linux" && SINGLE_KERNEL_LOCK_FILESYSTEMS.has(filesystemType >>> 0);
}
