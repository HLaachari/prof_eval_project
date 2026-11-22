import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { test } from "node:test";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the public seed contains no student records", async () => {
  const seed = await read("dist/seed-data.js");
  assert.match(seed, /window\.SEED_CLASSES\s*=\s*\[\s*\]/);
  assert.doesNotMatch(seed, /"massar"|"birthDate"|"students"/);
});

test("the environment example uses placeholders only", async () => {
  const example = await read(".env.example");
  assert.match(example, /USER:PASSWORD/);
  assert.match(example, /CHANGE_ME/);
  assert.doesNotMatch(example, /@(?:gmail|hotmail|outlook)\./i);
});

test("publication files are present", async () => {
  await Promise.all(["LICENSE", "README.md", "CONTRIBUTING.md"].map(path => access(new URL(`../${path}`, import.meta.url))));
});

test("local and generated sensitive artifacts stay ignored", async () => {
  const ignore = await read(".gitignore");
  for (const entry of [".env", ".idea/", "state/", "*.zip"]) assert.ok(ignore.split(/\r?\n/).includes(entry), `${entry} must be ignored`);
});
