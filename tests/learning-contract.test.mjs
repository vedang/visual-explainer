import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "plugins", "visual-explainer");
const validator = join(plugin, "scripts", "validate-learning-fixtures.mjs");
const fixtures = join(root, "tests", "fixtures", "learning");

function readRequired(path) {
  assert.ok(existsSync(path), `required file missing: ${path.slice(root.length + 1)}`);
  return readFileSync(path, "utf8");
}

function manifestFrom(html, label) {
  const match = html.match(
    /<script\b(?=[^>]*\btype=["']application\/json["'])(?=[^>]*\bid=["']ve-learning-source["'])[^>]*>([\s\S]*?)<\/script>/i,
  );
  assert.ok(match, `${label}: missing ve-learning-source manifest`);
  return JSON.parse(match[1]);
}

function runValidator(path) {
  return spawnSync(process.execPath, [validator, path], {
    cwd: root,
    encoding: "utf8",
  });
}

test("package exposes all learning-contract resources", () => {
  const required = [
    join(plugin, "references", "learning-blocks.md"),
    join(plugin, "templates", "learning-blocks.html"),
    join(plugin, "schemas", "ve-learning-source.schema.json"),
    validator,
  ];

  for (const path of required) assert.ok(existsSync(path), `missing ${path.slice(root.length + 1)}`);

  const pkg = JSON.parse(readRequired(join(root, "package.json")));
  assert.equal(pkg.scripts?.test, "node --test", "package test script must use Node's built-in runner");
  assert.ok(pkg.files.includes("plugins/visual-explainer"), "published package must include skill resources");

  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const packedPaths = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
  assert.ok(
    packedPaths.includes("plugins/visual-explainer/scripts/validate-learning-fixtures.mjs"),
    "published and copy-based skill installs must include validator",
  );
});

test("SKILL.md routes authors through mandatory learning treatment", () => {
  const skill = readRequired(join(plugin, "SKILL.md"));

  assert.match(skill, /references\/learning-blocks\.md/);
  assert.match(skill, /templates\/learning-blocks\.html/);
  assert.match(skill, /schemas\/ve-learning-source\.schema\.json/);
  assert.match(skill, /Pause & recall/i);
  assert.match(skill, /Apply the model/i);
  assert.match(skill, /inline[^\n]*(?:not|separate)[^\n]*(?:SRS|spaced.repetition)/i);
  assert.match(skill, /1[–-]3 prompts/i);
  assert.match(skill, /prose|page/i);
  assert.match(skill, /diagram/i);
  assert.match(skill, /table/i);
  assert.match(skill, /review/i);
  assert.match(skill, /slide|deck/i);
  assert.match(skill, /every[^\n]*(?:explainer|artifact)[^\n]*(?:retrieval|learning)/i);
});

test("manifest schema v1 is closed, structural, and covers every medium", () => {
  const schema = JSON.parse(
    readRequired(join(plugin, "schemas", "ve-learning-source.schema.json")),
  );

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "medium", "source", "sections"]);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.properties.medium.enum, ["page", "diagram", "table", "review", "deck"]);

  const source = schema.$defs.source;
  assert.equal(source.additionalProperties, false);
  assert.deepEqual(source.required, ["id", "title"]);
  assert.ok(source.properties.canonicalUrl);
  assert.ok(source.properties.versionUrl);

  const section = schema.$defs.section;
  assert.equal(section.additionalProperties, false);
  assert.deepEqual(section.required, ["id", "title", "selector", "learningBlocks"]);
  assert.equal(section.properties.learningBlocks.minItems ?? 0, 0, "source outline may contain sections without checks");
  assert.equal(
    schema.properties.sections.contains?.properties?.learningBlocks?.minItems,
    1,
    "schema must require at least one checked section across artifact",
  );

  const selectorPattern = new RegExp(schema.$defs.selector.pattern);
  assert.ok(selectorPattern.test("#model-section"));
  assert.ok(selectorPattern.test('[data-ve-learning-block="model-recall"]'));
  assert.ok(selectorPattern.test('[data-ve-learning-prompt="model-prompt"]'));
  assert.equal(selectorPattern.test(".model-section"), false, "schema must publish validator selector subset");

  const block = schema.$defs.learningBlock;
  assert.equal(block.additionalProperties, false);
  assert.deepEqual(block.required, ["id", "type", "selector", "prompts"]);
  assert.deepEqual(block.properties.type.enum, ["recall", "apply"]);
  assert.equal(
    block.allOf?.[0]?.then?.properties?.prompts?.maxItems,
    1,
    "Apply block v1 must contain exactly one independently gradable prompt",
  );

  const prompt = schema.$defs.prompt;
  assert.equal(prompt.additionalProperties, false);
  assert.deepEqual(prompt.required, ["id", "selector"]);

  const serialized = JSON.stringify(schema);
  for (const duplicatedContentField of ["question", "answer", "reasoning", "choices"]) {
    assert.doesNotMatch(
      serialized,
      new RegExp(`"${duplicatedContentField}"`),
      `manifest must not duplicate visible ${duplicatedContentField} text`,
    );
  }
});

