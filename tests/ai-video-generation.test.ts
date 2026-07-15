import { describe, expect, test } from "bun:test";
import { buildAiVideoPrompt, generateBusinessAiVideoGifs } from "../src/services/ai-video-generation";

const base = {
  companyName: "Example Pizza",
  website: "https://pizza.example/",
  industry: "пиццерия и доставка еды",
  services: ["неаполитанская пицца", "доставка горячей пиццы", "семейный ресторан"],
  primaryColor: "#b52323",
  secondaryColor: "#f4d58d",
  presentationSeed: "pizza-example-a1b2",
};

describe("full AI-video generation", () => {
  test("builds a site-specific pizzeria scene with a different role prompt", () => {
    const guide = buildAiVideoPrompt(base, 0);
    const demo = buildAiVideoPrompt(base, 1);

    expect(guide).toContain("Example Pizza");
    expect(guide).toContain("authentic modern pizzeria");
    expect(guide).toContain("freshly baked pizza");
    expect(guide).toContain("#b52323");
    expect(guide).toContain("No captions");
    expect(demo).not.toBe(guide);
    expect(demo).toContain("hands-on presenter");
  });

  test("changes props and background for a medical business", () => {
    const prompt = buildAiVideoPrompt({
      ...base,
      companyName: "Dental Pro",
      industry: "стоматологическая клиника",
      services: ["имплантация зубов"],
    }, 0);
    expect(prompt).toContain("clinic or pharmacy consultation space");
    expect(prompt).toContain("anatomical teaching model");
    expect(prompt).not.toContain("freshly baked pizza");
  });

  test("uses the bundled fallback when the production API key is absent", async () => {
    const result = await generateBusinessAiVideoGifs(base, "unused-without-key", undefined, {});
    expect(result).toBeUndefined();
  });
});
