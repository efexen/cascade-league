import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateSubmission } from "../../src/validation/index.js";

describe("CSS submission validation", () => {
  async function writeChallenge(root: string): Promise<void> {
    await mkdir(join(root, "fonts"), { recursive: true });
    await writeFile(join(root, "fonts/lm-mono.ttf"), "font fixture\n");
    await writeFile(
      join(root, "starter.css"),
      '@font-face { font-family: "LM Mono"; src: url("fonts/lm-mono.ttf"); }\n',
      "utf8",
    );
  }

  it("accepts local challenge fonts and removes comments without reordering CSS", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-css-"));
    await writeChallenge(root);
    const source =
      '/* private note */\r\n.grid { display: grid; background: linear-gradient(red, blue); }\r\n.grid::before { content: "ok"; }\r\n@font-face { font-family: "LM Mono"; src: url("fonts/lm-mono.ttf"); }\r\n';
    const submissionPath = join(root, "submission.css");
    await writeFile(submissionPath, source, "utf8");

    const result = await validateSubmission({
      submissionPath,
      challengeRoot: root,
      starterCssPath: join(root, "starter.css"),
      maximumBytes: 61440,
    });

    expect(result.validation.status).toBe("valid");
    expect(result.validation.sanitisedSha256).toBe(
      createHash("sha256")
        .update(Buffer.from(result.sanitisedCss ?? "", "utf8"))
        .digest("hex"),
    );
    expect(result.sanitisedCss).toContain(".grid { display: grid;");
    expect(result.sanitisedCss).toContain(".grid::before");
    expect(result.sanitisedCss).toContain('url("fonts/lm-mono.ttf")');
    expect(result.sanitisedCss).not.toContain("private note");
    expect(result.sanitisedCss).not.toMatch(/\r/u);
    expect(await readFile(submissionPath, "utf8")).toBe(source);
  });

  it.each([
    'a { background: url("https://example.test/image.png"); }',
    'a { background: url("http://example.test/image.png"); }',
    'a { background: url("//example.test/image.png"); }',
    'a { background: url("data:image/png;base64,AAAA"); }',
    'a { background: url("javascript:alert(1)"); }',
    'a { background: url("file:///tmp/secret"); }',
    "a { background: url(HTTPs://example.test/image.png); }",
    String.raw`a { background: url(\68 ttps://example.test/image.png); }`,
  ])("rejects prohibited URL form: %s", async (source) => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-css-url-"));
    await writeChallenge(root);
    await writeFile(join(root, "submission.css"), source, "utf8");

    const result = await validateSubmission({
      submissionPath: join(root, "submission.css"),
      challengeRoot: root,
      starterCssPath: join(root, "starter.css"),
      maximumBytes: 61440,
    });

    expect(result.validation.status).toBe("invalid");
    expect(result.validation.errors.length).toBeGreaterThan(0);
  });

  it("rejects unusual structural @import syntax", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-css-import-"));
    await writeChallenge(root);
    await writeFile(
      join(root, "submission.css"),
      '@IMPORT/**/url("theme.css");',
      "utf8",
    );

    const result = await validateSubmission({
      submissionPath: join(root, "submission.css"),
      challengeRoot: root,
      starterCssPath: join(root, "starter.css"),
      maximumBytes: 61440,
    });

    expect(result.validation.status).toBe("invalid");
    expect(
      result.validation.staticChecks.find((entry) => entry.code === "css_import")
        ?.status,
    ).toBe("failed");
  });

  it("rejects invalid UTF-8, oversized files, and fatal CSS syntax", async () => {
    const cases = [
      { name: "utf8", bytes: Buffer.from([0xc3, 0x28]), expected: /UTF-8/i },
      {
        name: "oversized",
        bytes: Buffer.from("a".repeat(20)),
        maximumBytes: 8,
        expected: /byte limit/i,
      },
      {
        name: "syntax",
        bytes: Buffer.from("a { color: red;"),
        expected: /parse|unclosed/i,
      },
    ];
    for (const current of cases) {
      const root = await mkdtemp(join(tmpdir(), `local-maxima-css-${current.name}-`));
      await writeChallenge(root);
      const submissionPath = join(root, "submission.css");
      await writeFile(submissionPath, current.bytes);
      const result = await validateSubmission({
        submissionPath,
        challengeRoot: root,
        starterCssPath: join(root, "starter.css"),
        maximumBytes: current.maximumBytes ?? 61440,
      });
      expect(result.validation.status).toBe("invalid");
      expect(result.validation.errors.join(" ")).toMatch(current.expected);
    }
  });

  it("rejects local URLs outside documented font assets and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-css-local-"));
    await writeChallenge(root);
    await writeFile(join(root, "other.txt"), "not a font\n", "utf8");
    await writeFile(
      join(root, "submission.css"),
      'a { background: url("other.txt"); }',
      "utf8",
    );
    const outsideRoot = await mkdtemp(join(tmpdir(), "local-maxima-css-outside-"));
    await writeFile(join(outsideRoot, "escaped.ttf"), "outside\n", "utf8");
    await symlink(join(outsideRoot, "escaped.ttf"), join(root, "fonts/escaped.ttf"));

    const result = await validateSubmission({
      submissionPath: join(root, "submission.css"),
      challengeRoot: root,
      starterCssPath: join(root, "starter.css"),
      maximumBytes: 61440,
    });

    expect(result.validation.status).toBe("invalid");
    expect(result.validation.errors.join(" ")).toMatch(/documented|allowlisted|local/i);
  });

  it("rejects an oversized sparse submission from its lstat size before reading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-css-sparse-"));
    await writeChallenge(root);
    const submissionPath = join(root, "submission.css");
    await writeFile(submissionPath, "", "utf8");
    await truncate(submissionPath, 64 * 1024 * 1024);

    const result = await validateSubmission({
      submissionPath,
      challengeRoot: root,
      starterCssPath: join(root, "starter.css"),
      maximumBytes: 8,
    });

    expect(result.validation.status).toBe("invalid");
    expect(result.validation.submissionSha256).toBeNull();
    expect(result.validation.submissionBytes).toBe(64 * 1024 * 1024);
    expect(result.validation.errors.join(" ")).toMatch(/byte limit|oversized/i);
  });
});
