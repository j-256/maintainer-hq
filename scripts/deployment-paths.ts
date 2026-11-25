import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { lstat, mkdir } from "node:fs/promises";

const MAX_PROFILE_BYTES = 64 * 1024;
export class DeploymentPathError extends Error { readonly exitCode = 2; }

export function xdgRoot(value: string | undefined, fallback: string) {
  const root = value || fallback;
  if (!isAbsolute(root) || root.includes("\0")) throw new DeploymentPathError("XDG deployment directories must use absolute paths");
  return resolve(root);
}

export function confinedPath(directory: string, ...children: string[]) {
  const root = resolve(directory);
  const path = resolve(root, ...children);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!path.startsWith(prefix) || path === root) throw new DeploymentPathError("Deployment path is outside the selected directory");
  return path;
}

export async function profileFile(input: string) {
  if (!input || input.includes("\0")) throw new DeploymentPathError("Choose a deployment profile file");
  const parent = resolve(dirname(input));
  const path = confinedPath(parent, basename(input));
  const info = await lstat(path).catch(() => { throw new DeploymentPathError("Choose a readable regular deployment profile file"); });
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROFILE_BYTES) throw new DeploymentPathError("Deployment profiles must be bounded regular files, without symlinks");
  return path;
}

export async function privateDirectory(path: string, create = true) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw new DeploymentPathError("Deployment storage must be a private regular directory owned by the invoking user");
}
