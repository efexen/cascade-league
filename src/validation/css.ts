import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import postcss, { type AtRule, type Declaration, type Root } from "postcss";
import valueParser from "postcss-value-parser";

import { ValidationSchema, type Validation } from "../schemas/index.js";
import { readRegularFileAtMost } from "../contestants/support.js";

export interface ValidateSubmissionInput {
  readonly submissionPath: string;
  readonly challengeRoot: string;
  readonly starterCssPath: string;
  readonly maximumBytes: number;
}

export interface SubmissionValidationResult {
  readonly validation: Validation;
  readonly sanitisedCss: string | null;
}

interface CheckInput {
  readonly code: string;
  readonly status: "passed" | "warning" | "failed" | "not_run";
  readonly message: string;
  readonly value?: string | number | boolean | null;
}

interface AllowedFont {
  readonly urlPath: string;
  readonly absolutePath: string;
}

type ValueParserNode = ReturnType<typeof valueParser>["nodes"][number];
type ValueFunctionNode = Extract<ValueParserNode, { readonly type: "function" }>;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function check(input: CheckInput): Validation["staticChecks"][number] {
  return input.value === undefined
    ? {
        code: input.code,
        status: input.status,
        message: input.message,
      }
    : {
        code: input.code,
        status: input.status,
        value: input.value,
        message: input.message,
      };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

async function assertNoSymlinkEscape(
  rootPath: string,
  candidatePath: string,
): Promise<void> {
  const realRoot = await realpath(rootPath);
  const relativeCandidate = relative(resolve(rootPath), resolve(candidatePath));
  const resolvedCandidate = resolve(realRoot, relativeCandidate);
  if (!isContained(realRoot, resolvedCandidate)) {
    throw new Error("local font URL escapes the challenge directory");
  }
  let current = realRoot;
  for (const segment of relative(realRoot, resolvedCandidate).split(sep)) {
    current = resolve(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new Error("local font URL traverses a symbolic link");
    }
  }
}

function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[\r\n ]?)/giu, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint === 0 || codePoint > 0x10ffff
        ? "\ufffd"
        : String.fromCodePoint(codePoint);
    })
    .replace(/\\([^\r\n])/gu, "$1");
}

function parsedUrlValue(node: ValueFunctionNode): string {
  const parsed = valueParser
    .stringify(node.nodes, (child) => (child.type === "comment" ? "" : undefined))
    .trim();
  const decoded = decodeCssEscapes(parsed);
  if (
    decoded.length >= 2 &&
    ((decoded.startsWith('"') && decoded.endsWith('"')) ||
      (decoded.startsWith("'") && decoded.endsWith("'")))
  ) {
    return decoded.slice(1, -1);
  }
  return decoded;
}

function urlFunctions(value: string): ValueFunctionNode[] {
  const parsed = valueParser(value);
  const functions: ValueFunctionNode[] = [];
  parsed.walk((node) => {
    if (
      node.type === "function" &&
      decodeCssEscapes(node.value).toLowerCase() === "url"
    ) {
      functions.push(node);
    }
  });
  return functions;
}

function postcssParentAtRule(declaration: Declaration): AtRule | null {
  let current: { readonly type: string; readonly parent?: unknown } | undefined =
    declaration.parent;
  while (current !== undefined) {
    if (current.type === "atrule") return current as AtRule;
    current = current.parent as typeof current;
  }
  return null;
}

