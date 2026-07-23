import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ReleaseNotesService } from "./release-notes.service";

describe("ReleaseNotesService", () => {
  let tmpDir: string;
  let service: ReleaseNotesService;
  const originalEnv = process.env.RELEASE_NOTES_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"));
    process.env.RELEASE_NOTES_DIR = tmpDir;
    service = new ReleaseNotesService();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.RELEASE_NOTES_DIR;
    } else {
      process.env.RELEASE_NOTES_DIR = originalEnv;
    }
    jest.restoreAllMocks();
  });

  function writeNotes(version: string, body: string): void {
    fs.writeFileSync(path.join(tmpDir, `${version}.md`), body, "utf-8");
  }

  it("reads and parses the notes for a version", () => {
    writeNotes(
      "1.2.3",
      ["# v1.2.3", "", "Hello world.", "", "## Feature", "", "Body."].join(
        "\n",
      ),
    );

    const notes = service.readNotes("1.2.3");

    expect(notes).not.toBeNull();
    expect(notes?.version).toBe("1.2.3");
    expect(notes?.intro).toBe("Hello world.");
    expect(notes?.sections[0].heading).toBe("Feature");
    expect(notes?.releaseUrl).toBe(
      "https://github.com/kenlasko/monize/releases/tag/v1.2.3",
    );
  });

  it("returns null when no notes file exists for the version", () => {
    expect(service.readNotes("9.9.9")).toBeNull();
  });

  it("rejects versions that are not plain semver (no path traversal)", () => {
    expect(service.readNotes("../secret")).toBeNull();
    expect(service.readNotes("not-a-version")).toBeNull();
  });

  it("returns null when no release-notes directory can be found", () => {
    // Point every candidate at a non-existent location: the env override plus
    // process.cwd()-derived fallbacks.
    process.env.RELEASE_NOTES_DIR = path.join(tmpDir, "missing");
    jest.spyOn(process, "cwd").mockReturnValue(path.join(tmpDir, "nowhere"));

    expect(service.readNotes("1.2.3")).toBeNull();
  });

  it("caches the current version's notes after the first read", () => {
    writeNotes(service.currentVersion, ["# v", "", "Cached.", ""].join("\n"));

    const first = service.getForCurrentVersion();
    // Change the file on disk; a cached read must still return the first parse.
    writeNotes(service.currentVersion, ["# v", "", "Changed.", ""].join("\n"));
    const second = service.getForCurrentVersion();

    expect(first).toBe(second);
    expect(second?.intro).toBe("Cached.");
  });

  it("caches a null result too (a later file does not override it)", () => {
    // No file for the current version yet -> null, and cached.
    expect(service.getForCurrentVersion()).toBeNull();

    writeNotes(service.currentVersion, ["# v", "", "Too late.", ""].join("\n"));
    expect(service.getForCurrentVersion()).toBeNull();
  });
});
