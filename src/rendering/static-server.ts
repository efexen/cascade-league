import { createServer, type Server } from "node:http";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface StaticServerRequest {
  readonly method: string;
  readonly url: string;
  readonly status: number;
}

export interface LoopbackStaticServer {
  readonly origin: string;
  readonly port: number;
  readonly requests: readonly StaticServerRequest[];
  close(): Promise<void>;
}

export interface LoopbackStaticServerOptions {
  readonly rootPath: string;
  readonly entryFile?: string;
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

async function resolveRequestPath(
  rootPath: string,
  pathname: string,
  entryFile: string,
): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) return null;
  const relativePath = segments.filter((segment) => segment !== "").join("/");
  const requested = relativePath === "" ? entryFile : relativePath;
  const candidatePath = resolve(rootPath, requested);
  if (!isContained(rootPath, candidatePath)) return null;
  let current = rootPath;
  for (const segment of relative(rootPath, candidatePath).split(sep)) {
    current = resolve(current, segment);
    const status = await lstat(current).catch(() => null);
    if (status === null || status.isSymbolicLink()) return null;
  }
  const status = await lstat(candidatePath).catch(() => null);
  return status?.isFile() === true && !status.isSymbolicLink() ? candidatePath : null;
}

export async function startLoopbackStaticServer(
  options: LoopbackStaticServerOptions,
): Promise<LoopbackStaticServer> {
  const rootPath = await realpath(options.rootPath);
  const entryFile = options.entryFile ?? "challenge.html";
  const requests: StaticServerRequest[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          status: 405,
        });
        response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        response.end("Method not allowed");
        return;
      }
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      } catch {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          status: 400,
        });
        response.writeHead(400);
        response.end();
        return;
      }
      const filePath = await resolveRequestPath(rootPath, pathname, entryFile);
      if (filePath === null) {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          status: 404,
        });
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        const contents = await readFile(filePath);
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          status: 200,
        });
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": contentType(filePath),
          "content-length": contents.byteLength,
        });
        if (request.method === "HEAD") response.end();
        else response.end(contents);
      } catch {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          status: 404,
        });
        response.writeHead(404);
        response.end();
      }
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new Error("loopback static server did not receive an address");
  }
  const port = address.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    get requests() {
      return [...requests];
    },
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) =>
          error === undefined ? resolvePromise() : reject(error),
        );
      }),
  };
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}
