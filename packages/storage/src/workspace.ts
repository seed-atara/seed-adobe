import { mkdir } from "node:fs/promises";
import path from "node:path";
import { SeedError } from "@seed-ae/domain";

/**
 * On-disk layout for one SEED workspace, as described in
 * docs/architecture/OVERVIEW.md. Everything SEED owns lives under `.seed-ae/`
 * so a project folder stays recognisable to the artist.
 */
export interface WorkspaceLayout {
  /** Directory containing `.seed-ae` (usually the AE project folder). */
  projectRoot: string;
  /** The `.seed-ae` directory itself. */
  root: string;
  databasePath: string;
  assetsDir: string;
  originalsDir: string;
  generatedDir: string;
  proxiesDir: string;
  thumbnailsDir: string;
  /** Scratch stills that are not library media — see `samplesDir` below. */
  samplesDir: string;
  manifestsDir: string;
}

export const WORKSPACE_DIR_NAME = ".seed-ae";
export const DATABASE_FILE_NAME = "seed-ae.sqlite";

export function resolveWorkspace(projectRoot: string): WorkspaceLayout {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const root = path.join(absoluteProjectRoot, WORKSPACE_DIR_NAME);
  const assetsDir = path.join(root, "assets");
  return {
    projectRoot: absoluteProjectRoot,
    root,
    databasePath: path.join(root, DATABASE_FILE_NAME),
    assetsDir,
    originalsDir: path.join(assetsDir, "originals"),
    generatedDir: path.join(assetsDir, "generated"),
    proxiesDir: path.join(assetsDir, "proxies"),
    thumbnailsDir: path.join(assetsDir, "thumbnails"),
    /*
     * Frames sampled off a shot to measure it — the expansion tracker's input.
     *
     * Deliberately *not* under `assets/`, because they are not assets. A dozen
     * stills per attempt registered as library media buries the actual work
     * under intermediates nobody asked for and nobody will ever open. They are
     * scratch: written, read once, and replaced by the next sample.
     */
    samplesDir: path.join(root, "samples"),
    manifestsDir: path.join(root, "manifests"),
  };
}

export async function ensureWorkspace(
  layout: WorkspaceLayout,
): Promise<WorkspaceLayout> {
  for (const dir of [
    layout.root,
    layout.assetsDir,
    layout.originalsDir,
    layout.generatedDir,
    layout.proxiesDir,
    layout.thumbnailsDir,
    layout.samplesDir,
    layout.manifestsDir,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  return layout;
}

/**
 * Storage URIs are workspace-relative POSIX paths (`assets/originals/x.png`).
 * Relative + POSIX keeps a project portable between machines and survives
 * folder names containing spaces; absolute Windows paths do neither.
 */
export function toStorageUri(
  layout: WorkspaceLayout,
  absolutePath: string,
): string {
  const relative = path.relative(layout.root, path.resolve(absolutePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SeedError(
      "bad_request",
      "path is outside the SEED workspace",
      { details: { absolutePath } },
    );
  }
  return relative.split(path.sep).join("/");
}

/**
 * Resolve a storage URI back to an absolute path, refusing anything that
 * escapes the workspace (`..`, absolute paths, drive-relative paths).
 */
export function resolveStorageUri(
  layout: WorkspaceLayout,
  storageUri: string,
): string {
  if (storageUri.length === 0) {
    throw new SeedError("bad_request", "storage URI is empty");
  }
  if (path.isAbsolute(storageUri) || /^[a-zA-Z]:/.test(storageUri)) {
    throw new SeedError("bad_request", "storage URI must be workspace-relative", {
      details: { storageUri },
    });
  }
  const absolute = path.resolve(layout.root, storageUri);
  const relative = path.relative(layout.root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SeedError("bad_request", "storage URI escapes the workspace", {
      details: { storageUri },
    });
  }
  return absolute;
}