function normaliseRelativeFontPath(rawValue: string): string | null {
  let value = rawValue.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  value = decodeCssEscapes(value).trim();
  if (
    value === "" ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const normalised = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  return normalised === "" ? null : normalised;
}

async function documentedFonts(
  challengeRoot: string,
  starterCssPath: string,
): Promise<Map<string, AllowedFont>> {
  const starterText = UTF8_DECODER.decode(await readFile(starterCssPath));
  const root = postcss.parse(starterText, { map: false });
  const fonts = new Map<string, AllowedFont>();
  root.walkDecls((declaration) => {
    const parent = postcssParentAtRule(declaration);
    if (parent === null || parent.name.toLowerCase() !== "font-face") return;
    for (const node of urlFunctions(declaration.value)) {
      const path = normaliseRelativeFontPath(parsedUrlValue(node));
      if (path === null || !path.startsWith("fonts/")) continue;
      const absolutePath = resolve(challengeRoot, path);
      fonts.set(path, { urlPath: path, absolutePath });
    }
  });
  for (const font of fonts.values()) {
    await assertNoSymlinkEscape(challengeRoot, font.absolutePath);
    const fontStatus = await lstat(font.absolutePath);
    if (!fontStatus.isFile() || fontStatus.isSymbolicLink()) {
      throw new Error(
        `documented challenge font is not a regular file: ${font.urlPath}`,
      );
    }
  }
  return fonts;
}

function classifyUrl(
  rawValue: string,
  allowedFonts: ReadonlyMap<string, AllowedFont>,
): { readonly allowedPath: string | null; readonly error: string | null } {
  let decoded = decodeCssEscapes(rawValue.trim());
  if (
    decoded.length >= 2 &&
    ((decoded.startsWith('"') && decoded.endsWith('"')) ||
      (decoded.startsWith("'") && decoded.endsWith("'")))
  ) {
    decoded = decoded.slice(1, -1);
  }
  try {
    decoded = decodeURIComponent(decoded).trim();
  } catch {
    return { allowedPath: null, error: "URL contains invalid percent encoding" };
  }
  const lower = decoded.toLowerCase();
  if (lower.startsWith("//")) {
    return { allowedPath: null, error: "protocol-relative URLs are not allowed" };
  }
  if (
    /^(?:https?|data|javascript|vbscript|file|blob|filesystem|ws|wss|about):/iu.test(
      decoded,
    )
  ) {
    return { allowedPath: null, error: "remote or script-like URLs are not allowed" };
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(decoded)) {
    return { allowedPath: null, error: "URL schemes are not allowed" };
  }
  const path = normaliseRelativeFontPath(decoded);
  if (path === null) {
    return { allowedPath: null, error: "URL is not a safe local path" };
  }
  if (!allowedFonts.has(path)) {
    return {
      allowedPath: null,
      error: "only documented challenge-owned local font URLs are allowed",
    };
  }
  return { allowedPath: path, error: null };
}

function removeCommentsAndNormalise(root: Root): string {
  root.walkComments((comment) => {
    comment.remove();
  });
  return root.toString().replace(/\r\n?/gu, "\n");
}

function baseValidation(
  status: Validation["status"],
  submissionSha256: string | null,
  submissionBytes: number,
  staticChecks: readonly Validation["staticChecks"][number][],
  errors: readonly string[],
  warnings: readonly string[],
  sanitisedCss: string | null,
): SubmissionValidationResult {
  return {
    validation: ValidationSchema.parse({
      schemaVersion: 1,
      status,
      submissionSha256,
      sanitisedSha256:
        sanitisedCss === null ? null : sha256(Buffer.from(sanitisedCss, "utf8")),
      submissionBytes,
      staticChecks,
      renderChecks: [],
      errors,
      warnings,
    }),
    sanitisedCss,
  };
}

export async function validateSubmission(
  input: ValidateSubmissionInput,
): Promise<SubmissionValidationResult> {
  let file;
  try {
    file = await readRegularFileAtMost(input.submissionPath, input.maximumBytes);
  } catch (error) {
    return baseValidation(
      "invalid",
      null,
      0,
      [
        check({
          code: "submission_file",
          status: "failed",
          message: "submission.css is missing",
        }),
      ],
      [error instanceof Error ? error.message : "submission.css is missing"],
      [],
      null,
    );
  }

  if (file.kind === "missing") {
    return baseValidation(
      "invalid",
      null,
      0,
      [
        check({
          code: "submission_file",
          status: "failed",
          message: "submission.css is missing",
        }),
      ],
      ["submission.css is missing"],
      [],
      null,
    );
  }
  if (file.kind === "invalid") {
    return baseValidation(
      "invalid",
      null,
      file.size,
      [
        check({
          code: "submission_file",
          status: "failed",
          message: "submission.css is not a regular file",
        }),
      ],
      ["submission.css must be a regular file"],
      [],
      null,
    );
  }
  if (file.kind === "too_large") {
    return baseValidation(
      "invalid",
      null,
      file.size,
      [
        check({
          code: "submission_bytes",
          status: "failed",
          value: file.size,
          message: `submission.css exceeds the ${input.maximumBytes}-byte limit`,
        }),
      ],
      [`submission.css exceeds the ${input.maximumBytes}-byte limit`],
      [],
      null,
    );
  }
  const bytes = file.bytes;

  const digest = sha256(bytes);
  if (bytes.byteLength > input.maximumBytes) {
    return baseValidation(
      "invalid",
      digest,
      bytes.byteLength,
      [
        check({
          code: "submission_bytes",
          status: "failed",
          value: bytes.byteLength,
          message: `submission.css exceeds the ${input.maximumBytes}-byte limit`,
        }),
      ],
      [`submission.css exceeds the ${input.maximumBytes}-byte limit`],
      [],
      null,
    );
  }

  let css: string;
  try {
    css = UTF8_DECODER.decode(bytes);
  } catch {
    return baseValidation(
      "invalid",
      digest,
      bytes.byteLength,
      [
        check({
          code: "utf8",
          status: "failed",
          message: "submission.css is not valid UTF-8",
        }),
      ],
      ["submission.css is not valid UTF-8"],
      [],
      null,
    );
  }

  let root: Root;
  try {
    root = postcss.parse(css, { map: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CSS parse failed";
    return baseValidation(
      "invalid",
      digest,
      bytes.byteLength,
      [check({ code: "css_parse", status: "failed", message })],
      [message],
      [],
      null,
    );
  }

  const staticChecks: Validation["staticChecks"][number][] = [
    check({
      code: "submission_bytes",
      status: "passed",
      value: bytes.byteLength,
      message: "CSS is within the byte limit",
    }),
    check({ code: "utf8", status: "passed", message: "CSS decoded as UTF-8" }),
    check({ code: "css_parse", status: "passed", message: "CSS parsed successfully" }),
  ];
  const errors: string[] = [];
  let allowedFonts: Map<string, AllowedFont>;
  try {
    allowedFonts = await documentedFonts(input.challengeRoot, input.starterCssPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    staticChecks.push(check({ code: "documented_fonts", status: "failed", message }));
    errors.push(message);
    return baseValidation(
      "invalid",
      digest,
      bytes.byteLength,
      staticChecks,
      errors,
      [],
      null,
    );
  }
  staticChecks.push(
    check({
      code: "documented_fonts",
      status: "passed",
      message: "Documented challenge fonts resolved safely",
    }),
  );

  let importFound = false;
  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase() === "import") importFound = true;
  });
  staticChecks.push(
    check({
      code: "css_import",
      status: importFound ? "failed" : "passed",
      message: importFound ? "@import is not allowed" : "No @import at-rule found",
    }),
  );
  if (importFound) errors.push("@import is not allowed");

  let urlError: string | null = null;
  root.walkDecls((declaration) => {
    if (urlError !== null) return;
    for (const node of urlFunctions(declaration.value)) {
      if (node.unclosed === true) {
        urlError = "unclosed url() function";
        return;
      }
      const classified = classifyUrl(parsedUrlValue(node), allowedFonts);
      if (classified.error !== null) {
        urlError = classified.error;
        return;
      }
      const allowed = allowedFonts.get(classified.allowedPath ?? "");
      if (allowed === undefined) {
        urlError = "local URL is not a documented challenge font";
        return;
      }
    }
  });
  staticChecks.push(
    check({
      code: "css_urls",
      status: urlError === null ? "passed" : "failed",
      message: urlError === null ? "CSS URLs are local and allowlisted" : urlError,
    }),
  );
  if (urlError !== null) errors.push(urlError);

  const sanitisedCss = errors.length === 0 ? removeCommentsAndNormalise(root) : null;
  return baseValidation(
    errors.length === 0 ? "valid" : "invalid",
    digest,
    bytes.byteLength,
    staticChecks,
    errors,
    [],
    sanitisedCss,
  );
}

export const validateCssSubmission = validateSubmission;
