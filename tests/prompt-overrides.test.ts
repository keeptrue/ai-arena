import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetDbForTests, useMemoryDb } from "../src/db/client";
import {
  clearPromptOverride,
  getPromptOverride,
  listPromptOverrides,
  setPromptOverride,
} from "../src/db/repo";

beforeAll(() => {
  useMemoryDb();
});

afterAll(() => {
  resetDbForTests();
});

describe("prompt overrides", () => {
  test("an untouched database reports nothing saved", () => {
    expect(listPromptOverrides()).toEqual([]);
    expect(getPromptOverride("judge.system")).toBeNull();
  });

  test("saving twice keeps one row and the latest body", () => {
    setPromptOverride("judge.system", "第一版");
    setPromptOverride("judge.system", "第二版");
    expect(getPromptOverride("judge.system")).toBe("第二版");
    expect(listPromptOverrides()).toHaveLength(1);
    expect(listPromptOverrides()[0].updatedAt).toBeGreaterThan(0);
  });

  test("clearing the row hands control back to the built-in template", () => {
    clearPromptOverride("judge.system");
    expect(getPromptOverride("judge.system")).toBeNull();
    expect(listPromptOverrides()).toEqual([]);
  });
});
