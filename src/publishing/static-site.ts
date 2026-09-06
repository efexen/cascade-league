import { lstat, mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { writeTextAtomically } from "../contestants/support.js";
import { buildGallery, PublicMetadataSchema } from "../gallery/builder.js";
import { ManifestSchema, readJsonWithSchema } from "../schemas/index.js";

export interface ExportGenerationToStaticSiteOptions {
  readonly repositoryRoot: string;
  readonly generationPath: string;
  readonly siteRoot: string;
}

export interface ExportedStaticGeneration {
  readonly seasonId: string;
  readonly generationId: string;
  readonly publicPath: string;
}

interface CatalogGeneration {
  readonly seasonId: string;
  readonly generationId: string;
  readonly path: string;
}

function isNestedPath(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

async function buildCatalog(siteRoot: string): Promise<readonly CatalogGeneration[]> {
  const seasonsRoot = join(siteRoot, "seasons");
  const generations: CatalogGeneration[] = [];
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

function renderSiteIndex(generations: readonly CatalogGeneration[]): string {
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
  const publicPath = join(
    siteRoot,
    "seasons",
    manifest.seasonId,
    manifest.generationId,
  );
  await buildGallery({
    repositoryRoot: options.repositoryRoot,
    generationPath,
    outputPath: publicPath,
  });
  const generations = await buildCatalog(siteRoot);
  await writeTextAtomically(
    join(siteRoot, "catalog.json"),
    `${JSON.stringify({ schemaVersion: 1, generations }, null, 2)}\n`,
  );
  await writeTextAtomically(join(siteRoot, "index.html"), renderSiteIndex(generations));
  await writeTextAtomically(join(siteRoot, ".nojekyll"), "");
  return {
    seasonId: manifest.seasonId,
    generationId: manifest.generationId,
    publicPath,
  };
}
