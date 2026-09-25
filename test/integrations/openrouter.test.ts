import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseContestantOptions,
  runContestant,
} from "../../integrations/openrouter/contestant.js";
import {
  inferJudgeOperation,
  runJudge,
  type JudgeOptions,
} from "../../integrations/openrouter/judge.js";
import { requestCompletion } from "../../integrations/openrouter/shared.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cascade-openrouter-"));
  roots.push(root);
  const paths = Object.fromEntries(
    await Promise.all(
      [
        "prompt.md",
        "challenge.html",
        "starter.css",
        "candidate.png",
        "cohort.png",
        "candidate.css",
        "summary.md",
      ].map(async (name) => {
        const path = join(root, name);
        await writeFile(
          path,
          name.endsWith(".png")
            ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
            : `${name} fixture text\n`,
        );
        return [name, path] as const;
      }),
    ),
  );
  return { root, paths };
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  action: (endpoint: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind");
  try {
    await action(`http://127.0.0.1:${address.port}/chat/completions`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
function complete(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
function judgeOptions(
  paths: Record<string, string>,
  operation: "score" | "awards",
): JudgeOptions {
  const target = join(paths["prompt.md"]!.replace(/prompt\.md$/u, ""), operation);
  return {
    model: "google/gemini-3.1-flash-lite",
    maxCompletionTokens: 512,
    workspacePath: target,
    promptPath: paths["prompt.md"]!,
    candidateScreenshotPath: paths["candidate.png"]!,
    contactSheetPath: paths["cohort.png"]!,
    sanitisedCssPath: paths["candidate.css"]!,
    judgmentPath:
      operation === "score" ? join(target, "same.json") : join(target, "judgment.json"),
    judgmentSummaryPath:
      operation === "score" ? join(target, "same.json") : paths["summary.md"]!,
    awardsPath:
      operation === "score" ? join(target, "same.json") : join(target, "judgment.json"),
    executionMetadataPath: join(target, "metadata.json"),
    usagePath: join(target, "usage.json"),
  };
}

const completion = (content: string, overrides: Record<string, unknown> = {}) => ({
  id: "req_stub_1",
  model: "google/gemini-3.1-flash-lite",
  choices: [{ finish_reason: "stop", message: { content } }],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 8,
    total_tokens: 28,
    completion_tokens_details: { reasoning_tokens: 2 },
    cost: 0.0007,
  },
  ...overrides,
});

describe("OpenRouter adapter contract", () => {
  it("requires a model and explicit completion token cap", () => {
    expect(() => parseContestantOptions([])).toThrow(/--model is required/);
    expect(() =>
      parseContestantOptions([
        "--model",
        "qwen/qwen3-coder-next",
        "--max-completion-tokens",
        "512",
        "--workspace-path",
        "/tmp/work",
        "--challenge-path",
        "/tmp/challenge.html",
        "--starter-css-path",
        "/tmp/starter.css",
        "--prompt-path",
        "/tmp/prompt.md",
        "--submission-path",
        "/tmp/submission.css",
        "--execution-metadata-path",
        "/tmp/metadata.json",
        "--usage-path",
        "/tmp/usage.json",
      ]),
    ).not.toThrow();
  });

  it("sends one bounded non-streaming contestant request with real source text, no credential leakage, and captures usage", async () => {
    const { paths } = await fixture();
    let calls = 0;
    await withServer(
      async (request, response) => {
        calls += 1;
        expect(request.method).toBe("POST");
        expect(request.headers.authorization).toBe("Bearer dummy-local-test-token");
        const body = await readRequest(request);
        expect(body.model).toBe("qwen/qwen3-coder-next");
        expect(body.stream).toBe(false);
        expect(body.max_completion_tokens).toBe(256);
        expect(body.provider).toEqual({ allow_fallbacks: false });
        const message = (body.messages as { content: string }[])[0]!.content;
        expect(message).toContain("prompt.md fixture text");
        expect(message).toContain(
          "Direct-response adapter: you have no filesystem or browser access",
        );
        expect(message).toContain("The adapter will write your response");
        expect(message).toContain("challenge.html fixture text");
        expect(message).toContain("starter.css fixture text");
        complete(response, completion("body { color: navy; }"));
      },
      async (endpoint) => {
        await runContestant(
          {
            model: "qwen/qwen3-coder-next",
            maxCompletionTokens: 256,
            workspacePath: paths["prompt.md"]!,
            promptPath: paths["prompt.md"]!,
            challengePath: paths["challenge.html"]!,
            starterCssPath: paths["starter.css"]!,
            submissionPath: join(
              paths["prompt.md"]!.replace(/prompt\.md$/u, ""),
              "submission.css",
            ),
            executionMetadataPath: join(
              paths["prompt.md"]!.replace(/prompt\.md$/u, ""),
              "metadata.json",
            ),
            usagePath: join(
              paths["prompt.md"]!.replace(/prompt\.md$/u, ""),
              "usage.json",
            ),
          },
          { endpoint, apiKey: "dummy-local-test-token" },
        );
      },
    );
    expect(calls).toBe(1);
    const directory = paths["prompt.md"]!.replace(/prompt\.md$/u, "");
    expect(await readFile(join(directory, "submission.css"), "utf8")).toBe(
      "body { color: navy; }\n",
    );
    expect(await readFile(join(directory, "metadata.json"), "utf8")).toContain(
      '"providerRequestId":"req_stub_1"',
    );
    expect(JSON.parse(await readFile(join(directory, "usage.json"), "utf8"))).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      reasoningTokens: 2,
      totalTokens: 28,
      estimatedCostUsd: 0.0007,
      tokenLimitEnforced: false,
    });
    expect(await readFile(join(directory, "metadata.json"), "utf8")).not.toContain(
      "dummy-local-test-token",
    );
  });

  it("attaches score prompt and CSS before candidate then cohort base64 PNGs", async () => {
    const { paths } = await fixture();
    const input = judgeOptions(paths, "score");
    await withServer(
      async (request, response) => {
        const body = await readRequest(request);
        expect(body.provider).toEqual({ allow_fallbacks: false });
        expect(body.max_completion_tokens).toBe(512);
        const content = (
          body.messages as {
            content: { type: string; text?: string; image_url?: { url: string } }[];
          }[]
        )[0]!.content;
        expect(content.map((part) => part.type)).toEqual([
          "text",
          "image_url",
          "image_url",
        ]);
        expect(content[0]!.text).toContain("candidate.css fixture text");
        expect(content[1]!.image_url!.url).toMatch(/^data:image\/png;base64,/u);
        expect(
          Buffer.from(content[1]!.image_url!.url!.split(",")[1]!, "base64"),
        ).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
        expect(
          Buffer.from(content[2]!.image_url!.url!.split(",")[1]!, "base64"),
        ).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
        complete(response, completion('{"scores":{}}'));
      },
      async (endpoint) => runJudge(input, { endpoint, apiKey: "test" }),
    );
    expect(await readFile(input.judgmentPath, "utf8")).toBe('{"scores":{}}\n');
  });

  it("uses generic aliases for awards and attaches summary text then only the cohort image", async () => {
    const { paths } = await fixture();
    const input = judgeOptions(paths, "awards");
    expect(inferJudgeOperation(input)).toBe("awards");
    await withServer(
      async (request, response) => {
        const body = await readRequest(request);
        const content = (
          body.messages as { content: { type: string; text?: string }[] }[]
        )[0]!.content;
        expect(content).toHaveLength(2);
        expect(content[0]!.text).toContain("summary.md fixture text");
        expect(content[1]!.type).toBe("image_url");
        complete(response, completion('prose {"awards":[]} tail'));
      },
      async (endpoint) => runJudge(input, { endpoint, apiKey: "test" }),
    );
    expect(await readFile(input.awardsPath, "utf8")).toBe('{"awards":[]}\n');
  });

  it("fails closed on non-2xx, malformed or truncated output without leaking authorization or retrying", async () => {
    for (const [responseBody, status, expected] of [
      ["secret-looking error body", 401, /HTTP 401/],
      ["not json", 200, /malformed JSON/],
      [
        JSON.stringify(
          completion("partial", {
            choices: [{ finish_reason: "length", message: { content: "partial" } }],
          }),
        ),
        200,
        /not finished normally/,
      ],
    ] as const) {
      let calls = 0;
      await withServer(
        async (_request, response) => {
          calls += 1;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(responseBody);
        },
        async (endpoint) => {
          let failure = "";
          try {
            await requestCompletion(
              {
                apiKey: "never-echo-this-key",
                model: "qwen/qwen3-coder-next",
                maxCompletionTokens: 30,
                content: "prompt",
                timeoutMs: 1000,
              },
              { endpoint },
            );
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          }
          expect(failure).toMatch(expected);
          expect(failure).not.toContain("never-echo-this-key");
        },
      );
      expect(calls).toBe(1);
    }
  });

  it("times out without exposing the key and rejects remote injected endpoints", async () => {
    let calls = 0;
    await withServer(
      async (_request, response) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        complete(response, completion("late"));
      },
      async (endpoint) => {
        let failure = "";
        try {
          await requestCompletion(
            {
              apiKey: "private-key",
              model: "qwen/qwen3-coder-next",
              maxCompletionTokens: 30,
              content: "prompt",
              timeoutMs: 5,
            },
            { endpoint },
          );
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        expect(failure).toBe("OpenRouter request timed out");
        expect(failure).not.toContain("private-key");
      },
    );
    expect(calls).toBe(1);
    await expect(
      requestCompletion(
        {
          apiKey: "private-key",
          model: "qwen/qwen3-coder-next",
          maxCompletionTokens: 30,
          content: "x",
        },
        { endpoint: "https://example.com" },
      ),
    ).rejects.toThrow(/loopback/);
  });
});
