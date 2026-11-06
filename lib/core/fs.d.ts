/**
 * Small filesystem helpers shared by the state layer and the local applier.
 *
 * Every write this plugin performs into the DSH home is atomic (temp file +
 * rename) and private (`0600` files, `0700` directories): a half-written patch
 * file would break the Loader at the next boot, and this plugin stores paths
 * and credentials that no other local user should read.
 * @module core/fs
 */
/** Read a UTF-8 file, returning null when it does not exist or cannot be read. */
export declare function readTextFile(path: string): Promise<string | null>;
/** Whether a path exists. */
export declare function pathExists(path: string): Promise<boolean>;
/** Create a directory tree with private permissions. */
export declare function ensurePrivateDir(path: string): Promise<void>;
/** Write a UTF-8 file atomically with private permissions. */
export declare function writePrivateFile(path: string, content: string): Promise<void>;
/** Write a file only when its content differs; returns whether it changed. */
export declare function writeFileIfChanged(path: string, content: string): Promise<boolean>;
/** Remove a file, ignoring a missing target. */
export declare function removeFile(path: string): Promise<void>;
/** List a directory's entry names, returning [] when it is missing. */
export declare function listDirectory(path: string): Promise<string[]>;
/** Write bytes to a path, creating parent directories (used for work trees). */
export declare function writeBytes(path: string, data: Uint8Array): Promise<void>;
