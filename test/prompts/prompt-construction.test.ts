import { describe, expect, it } from "vitest";

import {
  buildContestantGenerationOnePrompt,
  buildJudgeAwardsPrompt,
  buildJudgeCandidatePrompt,
} from "../../src/prompts/index.js";

describe("contestant prompt contract", () => {
  it("builds the normative generation-one prompt with paths as its only variation", () => {
    const first = buildContestantGenerationOnePrompt({
      submissionPath: "/private/a/submission.css",
      challengePath: "/private/a/challenge.html",
      starterCssPath: "/private/a/starter.css",
    });
    const second = buildContestantGenerationOnePrompt({
      submissionPath: "/private/b/submission.css",
      challengePath: "/private/b/challenge.html",
      starterCssPath: "/private/b/starter.css",
    });

    expect(first).toContain("You are a contestant in Cascade League");
    expect(first).not.toContain("Local Maxima");
    expect(first).toContain("Originality is explicitly important.");
    expect(first).toContain("Do not attempt to run or inspect the result.");
    expect(first).toContain("`/private/a/submission.css`");
    expect(first.replaceAll("/private/a/", "/private/b/")).toBe(second);
  });

  it("keeps judge context anonymous and uses the exact response shape without usage", () => {
    const candidatePrompt = buildJudgeCandidatePrompt({
      generationId: "0001",
      judgeId: "fixture-critic-a",
      anonymousCandidateId: "candidate-abcd",
    });
    const awardsPrompt = buildJudgeAwardsPrompt({
      generationId: "0001",
      judgeId: "fixture-critic-a",
      summaries: [
        {
          anonymousCandidateId: "candidate-abcd",
          totalScore: 82,
          originalityScore: 17,
          critique: "The hierarchy is clear. Increase the lower-page contrast next.",
        },
      ],
    });

    expect(candidatePrompt).toContain('"anonymousCandidateId": "candidate-abcd"');
    expect(candidatePrompt).toContain("originalityAndMemorability");
    expect(candidatePrompt).toContain("anonymous design judge for Cascade League");
    expect(candidatePrompt).not.toContain("Local Maxima");
    expect(candidatePrompt).not.toContain("modelUsage");
    expect(candidatePrompt).not.toContain("fixture-editorial");
    expect(awardsPrompt).toContain("candidate-abcd");
    expect(awardsPrompt).toContain(
      "anonymous judging for one Cascade League generation",
    );
    expect(awardsPrompt).not.toContain("Local Maxima");
    expect(awardsPrompt).not.toContain("fixture-editorial");
    expect(awardsPrompt).not.toContain("[SUMMARIES]");
  });
});
