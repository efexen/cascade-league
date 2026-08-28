import { readFile } from "node:fs/promises";

import {
  CandidateJudgmentSchema,
  createGenerationAwardsSchema,
  JudgeCandidateResponseSchema,
  type JudgmentScores,
} from "../schemas/index.js";
import {
  emptyUsage,
  regularFileExists,
  writeLog,
  writeTextAtomically,
} from "../contestants/support.js";
import type {
  JudgeAdapter,
  JudgeAwardsInput,
  JudgeAwardsResult,
  JudgeCandidateInput,
  JudgeCandidateResult,
} from "./types.js";

export interface FixtureJudgeAdapterOptions {
  readonly delayMs?: number;
}

type FixtureStyle = "editorial" | "geometric" | "generic" | "unknown";

const SCORES: Record<string, Record<FixtureStyle, JudgmentScores>> = {
  "critic-a": {
    editorial: {
      hierarchyAndReadability: 14,
      composition: 14,
      typography: 14,
      colourAndVisualSystem: 9,
      coherenceAndCraft: 14,
      originalityAndMemorability: 18,
      constraintAndCssCraft: 9,
    },
    geometric: {
      hierarchyAndReadability: 12,
      composition: 13,
      typography: 12,
      colourAndVisualSystem: 9,
      coherenceAndCraft: 13,
      originalityAndMemorability: 15,
      constraintAndCssCraft: 9,
    },
    generic: {
      hierarchyAndReadability: 10,
      composition: 10,
      typography: 9,
      colourAndVisualSystem: 6,
      coherenceAndCraft: 10,
      originalityAndMemorability: 8,
      constraintAndCssCraft: 7,
    },
    unknown: {
      hierarchyAndReadability: 8,
      composition: 8,
      typography: 8,
      colourAndVisualSystem: 5,
      coherenceAndCraft: 8,
      originalityAndMemorability: 5,
      constraintAndCssCraft: 6,
    },
  },
  "critic-b": {
    editorial: {
      hierarchyAndReadability: 13,
      composition: 13,
      typography: 13,
      colourAndVisualSystem: 8,
      coherenceAndCraft: 13,
      originalityAndMemorability: 16,
      constraintAndCssCraft: 9,
    },
    geometric: {
      hierarchyAndReadability: 14,
      composition: 14,
      typography: 13,
      colourAndVisualSystem: 9,
      coherenceAndCraft: 14,
      originalityAndMemorability: 18,
      constraintAndCssCraft: 9,
    },
    generic: {
      hierarchyAndReadability: 10,
      composition: 9,
      typography: 9,
      colourAndVisualSystem: 5,
      coherenceAndCraft: 9,
      originalityAndMemorability: 7,
      constraintAndCssCraft: 7,
    },
    unknown: {
      hierarchyAndReadability: 8,
      composition: 8,
      typography: 8,
      colourAndVisualSystem: 5,
      coherenceAndCraft: 8,
      originalityAndMemorability: 5,
      constraintAndCssCraft: 6,
    },
  },
};

function fixtureName(input: {
  readonly harness: { readonly adapter: string; readonly fixture?: string };
}): string {
  return input.harness.adapter === "fixture"
    ? (input.harness.fixture ?? "unknown")
    : "unknown";
}

function outcome(fixture: string): "valid" | "invalid" | "timeout" | "failed" {
  const normalised = fixture.toLowerCase().replaceAll("_", "-");
  if (["invalid-json", "invalid"].includes(normalised)) return "invalid";
  if (["timeout", "timed-out"].includes(normalised)) return "timeout";
  if (["failure", "failed"].includes(normalised)) return "failed";
  return "valid";
}

function styleFromCss(css: string): FixtureStyle {
  const match = /--fixture-style\s*:\s*(editorial|geometric|generic)\b/iu.exec(css);
  return (match?.[1]?.toLowerCase() as FixtureStyle | undefined) ?? "unknown";
}

function total(scores: JudgmentScores): number {
  return Object.values(scores).reduce((sum, score) => sum + score, 0);
}

function critiqueFor(style: FixtureStyle): {
  readonly critique: string;
  readonly strongestQuality: string;
  readonly primaryWeakness: string;
  readonly nextMove: string;
} {
  if (style === "editorial") {
    return {
      critique:
        "The page establishes a clear editorial cadence and a distinctive voice. Tighten the lower-page density next.",
      strongestQuality: "Distinct editorial cadence",
      primaryWeakness: "Lower-page density",
      nextMove: "Tighten the lower-page density",
    };
  }
  if (style === "geometric") {
    return {
      critique:
        "The page uses a bright geometric system with confident repetition. Refine the quieter text hierarchy next.",
      strongestQuality: "Confident geometric system",
      primaryWeakness: "Quiet text hierarchy",
      nextMove: "Refine secondary text contrast",
    };
  }
  if (style === "generic") {
    return {
      critique:
        "The page is orderly and easy to scan at a glance. Develop a more specific visual thesis next.",
      strongestQuality: "Orderly scanning",
      primaryWeakness: "Generic visual thesis",
      nextMove: "Develop a more specific visual thesis",
    };
  }
  return {
    critique:
      "The page handles the supplied structure with reasonable clarity. Give the visual system a more memorable point of view next.",
    strongestQuality: "Basic clarity",
    primaryWeakness: "Undeveloped visual point of view",
    nextMove: "Strengthen the visual point of view",
  };
}

