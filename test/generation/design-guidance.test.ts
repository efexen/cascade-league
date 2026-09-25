import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGeneration } from "../../src/artifacts/generation.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import { runWaveB } from "../../src/orchestration/wave-b.js";
import { FixtureContestantAdapter } from "../../src/contestants/index.js";
import { SnapshotSchema } from "../../src/schemas/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const sourceRoot = new URL("../../", import.meta.url).pathname;
const timestamp = "2026-09-25T09:00:00.000Z";

async function isolatedRepository(): Promise<string> {
  const root = await createTestTempRoot("cascade-guidance-repo-");
  await mkdir(join(root, "challenge"), { recursive: true });
  await mkdir(join(root, "config/profiles"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await cp(
    join(sourceRoot, "challenge/season-004"),
    join(root, "challenge/season-004"),
    { recursive: true },
  );
  await cp(
    join(sourceRoot, "config/profiles/fixture-guidance"),
    join(root, "config/profiles/fixture-guidance"),
    { recursive: true },
  );
  await cp(join(sourceRoot, "test/fixtures"), join(root, "test/fixtures"), {
    recursive: true,
  });
  return root;
}

async function makeRemovable(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeRemovable(child);
  }
  await chmod(path, 0o755);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("season-pinned contestant design guidance", () => {
  it("snapshots bytes and hash, isolates staging, refuses source mutation before adapter calls, and discloses after judging", async () => {
    const repositoryRoot = await isolatedRepository();
    const generationsRoot = await createTestTempRoot("cascade-guidance-generations-");
    const guidancePath = join(
      repositoryRoot,
      "challenge/season-004/guidance/luna-design.md",
    );
    await writeFile(
      guidancePath,
      `${await readFile(guidancePath, "utf8")}\n<script>alert(1)</script> & disclosure\n`,
    );
    const originalGuidance = await readFile(guidancePath);
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0004",
      profileId: "fixture-guidance",
      generationId: "0001",
      now: timestamp,
    });
    const snapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(
          join(generation.generationPath, "challenge/snapshot.json"),
          "utf8",
        ),
      ) as unknown,
    );
    expect(snapshot.inputHashes["challenge/season-004/guidance/luna-design.md"]).toBe(
      sha256(originalGuidance),
    );
    expect(snapshot.inputHashes["guidance/luna-guided.md"]).toBe(
      sha256(originalGuidance),
    );
    expect(
      await readFile(join(generation.generationPath, "guidance/luna-guided.md")),
    ).toEqual(originalGuidance);
    expect(
      await readFile(
        join(
          generation.generationPath,
          "contestants/luna-guided/workspace/design-guidance.md",
        ),
      ),
    ).toEqual(originalGuidance);
    await expect(
      readFile(
        join(
          generation.generationPath,
          "contestants/luna-plain/workspace/design-guidance.md",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(guidancePath, `${originalGuidance.toString("utf8")}changed\n`);
    let adapterCalls = 0;
    await expect(
      runWaveB({
        repositoryRoot,
        generationPath: generation.generationPath,
        contestantAdapterFactory: () => ({
          run: async () => {
            adapterCalls += 1;
            throw new Error("should not execute");
          },
        }),
        now: timestamp,
        clock: () => new Date(timestamp),
      }),
    ).rejects.toThrow(/source input .*luna-design\.md.*hash/i);
    expect(adapterCalls).toBe(0);

    await writeFile(guidancePath, originalGuidance);
    const contestantWorkspaces = ["luna-plain", "luna-guided"].map((id) =>
      join(generation.generationPath, "contestants", id, "workspace"),
    );
    await Promise.all(contestantWorkspaces.map(makeRemovable));
    await Promise.all(
      contestantWorkspaces.map((workspace) => rm(workspace, { recursive: true })),
    );
    const completed = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      resumable: true,
      now: timestamp,
      generatedAt: timestamp,
    });
    const publicMetadata = JSON.parse(
      await readFile(join(completed.gallery.publicPath, "metadata.json"), "utf8"),
    ) as {
      designGuidance: {
        experiment: string;
        entries: { displayName: string; label: string; content?: string }[];
      };
    };
    expect(publicMetadata.designGuidance.experiment).toMatch(
      /Matched pair:.*only the published design guidance differs/u,
    );
    expect(publicMetadata.designGuidance.entries).toContainEqual({
      displayName: "Luna · Guided",
      label: "Guided",
      content: originalGuidance.toString("utf8"),
    });
    const guidancePage = await readFile(
      join(completed.gallery.publicPath, "guidance.html"),
      "utf8",
    );
    expect(guidancePage).toContain("Guidance provided after judging");
    expect(guidancePage).toContain("Plain · no additional design guidance");
    expect(guidancePage).toContain("Luna · Guided");
    expect(guidancePage).toContain("Treat the page as a system of information");
    expect(guidancePage).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; disclosure",
    );
    expect(guidancePage).not.toContain("<script>alert(1)</script>");
    const guidedViewer = await readFile(
      join(completed.gallery.publicPath, "designs/luna-guided/view.html"),
      "utf8",
    );
    expect(guidedViewer).toContain('href="../../guidance.html"');
    expect(guidancePage).not.toContain("<script");
    expect(JSON.stringify(publicMetadata.designGuidance)).not.toContain("luna-guided");
    expect(JSON.stringify(publicMetadata.designGuidance)).not.toContain(
      "challenge/season-004",
    );
    const plainPrompt = await readFile(
      join(generation.generationPath, "contestants/luna-plain/prompt.md"),
      "utf8",
    );
    const guidedPrompt = await readFile(
      join(generation.generationPath, "contestants/luna-guided/prompt.md"),
      "utf8",
    );
    expect(plainPrompt).not.toMatch(/design guidance|A\/B/iu);
    expect(guidedPrompt).toContain("Read this local guidance file before designing");
    for (const judgeId of ["fixture-critic-a", "fixture-critic-b"]) {
      const judgeRoot = join(generation.generationPath, "judging", judgeId);
      const promptFiles = await readdir(join(judgeRoot, "prompts"));
      const visiblePrompts = await Promise.all([
        readFile(join(judgeRoot, "awards-prompt.md"), "utf8"),
        ...promptFiles.map((filename) =>
          readFile(join(judgeRoot, "prompts", filename), "utf8"),
        ),
      ]);
      expect(visiblePrompts.join("\n")).not.toContain("Design direction");
      expect(visiblePrompts.join("\n")).not.toContain("luna-guided");
    }

    await rm(guidancePath);
    const rebuilt = await (
      await import("../../src/gallery/builder.js")
    ).buildGallery({
      repositoryRoot,
      generationPath: generation.generationPath,
    });
    expect(await readFile(join(rebuilt.publicPath, "metadata.json"), "utf8")).toBe(
      await readFile(join(completed.gallery.publicPath, "metadata.json"), "utf8"),
    );
  }, 30_000);

  it("does not let an unconfigured workspace guidance file change the contestant prompt", async () => {
    const repositoryRoot = await isolatedRepository();
    const generationsRoot = await createTestTempRoot("cascade-guidance-tamper-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0004",
      profileId: "fixture-guidance",
      generationId: "0001",
      now: timestamp,
    });
    const plainWorkspace = join(
      generation.generationPath,
      "contestants/luna-plain/workspace",
    );
    await writeFile(join(plainWorkspace, "design-guidance.md"), "tampered advice\n");
    const calls: string[] = [];
    const fixtureAdapter = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      contestantAdapterFactory: (contestant) => ({
        run: (input) => {
          calls.push(contestant.id);
          return fixtureAdapter.run(input);
        },
      }),
      now: timestamp,
      clock: () => new Date(timestamp),
    });
    expect(calls).not.toContain("luna-plain");
    expect(
      result.contestants.find((entry) => entry.contestantId === "luna-plain")?.run
        .status,
    ).toBe("failed");
  }, 30_000);
});
