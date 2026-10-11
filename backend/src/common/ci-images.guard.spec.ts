import { readFileSync } from "fs";
import { join } from "path";

import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * CI pulls third-party container images from a registry without an anonymous
 * pull limit: the ECR Public mirror of the Docker Official Images
 * (`public.ecr.aws/docker/library/...`, the same content and digests as Docker
 * Hub) or GitHub's own registry (`ghcr.io`). A Docker Hub pull from a shared
 * runner IP is rate-limited, and a login needs DOCKERHUB_* secrets a fork does
 * not have, so a Docker Hub image turns a job red for reasons no change caused.
 * `docs/verification-contract.md` section 7.
 *
 * Scanned: every `image:` in `.github/workflows/*.yml` and in the compose file
 * CI runs (`docker-compose.e2e.yml`), and every `*_IMAGE=` default in
 * `scripts/*.sh`. Allowed: the two registries above, a GitHub expression
 * (`${{ ... }}`), and an image CI builds itself (a `:local` tag). Not scanned:
 * a Dockerfile's `FROM`, which the image build authenticates for.
 */

const ALLOWED = [
  /^public\.ecr\.aws\//,
  /^ghcr\.io\//,
  /^\$\{\{.*\}\}/,
  /^[a-z0-9._-]+:local$/,
];

export function disallowedImages(
  file: string,
  text: string,
): Array<{ line: number; image: string }> {
  const found: Array<{ line: number; image: string }> = [];
  const lines = text.split("\n");
  const shell = file.endsWith(".sh");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    let image: string | null = null;
    if (shell) {
      const m = /^[A-Z_]*IMAGE="(?:\$\{[A-Z_]+:-)?([^"}]+)\}?"/.exec(line);
      image = m ? m[1] : null;
    } else {
      const m = /^image:\s*["']?(.+?)["']?\s*(?:\s#.*)?$/.exec(line);
      image = m ? m[1] : null;
    }
    if (image !== null && !ALLOWED.some((pattern) => pattern.test(image))) {
      found.push({ line: index + 1, image });
    }
  }
  return found;
}

describe("disallowedImages", () => {
  it("refuses a Docker Hub image in a workflow or compose file", () => {
    expect(
      disallowedImages("ci.yml", "    image: postgres:16-alpine\n"),
    ).toEqual([{ line: 1, image: "postgres:16-alpine" }]);
    expect(
      disallowedImages("ci.yml", "    image: docker.io/library/nginx:1\n"),
    ).toEqual([{ line: 1, image: "docker.io/library/nginx:1" }]);
  });

  it("refuses a Docker Hub default in a script", () => {
    expect(
      disallowedImages("verify.sh", 'PG_IMAGE="${PG_IMAGE:-postgres:16}"\n'),
    ).toEqual([{ line: 1, image: "postgres:16" }]);
    expect(disallowedImages("verify.sh", 'PG_IMAGE="postgres:16"\n')).toEqual([
      { line: 1, image: "postgres:16" },
    ]);
  });

  it("accepts the ECR Public mirror, ghcr.io, an expression and a local build", () => {
    const text = [
      "image: public.ecr.aws/docker/library/postgres:16-alpine@sha256:abc",
      "image: ghcr.io/owner/app",
      "image: ${{ matrix.image }}@${{ steps.build.outputs.digest }}",
      "image: monize-e2e-backend:local",
      "# image: postgres:16",
    ].join("\n");
    expect(disallowedImages("ci.yml", text)).toEqual([]);
    expect(
      disallowedImages(
        "v.sh",
        'PG_IMAGE="${PG_IMAGE:-public.ecr.aws/docker/library/postgres:16}"',
      ),
    ).toEqual([]);
  });
});

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree("CI pulls no image from Docker Hub", () => {
  it("every image CI pulls comes from public.ecr.aws or ghcr.io", () => {
    const root = requireRepoRoot(REPO_ROOT);
    const files = gitListFiles(root).filter(
      (path) =>
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
        path === "docker-compose.e2e.yml" ||
        /^scripts\/[^/]+\.sh$/.test(path),
    );
    expect(files).toEqual(
      expect.arrayContaining([
        ".github/workflows/ci.yml",
        "docker-compose.e2e.yml",
        "scripts/verify-schema.sh",
      ]),
    );

    const offenders = files.flatMap((file) =>
      disallowedImages(file, readFileSync(join(root, file), "utf8")).map(
        ({ line, image }) => `${file}:${line}: ${image}`,
      ),
    );
    if (offenders.length > 0) {
      throw new Error(
        `CI pulls these images from Docker Hub (rate-limited, needs a login a fork lacks):\n  ${offenders.join(
          "\n  ",
        )}\nUse the ECR Public mirror of the official image, public.ecr.aws/docker/library/<name>:<tag> (same digests), or ghcr.io. docs/verification-contract.md section 7.`,
      );
    }
  });
});
