import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nativeNotePath } from "../../../src/services/nativeNoteMoveContract.js";
import { NOTE_CREATE_MAX_BYTES, noteCreateHash } from "../../../src/services/noteCreateContract.js";

export class NoteCreateExists extends Error {}

/** Local filesystem only. Parent directories must already exist and remain ordinary. */
export class ExclusiveNoteCreateFiles {
  private readonly root: string;
  constructor(private readonly configuredRoot: string) { this.root = realpathSync(configuredRoot); }
  private location(logical: string): string {
    nativeNotePath(logical);
    if (realpathSync(this.configuredRoot) !== this.root) throw new Error("create_root_changed");
    const parts = logical.split("/");
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) {
        throw new Error("create_parent_unsupported");
      }
    }
    return path.join(current, parts.at(-1)!);
  }
  inspect(logical: string): { exists: false } | { exists: true; content: string; sha256: string } {
    const filename = this.location(logical);
    let stat;
    try { stat = lstatSync(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > NOTE_CREATE_MAX_BYTES) throw new Error("create_target_unsupported");
    const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd);
      if (before.dev !== stat.dev || before.ino !== stat.ino || before.size > NOTE_CREATE_MAX_BYTES) throw new Error("create_target_changed");
      const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(filename);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.dev !== after.dev || current.ino !== after.ino ||
          current.isSymbolicLink() || after.nlink !== 1 || bytes.length > NOTE_CREATE_MAX_BYTES) throw new Error("create_target_changed");
      const content = bytes.toString("utf8");
      if (!bytes.equals(Buffer.from(content, "utf8"))) throw new Error("create_encoding_unsupported");
      return { exists: true, content, sha256: noteCreateHash(content) };
    } finally { closeSync(fd); }
  }
  create(logical: string, content: string): { sha256: string } {
    if (Buffer.byteLength(content, "utf8") > NOTE_CREATE_MAX_BYTES) throw new Error("create_size_limit");
    const filename = this.location(logical);
    let fd: number;
    try { fd = openSync(filename, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new NoteCreateExists(); throw error; }
    // No await between exclusive creation and data fsync: the Obsidian event loop sees complete bytes.
    // A process/OS failure can still leave a partial new file; never overwrite/delete it as recovery.
    try {
      writeFileSync(fd, content, { encoding: "utf8" });
      fsyncSync(fd);
      const stat = fstatSync(fd);
      if (stat.nlink !== 1 || stat.size !== Buffer.byteLength(content, "utf8")) throw new Error("create_effect_unproven");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw new Error("create_effect_unproven");
        offset += count;
      }
      if (!bytes.equals(Buffer.from(content, "utf8"))) throw new Error("create_effect_unproven");
      const current = lstatSync(filename);
      if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("create_effect_unproven");
      return { sha256: noteCreateHash(content) };
    } finally { closeSync(fd); }
  }
}
