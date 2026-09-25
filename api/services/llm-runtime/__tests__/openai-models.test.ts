import { describe, expect, it } from "vitest";
import { openAIModelContract } from "../openai-models.js";

describe("OpenAI model contracts", () => {
  it("declares GPT-6 Sol media and input limits", () => {
    expect(openAIModelContract("gpt-6-sol")).toMatchObject({
      inputModalities: ["text", "image", "file"],
      contextLimit: 1_050_000,
      inputLimit: 922_000,
      maxTokens: 128_000,
    });
  });
});
