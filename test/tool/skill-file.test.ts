import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadSkillFile } from "../../src/skill/skill"

describe("loadSkillFile", () => {
  test("parses a SKILL.md without installing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "quark-skill-file-"))
    const file = join(dir, "SKILL.md")
    writeFileSync(file, "---\nname: candidate\ndescription: ignored\n---\nFollow candidate rules.")

    try {
      expect(loadSkillFile(file)).toBe("Follow candidate rules.")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