function measuredModelUsage() {
  const usage = emptyUsage(false);
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
  };
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export class FixtureJudgeAdapter implements JudgeAdapter {
  private readonly delayMs: number;

  public constructor(options: FixtureJudgeAdapterOptions = {}) {
    this.delayMs = options.delayMs ?? 4;
  }

  public async scoreCandidate(
    input: JudgeCandidateInput,
  ): Promise<JudgeCandidateResult> {
    const fixture = fixtureName(input.judge);
    const currentOutcome = outcome(fixture);
    if (currentOutcome === "timeout") {
      await delay(input.timeoutMs + 1);
      return {
        status: "timeout",
        response: null,
        judgment: null,
        usage: measuredModelUsage(),
        rawOutput: null,
        error: "fixture judge timed out",
        timedOut: true,
        attemptCount: 1,
      };
    }
    await delay(this.delayMs);
    if (currentOutcome === "failed") {
      return {
        status: "failed",
        response: null,
        judgment: null,
        usage: measuredModelUsage(),
        rawOutput: null,
        error: "fixture judge failed",
        timedOut: false,
        attemptCount: 1,
      };
    }
    if (currentOutcome === "invalid") {
      const rawOutput = "{ this is not valid judge JSON";
      await writeTextAtomically(input.rawOutputPath, rawOutput);
      await writeLog(input.stdoutLogPath, [], []);
      await writeLog(input.stderrLogPath, [], []);
      return {
        status: "invalid",
        response: null,
        judgment: null,
        usage: measuredModelUsage(),
        rawOutput,
        error: "fixture judge returned invalid JSON",
        timedOut: false,
        attemptCount: 1,
      };
    }

    let css = "";
    if (await regularFileExists(input.sanitisedCssPath)) {
      css = await readFile(input.sanitisedCssPath, "utf8");
    }
    const style = styleFromCss(css);
    const configuredScores = SCORES[fixture] ?? SCORES["critic-a"]!;
    const scores = configuredScores[style];
    const language = critiqueFor(style);
    const response = JudgeCandidateResponseSchema.parse({
      schemaVersion: 1,
      generationId: input.generationId,
      judgeId: input.judgeId,
      anonymousCandidateId: input.anonymousCandidateId,
      scores,
      totalScore: total(scores),
      ...language,
      confidence: "medium",
      flags: [],
    });
    const rawOutput = `${JSON.stringify(response)}\n`;
    await writeTextAtomically(input.judgmentPath, rawOutput);
    await writeTextAtomically(input.rawOutputPath, rawOutput);
    await writeLog(input.stdoutLogPath, [], []);
    await writeLog(input.stderrLogPath, [], []);
    const judgment = CandidateJudgmentSchema.parse({
      ...response,
      modelUsage: measuredModelUsage(),
    });
    return {
      status: "succeeded",
      response,
      judgment,
      usage: measuredModelUsage(),
      rawOutput,
      error: null,
      timedOut: false,
      attemptCount: 1,
    };
  }

  public async createAwards(input: JudgeAwardsInput): Promise<JudgeAwardsResult> {
    const fixture = fixtureName(input.judge);
    const currentOutcome = outcome(fixture);
    if (currentOutcome === "timeout") {
      await delay(input.timeoutMs + 1);
      return {
        status: "timeout",
        awards: null,
        rawOutput: null,
        usage: measuredModelUsage(),
        error: "fixture awards judge timed out",
        timedOut: true,
        attemptCount: 1,
      };
    }
    await delay(this.delayMs);
    if (currentOutcome === "failed") {
      return {
        status: "failed",
        awards: null,
        rawOutput: null,
        usage: measuredModelUsage(),
        error: "fixture awards judge failed",
        timedOut: false,
        attemptCount: 1,
      };
    }
    if (currentOutcome === "invalid") {
      const rawOutput = "not json";
      await writeTextAtomically(input.rawOutputPath, rawOutput);
      return {
        status: "invalid",
        awards: null,
        rawOutput,
        usage: measuredModelUsage(),
        error: "fixture awards returned invalid JSON",
        timedOut: false,
        attemptCount: 1,
      };
    }
    const validCandidates = input.candidates.filter(
      (candidate) => candidate.judgment !== null,
    );
    const awards =
      validCandidates.length < 2
        ? []
        : [
            {
              label:
                fixture === "critic-b"
                  ? "Strongest Shape Language"
                  : "Best Editorial Rhythm",
              anonymousCandidateId: validCandidates[0]!.anonymousCandidateId,
              rationale:
                "This entry gives the cohort a clear and memorable visual direction.",
            },
          ];
    const parsed = createGenerationAwardsSchema(
      input.candidates.map((candidate) => candidate.anonymousCandidateId),
    ).parse({
      schemaVersion: 1,
      generationId: input.generationId,
      judgeId: input.judgeId,
      awards,
    });
    const rawOutput = `${JSON.stringify(parsed)}\n`;
    await writeTextAtomically(input.awardsPath, rawOutput);
    await writeTextAtomically(input.rawOutputPath, rawOutput);
    await writeLog(input.stdoutLogPath, [], []);
    await writeLog(input.stderrLogPath, [], []);
    return {
      status: "succeeded",
      awards: parsed,
      rawOutput,
      usage: measuredModelUsage(),
      error: null,
      timedOut: false,
      attemptCount: 1,
    };
  }
}
