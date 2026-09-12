import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { writeTextAtomically } from "../contestants/support.js";
import {
  buildGallery,
  PublicMetadataSchema,
  sourceGenerationIdentity,
} from "../gallery/builder.js";
import {
  ManifestSchema,
  SnapshotSchema,
  StaticSiteCatalogSchema,
  readJsonWithSchema,
  type StaticSiteCatalogGeneration,
} from "../schemas/index.js";

export interface ExportGenerationToStaticSiteOptions {
  readonly repositoryRoot: string;
  readonly generationPath: string;
  readonly siteRoot: string;
  readonly replaceExisting?: boolean;
}

export interface ExportedStaticGeneration {
  readonly seasonId: string;
  readonly generationId: string;
  readonly publicPath: string;
  readonly sourceIdentity: string;
  readonly replacedSourceIdentity?: string;
}

async function publicationExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNestedPath(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

const ALLOWED_PUBLICATION_PATHS = [
  /^(?:\.nojekyll|CNAME|README\.md|catalog\.json|index\.html)$/u,
  /^(?:LICENSE|NOTICE)(?:\.md|\.txt)?$/u,
  /^seasons$/u,
  /^seasons\/\d{4}$/u,
  /^seasons\/\d{4}\/\d{4}$/u,
  /^seasons\/\d{4}\/\d{4}\/(?:champion\.css|gallery-layout\.css|gallery-screenshot\.png|gallery-viewport\.png|index\.html|metadata\.json)$/u,
  /^seasons\/\d{4}\/\d{4}\/screenshots$/u,
  /^seasons\/\d{4}\/\d{4}\/screenshots\/entry-\d{3}(?:-full)?\.png$/u,
  /^seasons\/\d{4}\/\d{4}\/fonts$/u,
  /^seasons\/\d{4}\/\d{4}\/fonts\/(?:[a-z0-9.-]+\.ttf|OFL-[a-z0-9.-]+\.txt)$/iu,
  /^seasons\/\d{4}\/\d{4}\/designs$/u,
  /^seasons\/\d{4}\/\d{4}\/designs\/[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  /^seasons\/\d{4}\/\d{4}\/designs\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:index\.html|submission\.css)$/u,
  /^seasons\/\d{4}\/\d{4}\/designs\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:fonts|thumbnails)$/u,
  /^seasons\/\d{4}\/\d{4}\/designs\/[a-z0-9]+(?:-[a-z0-9]+)*\/fonts\/(?:[a-z0-9.-]+\.ttf|OFL-[a-z0-9.-]+\.txt)$/iu,
  /^seasons\/\d{4}\/\d{4}\/designs\/[a-z0-9]+(?:-[a-z0-9]+)*\/thumbnails\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/u,
] as const;

