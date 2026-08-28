import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

const WIDTH = 1440;
const HEIGHT = 1200;

const compositions = [
  {
    background: "#e7e6e2",
    foreground: "#b8b7b0",
    detail: "#d1d0c9",
    shape: `<rect x="150" y="150" width="680" height="900" rx="16"/><rect x="920" y="260" width="240" height="470"/>`,
  },
  {
    background: "#dedfdc",
    foreground: "#a9aaa5",
    detail: "#c5c6c0",
    shape: `<circle cx="720" cy="600" r="360"/><rect x="180" y="160" width="190" height="880"/>`,
  },
  {
    background: "#ece9e1",
    foreground: "#b9b3a8",
    detail: "#d5d0c5",
    shape: `<path d="M80 940 L520 180 L1080 980 Z"/><rect x="950" y="140" width="260" height="260"/>`,
  },
  {
    background: "#e1e4e4",
    foreground: "#aeb8b8",
    detail: "#c9cece",
    shape: `<rect x="160" y="190" width="1120" height="210"/><rect x="320" y="570" width="800" height="340"/>`,
  },
  {
    background: "#e9e3df",
    foreground: "#baa9a2",
    detail: "#d4c6c0",
    shape: `<ellipse cx="720" cy="610" rx="510" ry="280"/><rect x="170" y="850" width="1100" height="110"/>`,
  },
  {
    background: "#e3e6e9",
    foreground: "#aeb7c0",
    detail: "#cbd1d6",
    shape: `<path d="M140 200 H1300 V1000 H140 Z"/><path d="M240 300 H1200 V900 H240 Z"/>`,
  },
] as const;

function compositionSvg(index: number): string {
  const composition = compositions[index];
  if (composition === undefined) {
    throw new Error(`No seed composition exists for index ${index}`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${composition.background}"/>
  <g fill="${composition.foreground}" opacity="0.72">${composition.shape}</g>
  <g fill="none" stroke="${composition.detail}" stroke-width="18" opacity="0.9">
    <path d="M100 100 H1340 V1100 H100 Z"/>
    <path d="M180 600 H1260"/>
  </g>
</svg>`;
}

export async function createSeedThumbnailAssets(
  outputDirectory: string,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    compositions.map((_, index) =>
      sharp(Buffer.from(compositionSvg(index)))
        .png()
        .toFile(join(outputDirectory, `seed-0${index + 1}.png`)),
    ),
  );
}