test("canonical template demonstrates both accessible local-only components", () => {
  const html = readRequired(join(plugin, "templates", "learning-blocks.html"));

  assert.match(html, /data-ve-learning-block=/);
  assert.match(html, /data-ve-learning-type=["']recall["']/);
  assert.match(html, /data-ve-learning-type=["']apply["']/);
  assert.match(html, /data-ve-learning-section=/);
  assert.match(html, /data-ve-learning-source-locator=/);
  assert.match(html, /data-ve-learning-prompt=/);
  assert.match(html, /<button\b[^>]*\btype=["']button["'][^>]*>/i);
  assert.match(html, /aria-expanded=["']false["']/i);
  assert.match(html, /aria-controls=/i);
  assert.match(html, /<fieldset\b/i);
  assert.match(html, /<legend\b/i);
  assert.match(html, /aria-live=["']polite["']/i);
  assert.match(html, /@media\s+print/i);
  assert.match(html, /@media\s*\([^)]*prefers-reduced-motion:\s*reduce/i);
  assert.match(html, /@media\s*\([^)]*max-width:/i);
  assert.match(html, /\[data-ve-learning-answer\]\[hidden\][^{]*\{[^}]*display:\s*block\s*!important/is);

  const runtimeMatch = html.match(/<script\b[^>]*data-ve-learning-runtime=["']1["'][^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(runtimeMatch, "canonical template needs versioned local learning runtime");
  const executableScripts = [...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join("\n");
  assert.doesNotMatch(
    executableScripts,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b|document\.cookie/i,
  );
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i, "canonical component must not load remote scripts");

  const context = {};
  vm.runInNewContext(runtimeMatch[1], context);
  const unanswered = context.veLearning.evaluateApplication(null, "client");
  assert.equal(unanswered.reveal, false, "Apply answer stays hidden until choice exists");
  const incorrect = context.veLearning.evaluateApplication("controller", "client");
  assert.equal(incorrect.reveal, true);
  assert.equal(incorrect.correct, false);
  const correct = context.veLearning.evaluateApplication("client", "client");
  assert.equal(correct.reveal, true);
  assert.equal(correct.correct, true);
});

test("valid fixtures cover page, diagram, table, review, and deck treatments", () => {
  const validDir = join(fixtures, "valid");
  const files = readdirSync(validDir).filter((name) => name.endsWith(".html")).sort();
  assert.deepEqual(files, ["deck.html", "diagram.html", "page.html", "review.html", "table.html"]);

  const seenMedia = new Set();
  const seenTypes = new Set();

  for (const file of files) {
    const html = readRequired(join(validDir, file));
    const manifest = manifestFrom(html, file);
    seenMedia.add(manifest.medium);
    assert.equal(manifest.medium, basename(file, ".html"));
    assert.ok(manifest.sections.length > 0, `${file}: needs source section`);
    assert.match(html, /<style\b[^>]*data-ve-learning-style=["']1["']/i, `${file}: needs print/responsive learning styles`);
    assert.match(html, /<script\b[^>]*data-ve-learning-runtime=["']1["']/i, `${file}: needs working local learning runtime`);
    assert.match(html, /@media\s+print/i, `${file}: answers must print expanded`);
    assert.match(html, /prefers-reduced-motion:\s*reduce/i, `${file}: must respect reduced motion`);

    const blocks = manifest.sections.flatMap((section) => section.learningBlocks);
    assert.ok(blocks.length > 0, `${file}: every artifact needs visible retrieval practice`);
    for (const block of blocks) {
      seenTypes.add(block.type);
      assert.ok(block.prompts.length >= 1 && block.prompts.length <= 3, `${file}: block needs 1–3 prompts`);
    }

    if (manifest.medium === "diagram") assert.match(html, /diagram-shell/);
    if (manifest.medium === "table") assert.match(html, /<table\b/i);
    if (manifest.medium === "review") assert.match(html, /data-review-finding=/);
    if (manifest.medium === "deck") {
      assert.match(html, /class=["'][^"']*slide[^"']*slide--learning/);
      assert.match(html, /height:\s*100dvh/i);
      assert.ok(
        manifest.sections.some((section) => section.id === "cache-model" && section.learningBlocks.length === 0),
        "deck manifest must preserve source model section even when check lives on following slide",
      );
    }
  }

  assert.deepEqual([...seenMedia].sort(), ["deck", "diagram", "page", "review", "table"]);
  assert.deepEqual([...seenTypes].sort(), ["apply", "recall"]);
});

test("validator accepts canonical template and every valid medium fixture", () => {
  assert.ok(existsSync(validator), "validator script must exist before it can run");

  for (const path of [join(plugin, "templates", "learning-blocks.html"), join(fixtures, "valid")]) {
    const result = runValidator(path);
    assert.equal(result.status, 0, `${path}: ${result.stderr || result.stdout}`);
    assert.match(result.stdout, /valid/i);
  }
});

test("validator rejects malformed contract fixtures with useful diagnostics", () => {
  assert.ok(existsSync(validator), "validator script must exist before it can run");

  const cases = new Map([
    ["apply-multiple-prompts.html", /apply.*one prompt|one.*apply prompt/i],
    ["broken-reference.html", /missing.*block|block.*not found/i],
    ["duplicate-html-id.html", /duplicate HTML id/i],
    ["duplicate-resource-attribute.html", /duplicate.*attribute|network.*resource/i],
    ["hidden-control.html", /visible|hidden|inert|template/i],
    ["hidden-learning.html", /visible|hidden|inert/i],
    ["inert-assets.html", /visible|hidden|inert|template/i],
    ["inert-medium.html", /diagram|visible|hidden|inert/i],
    ["inaccessible-recall.html", /aria-controls/i],
    ["invalid-manifest-json.html", /invalid manifest JSON/i],
    ["networked.html", /network|persistence/i],
    ["no-learning.html", /at least one.*learning block|visible retrieval/i],
    ["omitted-source-section.html", /manifest.*section|source.*outline|omitted/i],
    ["script-string-learning.html", /missing.*block|block.*not found/i],
    ["mixed-srcset.html", /srcset|network.*resource/i],
    ["wrong-medium.html", /deck|medium/i],
  ]);

  for (const [file, diagnostic] of cases) {
    const result = runValidator(join(fixtures, "invalid", file));
    assert.notEqual(result.status, 0, `${file}: invalid fixture unexpectedly passed`);
    assert.match(`${result.stdout}\n${result.stderr}`, diagnostic, `${file}: wrong diagnostic`);
  }
});

test("validator allows navigational citations but rejects automatic learning-component requests", () => {
  const cited = runValidator(join(fixtures, "valid", "page.html"));
  assert.equal(cited.status, 0, cited.stderr);

  const requested = runValidator(join(fixtures, "invalid", "networked-resource.html"));
  assert.notEqual(requested.status, 0, "automatic resource request unexpectedly passed");
  assert.match(`${requested.stdout}\n${requested.stderr}`, /network|resource|request/i);
});
