import { afterEach, beforeEach, describe, expect, test } from "bun:test"

const { __setModelsDevDataForTest, getModelLimit } = await import("../../src/provider/models")
const { bus } = await import("../../src/session/events")

function setModels() {
  __setModelsDevDataForTest({
    nvidia: {
      id: "nvidia",
      models: {
        "nvidia/known": {
          id: "nvidia/known",
          limit: { context: 128000, output: 4096 },
        },
      },
    },
  })
}

describe("getModelLimit", () => {
  beforeEach(() => {
    setModels()
  })

  afterEach(() => {
    __setModelsDevDataForTest(null)
    bus.removeAllListeners()
  })

  test("returns known catalog limits", () => {
    expect(getModelLimit("nvidia/nvidia/known")).toEqual({
      context: 128000,
      output: 4096,
    })
  })

  test("does not emit provider errors for missing catalog metadata", () => {
    const errors: unknown[] = []
    bus.on("error", (data) => errors.push(data.error))

    expect(getModelLimit("nvidia/nvidia/missing")).toBeNull()
    expect(errors).toEqual([])
  })

  test("does not emit provider errors for invalid metadata lookup specs", () => {
    const errors: unknown[] = []
    bus.on("error", (data) => errors.push(data.error))

    expect(getModelLimit("missing-provider-prefix")).toBeNull()
    expect(errors).toEqual([])
  })

  test("does not emit provider errors for missing LM Studio cache entries", () => {
    const errors: unknown[] = []
    bus.on("error", (data) => errors.push(data.error))

    expect(getModelLimit("lmstudio/missing")).toBeNull()
    expect(errors).toEqual([])
  })
})