async function auditPublicationTree(siteRoot: string): Promise<void> {
  async function visit(root: string, prefix = ""): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (relativePath === ".git") continue;
      if (!ALLOWED_PUBLICATION_PATHS.some((pattern) => pattern.test(relativePath))) {
        throw new Error(`unexpected publication path: ${relativePath}`);
      }
      const absolutePath = join(root, entry.name);
      const status = await lstat(absolutePath);
      if (status.isSymbolicLink()) {
        throw new Error(`publication path must not be a symlink: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (!entry.isFile() || status.nlink !== 1) {
        throw new Error(
          `publication path must be a regular unlinked file: ${relativePath}`,
        );
      }
    }
  }
  await visit(siteRoot);
}

async function canonicalDirectory(path: string, description: string): Promise<string> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`${description} must not be a symlink`);
  if (!status.isDirectory()) throw new Error(`${description} must be a directory`);
  return realpath(path);
}

async function buildCatalog(
  siteRoot: string,
): Promise<readonly StaticSiteCatalogGeneration[]> {
  const seasonsRoot = join(siteRoot, "seasons");
  const generations: StaticSiteCatalogGeneration[] = [];
  const seasons = await readdir(seasonsRoot, { withFileTypes: true });
  for (const season of seasons.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (season.isSymbolicLink())
      throw new Error("publication seasons must not be symlinks");
    if (!season.isDirectory() || !/^\d{4}$/u.test(season.name)) continue;
    const seasonRoot = join(seasonsRoot, season.name);
    const seasonStatus = await lstat(seasonRoot);
    if (seasonStatus.isSymbolicLink())
      throw new Error("publication seasons must not be symlinks");
    const entries = await readdir(seasonRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink()) {
        throw new Error("published generations must not be symlinks");
      }
      if (!entry.isDirectory() || !/^\d{4}$/u.test(entry.name)) continue;
      const generationRoot = join(seasonRoot, entry.name);
      const generationStatus = await lstat(generationRoot);
      if (generationStatus.isSymbolicLink()) {
        throw new Error("published generations must not be symlinks");
      }
      const metadata = await readJsonWithSchema(
        join(generationRoot, "metadata.json"),
        PublicMetadataSchema,
      );
      if (metadata.seasonId !== season.name || metadata.generationId !== entry.name) {
        throw new Error("published metadata does not match its catalog path");
      }
      generations.push({
        seasonId: season.name,
        generationId: entry.name,
        path: `seasons/${season.name}/${entry.name}/index.html`,
      });
    }
  }
  return generations;
}

function renderSiteIndex(generations: readonly StaticSiteCatalogGeneration[]): string {
  const items = generations
    .map(
      (entry) =>
        `<li><a href="${entry.path}">Season ${entry.seasonId.slice(-3)} · Generation ${entry.generationId}</a></li>`,
    )
    .join("\n        ");
  return `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'">
    <meta name="referrer" content="no-referrer">
    <title>Cascade League seasons</title>
    <style>body{max-width:54rem;margin:0 auto;padding:3rem 1.25rem;background:#11120f;color:#f1f2e9;font:1rem/1.5 system-ui,sans-serif}h1{font-size:clamp(2.5rem,8vw,5rem);line-height:.95}a{color:#dfff39}li{margin:.75rem 0}</style>
  </head>
  <body>
    <main>
      <p>Cascade League</p>
      <h1>Seasons and generations</h1>
      <ul>
        ${items}
      </ul>
    </main>
  </body>
</html>
`;
}

export async function exportGenerationToStaticSite(
  options: ExportGenerationToStaticSiteOptions,
): Promise<ExportedStaticGeneration> {
  const generationPath = resolve(options.generationPath);
  const siteRoot = resolve(options.siteRoot);
  if (
    isNestedPath(generationPath, siteRoot) ||
    isNestedPath(siteRoot, generationPath)
  ) {
    throw new Error("publication site and immutable generation paths must be separate");
  }
  const manifest = await readJsonWithSchema(
    join(generationPath, "manifest.json"),
    ManifestSchema,
  );
  if (manifest.status !== "completed") {
    throw new Error("static publication requires a completed generation");
  }

  await mkdir(siteRoot, { recursive: true });
  const canonicalGenerationPath = await canonicalDirectory(
    generationPath,
    "immutable generation root",
  );
  const canonicalSiteRoot = await canonicalDirectory(siteRoot, "publication root");
  if (
    isNestedPath(canonicalGenerationPath, canonicalSiteRoot) ||
    isNestedPath(canonicalSiteRoot, canonicalGenerationPath)
  ) {
    throw new Error("publication site and immutable generation paths must be separate");
  }
  await auditPublicationTree(canonicalSiteRoot);
  const publicPath = join(
    canonicalSiteRoot,
    "seasons",
    manifest.seasonId,
    manifest.generationId,
  );
  const newIdentity = sourceGenerationIdentity(
    await readFile(join(generationPath, "manifest.json")),
    (
      await readJsonWithSchema(
        join(generationPath, "challenge/snapshot.json"),
        SnapshotSchema,
      )
    ).publicationSourceNonce,
  );
  let replacedSourceIdentity: string | undefined;
  if (await publicationExists(publicPath)) {
    const existingMetadata = await readJsonWithSchema(
      join(publicPath, "metadata.json"),
      PublicMetadataSchema,
    );
    if (existingMetadata.sourceGenerationIdentity !== newIdentity) {
      const oldIdentity =
        existingMetadata.sourceGenerationIdentity ?? "legacy-unidentified";
      if (options.replaceExisting !== true) {
        throw new Error(
          `publication ${manifest.seasonId}/${manifest.generationId} is occupied by source ${oldIdentity}; new source ${newIdentity}; pass --replace-existing to replace it`,
        );
      }
      replacedSourceIdentity = oldIdentity;
    }
  }
  await buildGallery({
    repositoryRoot: options.repositoryRoot,
    generationPath,
    outputPath: publicPath,
  });
  await auditPublicationTree(canonicalSiteRoot);
  const generations = await buildCatalog(canonicalSiteRoot);
  const catalog = StaticSiteCatalogSchema.parse({ schemaVersion: 1, generations });
  await writeTextAtomically(
    join(canonicalSiteRoot, "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  await writeTextAtomically(
    join(canonicalSiteRoot, "index.html"),
    renderSiteIndex(generations),
  );
  await writeTextAtomically(join(canonicalSiteRoot, ".nojekyll"), "");
  return {
    seasonId: manifest.seasonId,
    generationId: manifest.generationId,
    publicPath,
    sourceIdentity: newIdentity,
    ...(replacedSourceIdentity === undefined ? {} : { replacedSourceIdentity }),
  };
}
