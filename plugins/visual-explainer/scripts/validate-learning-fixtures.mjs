#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = process.cwd();
const MEDIA = new Set(["page", "diagram", "table", "review", "deck"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DANGEROUS_API = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|CacheStorage|caches|cookieStore)\b|document\s*\.\s*cookie/i;
const DYNAMIC_IMPORT = /\bimport\s*\(/i;
const RESOURCE_ATTRIBUTES = new Map([
  ["img", ["src", "srcset"]],
  ["source", ["src", "srcset"]],
  ["video", ["src", "poster"]],
  ["audio", ["src"]],
  ["iframe", ["src"]],
  ["embed", ["src"]],
  ["object", ["data"]],
  ["script", ["src"]],
  ["link", ["href"]],
  ["input", ["src", "formaction"]],
  ["button", ["formaction"]],
  ["form", ["action"]],
]);

function attrsFrom(source) {
  const attrs = new Map();
  const duplicateNames = new Set();
  const attribute = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attribute.exec(source))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (attrs.has(name)) duplicateNames.add(name);
    else attrs.set(name, value);
  }
  return { attrs, duplicateNames };
}

function parseHtml(html) {
  const nodes = [];
  const stack = [];
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s[^<>]*?)?\s*\/?\s*>/g;
  let match;

  while ((match = token.exec(html))) {
    const raw = match[0];
    if (/^<!--|^<![^-]/.test(raw)) continue;

    const closing = /^<\//.test(raw);
    const nameMatch = raw.match(/^<\/?\s*([A-Za-z][A-Za-z0-9:_-]*)/);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();

    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === tag) {
          const node = stack[index];
          node.contentEnd = match.index;
          node.end = token.lastIndex;
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const attributeSource = raw
      .replace(/^<[A-Za-z][A-Za-z0-9:_-]*/, "")
      .replace(/\/?\s*>$/, "");
    const { attrs, duplicateNames } = attrsFrom(attributeSource);
    const node = {
      tag,
      attrs,
      duplicateNames,
      parent: stack.at(-1) ?? null,
      start: match.index,
      contentStart: token.lastIndex,
      contentEnd: html.length,
      end: html.length,
    };
    nodes.push(node);

    if (RAW_TEXT_TAGS.has(tag)) {
      const closingTag = new RegExp(`<\\/\\s*${tag}\\s*>`, "ig");
      closingTag.lastIndex = token.lastIndex;
      const close = closingTag.exec(html);
      if (close) {
        node.contentEnd = close.index;
        node.end = close.index + close[0].length;
        token.lastIndex = node.end;
      }
      continue;
    }
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(raw)) stack.push(node);
  }
  return nodes;
}

function contentOf(node, html) {
  return html.slice(node.contentStart, node.contentEnd);
}

function textOf(node, html) {
  return contentOf(node, html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function descendants(node, nodes) {
  return nodes.filter((candidate) => {
    for (let parent = candidate.parent; parent; parent = parent.parent) {
      if (parent === node) return true;
    }
    return false;
  });
}

function hasAncestor(node, predicate) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (predicate(parent)) return true;
  }
  return false;
}

function isDescendantOf(node, ancestor) {
  return hasAncestor(node, (parent) => parent === ancestor);
}

function parseSelector(selector) {
  if (typeof selector !== "string") return undefined;
  const id = selector.match(/^#([A-Za-z][A-Za-z0-9_-]*)$/);
  if (id) return { kind: "section", value: id[1] };
  const marker = selector.match(/^\[data-ve-learning-(block|prompt)="([A-Za-z][A-Za-z0-9_-]*)"\]$/);
  if (marker) return { kind: marker[1], value: marker[2] };
  return undefined;
}

function nodeMatches(node, selector) {
  const parsed = parseSelector(selector);
  if (!parsed) return false;
  if (parsed.kind === "section") return node.attrs.get("id") === parsed.value;
  return node.attrs.get(`data-ve-learning-${parsed.kind}`) === parsed.value;
}

function findSelector(nodes, selector) {
  return nodes.filter((node) => nodeMatches(node, selector));
}

function requireOne(nodes, selector, label, errors) {
  const found = findSelector(nodes, selector);
  if (found.length === 0) errors.push(`${label} not found for selector ${selector}`);
  else if (found.length > 1) errors.push(`${label} selector matches multiple DOM elements: ${selector}`);
  return found[0];
}

function invisibleReason(node, allowOwnHidden = false) {
  for (let current = node; current; current = current.parent) {
    if (current.tag === "template") return "template ancestry";
    if (current.attrs.has("hidden") && !(allowOwnHidden && current === node)) return "hidden ancestry";
    if (current.attrs.has("inert")) return "inert ancestry";
    if (current.attrs.get("aria-hidden")?.trim().toLowerCase() === "true") return "aria-hidden=true ancestry";
  }
  return undefined;
}

function requireUsableVisibility(node, label, errors, allowOwnHidden = false) {
  const reason = invisibleReason(node, allowOwnHidden);
  if (reason) errors.push(`${label} must be visible; found ${reason}`);
  return !reason;
}

function validateDomMarkerValues(nodes, attribute, label, errors, requireUnique = true) {
  const seen = new Set();
  for (const node of nodes.filter((candidate) => candidate.attrs.has(attribute))) {
    const value = node.attrs.get(attribute);
    if (!ID_PATTERN.test(value)) errors.push(`${label} must match ${ID_PATTERN}`);
    else if (requireUnique && seen.has(value)) errors.push(`duplicate ${label}: ${value}`);
    else seen.add(value);
    requireUsableVisibility(node, label, errors);
  }
  return seen;
}

function validateDuplicateAttributes(nodes, errors) {
  for (const node of nodes) {
    for (const name of node.duplicateNames) {
      errors.push(`duplicate attribute ${name} on <${node.tag}> is not allowed`);
    }
  }
}

function addUnique(value, label, seen, errors) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    errors.push(`${label} must match ${ID_PATTERN}`);
    return;
  }
  if (seen.has(value)) errors.push(`duplicate ${label}: ${value}`);
  seen.add(value);
}

function requireNonBlank(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${label} must be a non-empty string`);
}

function validateSelector(value, label, expectedKind, errors) {
  const parsed = parseSelector(value);
  if (!parsed) {
    errors.push(`${label} must use supported selector syntax (#id, [data-ve-learning-block="id"], or [data-ve-learning-prompt="id"])`);
    return undefined;
  }
  if (expectedKind && parsed.kind !== expectedKind) {
    errors.push(`${label} must use ${expectedKind === "section" ? "#id" : `[data-ve-learning-${expectedKind}="id"]`} selector syntax`);
  }
  return parsed;
}

function closedObject(value, label, required, allowed, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of required) {
    if (!(key in value)) errors.push(`${label} missing required ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unsupported property ${key}`);
  }
  return true;
}

function validateManifestShape(manifest, errors) {
  const ids = new Set();
  const rootKeys = new Set(["schemaVersion", "medium", "source", "sections"]);
  if (!closedObject(manifest, "manifest", ["schemaVersion", "medium", "source", "sections"], rootKeys, errors)) return [];
  if (manifest.schemaVersion !== 1) errors.push("manifest schemaVersion must be 1");
  if (!MEDIA.has(manifest.medium)) errors.push(`manifest medium must be one of ${[...MEDIA].join(", ")}`);

  const sourceKeys = new Set(["id", "title", "canonicalUrl", "versionUrl"]);
  if (closedObject(manifest.source, "manifest source", ["id", "title"], sourceKeys, errors)) {
    addUnique(manifest.source.id, "source id", ids, errors);
    requireNonBlank(manifest.source.title, "manifest source title", errors);
    for (const key of ["canonicalUrl", "versionUrl"]) {
      if (key in manifest.source) requireNonBlank(manifest.source[key], `manifest source ${key}`, errors);
    }
  }

  if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
    errors.push("manifest sections must be a non-empty array");
    return [];
  }

  const sections = [];
  let blockCount = 0;
  for (const [sectionIndex, section] of manifest.sections.entries()) {
    const sectionLabel = `section ${sectionIndex + 1}`;
    const sectionKeys = new Set(["id", "title", "selector", "learningBlocks"]);
    if (!closedObject(section, sectionLabel, ["id", "title", "selector", "learningBlocks"], sectionKeys, errors)) continue;
    addUnique(section.id, "section id", ids, errors);
    requireNonBlank(section.title, `${sectionLabel} title`, errors);
    validateSelector(section.selector, `${sectionLabel} selector`, "section", errors);
    if (!Array.isArray(section.learningBlocks)) {
      errors.push(`${sectionLabel} learningBlocks must be an array`);
      continue;
    }

    for (const [blockIndex, block] of section.learningBlocks.entries()) {
      blockCount += 1;
      const blockLabel = `${sectionLabel} block ${blockIndex + 1}`;
      const blockKeys = new Set(["id", "type", "selector", "prompts"]);
      if (!closedObject(block, blockLabel, ["id", "type", "selector", "prompts"], blockKeys, errors)) continue;
      addUnique(block.id, "learning block id", ids, errors);
      if (block.type !== "recall" && block.type !== "apply") errors.push(`${blockLabel} type must be recall or apply`);
      validateSelector(block.selector, `${blockLabel} selector`, "block", errors);
      if (!Array.isArray(block.prompts) || block.prompts.length < 1 || block.prompts.length > 3) {
        errors.push(`${blockLabel} prompts must contain 1–3 items`);
        continue;
      }
      if (block.type === "apply" && block.prompts.length !== 1) {
        errors.push(`${blockLabel} apply block must contain exactly one prompt`);
      }
      for (const [promptIndex, prompt] of block.prompts.entries()) {
        const promptLabel = `${blockLabel} prompt ${promptIndex + 1}`;
        const promptKeys = new Set(["id", "selector"]);
        if (!closedObject(prompt, promptLabel, ["id", "selector"], promptKeys, errors)) continue;
        addUnique(prompt.id, "learning prompt id", ids, errors);
        validateSelector(prompt.selector, `${promptLabel} selector`, "prompt", errors);
      }
    }
    sections.push(section);
  }
  if (blockCount === 0) errors.push("artifact requires at least one visible learning block");
  return sections;
}

function answerForControl(block, prompt, control, nodes, html, errors, label, requirePromptContainment = true) {
  const targetId = control?.attrs.get("aria-controls");
  if (!targetId) {
    errors.push(`${label} requires aria-controls`);
    return undefined;
  }
  const target = nodes.filter((node) => node.attrs.get("id") === targetId);
  if (target.length !== 1) {
    errors.push(`${label} aria-controls target not found: ${targetId}`);
    return undefined;
  }
  const answer = target[0];
  if (!isDescendantOf(answer, block)) errors.push(`${label} aria-controls target must stay inside its learning block`);
  if (requirePromptContainment && !isDescendantOf(answer, prompt)) errors.push(`${label} aria-controls target must stay inside its learning prompt`);
  if (!answer.attrs.has("data-ve-learning-answer")) errors.push(`${label} aria-controls target requires data-ve-learning-answer`);
  if (!answer.attrs.has("hidden")) errors.push(`${label} answer must begin hidden`);
  requireUsableVisibility(answer, `${label} answer`, errors, true);
  if (!textOf(answer, html)) errors.push(`${label} answer needs visible textual reasoning`);
  return answer;
}

function requireResolvedIdRef(node, attribute, nodes, label, errors) {
  const value = node.attrs.get(attribute);
  if (!value) {
    errors.push(`${label} requires ${attribute}`);
    return;
  }
  const targets = nodes.filter((candidate) => candidate.attrs.get("id") === value);
  if (targets.length !== 1) errors.push(`${label} ${attribute} target not found: ${value}`);
}

function validateRecall(block, prompt, nodes, html, errors) {
  const buttons = descendants(prompt, nodes).filter((node) => node.tag === "button");
  if (buttons.length !== 1) {
    errors.push(`recall prompt ${prompt.attrs.get("data-ve-learning-prompt")} requires one semantic button`);
    return;
  }
  const button = buttons[0];
  requireUsableVisibility(button, "recall control", errors);
  if (button.attrs.get("type") !== "button") errors.push("recall control must be button type=button");
  if (button.attrs.get("aria-expanded") !== "false") errors.push("recall control must begin aria-expanded=false");
  const answer = answerForControl(block, prompt, button, nodes, html, errors, "recall control");
  if (!answer) return;
  if (answer.attrs.get("role") !== "region") errors.push("recall answer requires role=region");
  requireResolvedIdRef(answer, "aria-labelledby", nodes, "recall answer", errors);
}

function validateApply(block, prompt, nodes, html, errors) {
  requireUsableVisibility(prompt, "apply prompt", errors);
  if (block.tag !== "form") errors.push("apply block must use form");
  const fieldsets = descendants(block, nodes).filter((node) => node.tag === "fieldset");
  if (fieldsets.length !== 1 || fieldsets[0] !== prompt) errors.push("apply block requires exactly one fieldset prompt");
  if (prompt.tag !== "fieldset") errors.push("apply prompt must use fieldset");

  const promptNodes = [prompt, ...descendants(prompt, nodes)];
  if (!promptNodes.some((node) => node.tag === "legend" && textOf(node, html))) errors.push("apply prompt requires non-empty legend");
  const radios = promptNodes.filter((node) => node.tag === "input" && node.attrs.get("type") === "radio");
  const blockRadios = descendants(block, nodes).filter((node) => node.tag === "input" && node.attrs.get("type") === "radio");
  if (radios.length < 2) errors.push("apply prompt requires at least two native radio choices");
  if (radios.length !== blockRadios.length) errors.push("apply radios must stay inside the fieldset prompt");

  const names = new Set();
  const values = new Set();
  for (const radio of radios) {
    const name = radio.attrs.get("name")?.trim();
    const value = radio.attrs.get("value")?.trim();
    if (!name) errors.push("apply radio choices require non-empty name");
    else names.add(name);
    if (!value) errors.push("apply radio choices require non-empty unique values");
    else if (values.has(value)) errors.push(`apply radio values must be unique: ${value}`);
    else values.add(value);
    requireUsableVisibility(radio, "apply radio choice", errors);
    const label = [radio, ...(() => {
      const parents = [];
      for (let parent = radio.parent; parent; parent = parent.parent) parents.push(parent);
      return parents;
    })()].find((node) => node.tag === "label");
    if (!label || !textOf(label, html)) errors.push("apply radio choices must have non-empty labels");
    else requireUsableVisibility(label, "apply radio label", errors);
  }
  if (names.size > 1) errors.push("apply radio choices must share one non-empty name");

  const correctValue = block.attrs.get("data-correct-value")?.trim();
  if (!correctValue || !values.has(correctValue)) errors.push("apply data-correct-value must match one radio choice");

  const controls = descendants(block, nodes).filter((node) => node.tag === "button" && node.attrs.get("type") === "submit");
  if (controls.length !== 1) {
    errors.push("apply block requires one button type=submit");
    return;
  }
  requireUsableVisibility(controls[0], "apply submit control", errors);
  const answer = answerForControl(block, prompt, controls[0], nodes, html, errors, "apply control", false);
  if (answer) {
    if (answer.attrs.get("role") !== "status") errors.push("apply answer requires role=status");
    if (answer.attrs.get("aria-live") !== "polite") errors.push("apply answer requires aria-live=polite");
  }

  const feedback = descendants(block, nodes).filter((node) => node.attrs.has("data-ve-learning-feedback"));
  if (feedback.length !== 1) errors.push("apply block requires one data-ve-learning-feedback status");
  else {
    requireUsableVisibility(feedback[0], "apply feedback", errors);
    if (feedback[0].attrs.get("role") !== "status") errors.push("apply feedback requires role=status");
    if (feedback[0].attrs.get("aria-live") !== "polite") errors.push("apply feedback requires aria-live=polite");
  }
}

function isAllowedResource(value) {
  return /^(?:data|blob):/i.test(value.trim());
}

function validateCssResources(css, label, errors) {
  const url = /(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?\s*([^'"\s)]+)/ig;
  let match;
  while ((match = url.exec(css))) {
    if (!isAllowedResource(match[1])) errors.push(`network resource is not allowed in ${label}: ${match[1]}`);
  }
}

function validateLearningResources(nodes, html, errors) {
  for (const node of nodes) {
    const inLearningBlock = node.attrs.has("data-ve-learning-block")
      || hasAncestor(node, (parent) => parent.attrs.has("data-ve-learning-block"));
    if (!inLearningBlock) continue;

    for (const attribute of RESOURCE_ATTRIBUTES.get(node.tag) ?? []) {
      const value = node.attrs.get(attribute);
      if (!value) continue;
      if (attribute === "srcset") {
        errors.push(`srcset is not allowed in learning component (${node.tag}[srcset])`);
      } else if (!isAllowedResource(value)) {
        errors.push(`network resource request is not allowed in learning component (${node.tag}[${attribute}])`);
      }
    }
    if (node.tag === "script" && node.attrs.get("type") !== "application/json") {
      const source = contentOf(node, html);
      if (DANGEROUS_API.test(source) || DYNAMIC_IMPORT.test(source)) {
        errors.push("network or persistence API is not allowed in learning component");
      }
    }
    if (node.tag === "style") validateCssResources(contentOf(node, html), "learning component style", errors);
  }
}

function validateMarkers(nodes, html, errors) {
  const styles = nodes.filter((node) => node.tag === "style" && node.attrs.get("data-ve-learning-style") === "1");
  if (styles.length !== 1) errors.push("artifact requires exactly one data-ve-learning-style=1 marker");
  else {
    requireUsableVisibility(styles[0], "learning style marker", errors);
    const css = contentOf(styles[0], html);
    if (!/@media\s+print/i.test(css) || !/\[data-ve-learning-answer\]\[hidden\][^{]*\{[^}]*display\s*:\s*block\s*!important/i.test(css)) {
      errors.push("learning style must print-expand hidden answers");
    }
    if (!/@media\s*\([^)]*max-width\s*:/i.test(css)) errors.push("learning style must cover narrow screens");
    if (!/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce/i.test(css)) errors.push("learning style must respect reduced motion");
    validateCssResources(css, "learning style", errors);
  }

  const runtimes = nodes.filter((node) => node.tag === "script" && node.attrs.get("data-ve-learning-runtime") === "1");
  if (runtimes.length !== 1) errors.push("artifact requires exactly one data-ve-learning-runtime=1 marker");
  else {
    const runtime = runtimes[0];
    requireUsableVisibility(runtime, "learning runtime marker", errors);
    if (runtime.attrs.has("src")) errors.push("learning runtime must be inline");
    const source = contentOf(runtime, html);
    if (DANGEROUS_API.test(source) || DYNAMIC_IMPORT.test(source)) {
      errors.push("network or persistence API is not allowed in learning runtime");
    }
  }
}

function classContains(node, className) {
  return node.attrs.get("class")?.split(/\s+/).includes(className);
}

function hasVisibleWitness(nodes, predicate) {
  return nodes.some((node) => predicate(node) && !invisibleReason(node));
}

function validateSourceOutlineRoots(nodes, sectionRecords, errors) {
  const roots = nodes.filter((node) => {
    const id = node.attrs.get("id");
    return id
      && node.attrs.get("data-ve-learning-section") === id
      && !node.attrs.has("data-ve-learning-block")
      && !invisibleReason(node);
  });
  for (const root of roots) {
    const id = root.attrs.get("id");
    const record = sectionRecords.get(`#${id}`);
    if (!record || record.section.id !== id) {
      errors.push(`source outline section omitted from manifest: #${id}`);
    }
  }
}

function validateMedium(manifest, nodes, html, errors) {
  if (manifest.medium === "diagram" && !hasVisibleWitness(nodes, (node) => classContains(node, "diagram-shell"))) {
    errors.push("diagram medium requires visible diagram-shell");
  }
  if (manifest.medium === "table" && !hasVisibleWitness(nodes, (node) => node.tag === "table")) {
    errors.push("table medium requires visible table");
  }
  if (manifest.medium === "review" && !hasVisibleWitness(nodes, (node) => node.attrs.has("data-review-finding"))) {
    errors.push("review medium requires visible data-review-finding");
  }
  if (manifest.medium === "deck") {
    const slide = hasVisibleWitness(nodes, (node) => classContains(node, "slide--learning")
      && descendants(node, nodes).some((child) => child.attrs.has("data-ve-learning-block") && !invisibleReason(child)));
    if (!slide) errors.push("deck medium requires visible slide--learning containing a learning block");
    const css = nodes
      .filter((node) => node.tag === "style" && !invisibleReason(node))
      .map((node) => contentOf(node, html))
      .join("\n");
    if (!/(?:height|min-height)\s*:\s*100dvh\b/i.test(css)) errors.push("deck medium requires visible 100dvh styling");
  }
}

function validateDocument(path) {
  const html = readFileSync(path, "utf8");
  const nodes = parseHtml(html);
  const errors = [];
  const htmlIds = new Set();
  for (const node of nodes) {
    if (!node.attrs.has("id")) continue;
    const id = node.attrs.get("id");
    if (!id) errors.push("HTML id must be non-empty");
    else if (htmlIds.has(id)) errors.push(`duplicate HTML id: ${id}`);
    else htmlIds.add(id);
  }

  validateDuplicateAttributes(nodes, errors);
  validateDomMarkerValues(nodes, "data-ve-learning-section", "DOM learning section id", errors, false);
  validateDomMarkerValues(nodes, "data-ve-learning-block", "DOM learning block id", errors);
  validateDomMarkerValues(nodes, "data-ve-learning-prompt", "DOM learning prompt id", errors);
  validateMarkers(nodes, html, errors);
  validateLearningResources(nodes, html, errors);

  const manifests = nodes.filter((node) => node.tag === "script" && node.attrs.get("type") === "application/json" && node.attrs.get("id") === "ve-learning-source");
  if (manifests.length === 0) {
    errors.push("missing ve-learning-source manifest");
    return errors;
  }
  if (manifests.length > 1) errors.push("duplicate ve-learning-source manifest");

  let manifest;
  try {
    manifest = JSON.parse(contentOf(manifests[0], html));
  } catch (error) {
    errors.push(`invalid manifest JSON: ${error.message}`);
    return errors;
  }

  const sections = validateManifestShape(manifest, errors);
  const sectionRecords = new Map();
  for (const section of sections) {
    const sectionNode = requireOne(nodes, section.selector, `section ${section.id}`, errors);
    if (sectionRecords.has(section.selector)) errors.push(`duplicate manifest section selector: ${section.selector}`);
    else sectionRecords.set(section.selector, { section, node: sectionNode });
    if (!sectionNode) continue;
    if (sectionNode.attrs.get("data-ve-learning-section") !== section.id) {
      errors.push(`section ${section.id} requires matching data-ve-learning-section`);
    }
  }
  validateSourceOutlineRoots(nodes, sectionRecords, errors);

  const manifestBlocks = new Set();
  const manifestPrompts = new Set();
  for (const section of sections) {
    const sectionNode = sectionRecords.get(section.selector)?.node;
    for (const block of section.learningBlocks ?? []) {
      manifestBlocks.add(block.id);
      const blockNode = requireOne(nodes, block.selector, `learning block ${block.id}`, errors);
      if (!blockNode) continue;
      if (blockNode.attrs.get("data-ve-learning-block") !== block.id) errors.push(`learning block ${block.id} requires matching data-ve-learning-block`);
      if (blockNode.attrs.get("data-ve-learning-type") !== block.type) errors.push(`learning block ${block.id} requires matching data-ve-learning-type`);
      if (blockNode.attrs.get("data-ve-learning-section") !== section.id) errors.push(`learning block ${block.id} requires source section ${section.id}`);
      if (sectionNode && !isDescendantOf(blockNode, sectionNode)) errors.push(`learning block ${block.id} must stay inside section ${section.id}`);

      const locator = blockNode.attrs.get("data-ve-learning-source-locator");
      if (!locator) errors.push(`learning block ${block.id} requires data-ve-learning-source-locator`);
      else {
        validateSelector(locator, `learning block ${block.id} source locator`, "section", errors);
        const sourceSection = sectionRecords.get(locator);
        if (!sourceSection?.node) errors.push(`learning block ${block.id} source locator must resolve to a manifest-listed source section selector: ${locator}`);
      }

      for (const prompt of block.prompts ?? []) {
        manifestPrompts.add(prompt.id);
        const promptNode = requireOne(nodes, prompt.selector, `learning prompt ${prompt.id}`, errors);
        if (!promptNode) continue;
        if (promptNode.attrs.get("data-ve-learning-prompt") !== prompt.id) errors.push(`learning prompt ${prompt.id} requires matching data-ve-learning-prompt`);
        if (!isDescendantOf(promptNode, blockNode)) errors.push(`learning prompt ${prompt.id} must stay inside block ${block.id}`);
        if (block.type === "recall") validateRecall(blockNode, promptNode, nodes, html, errors);
        if (block.type === "apply") validateApply(blockNode, promptNode, nodes, html, errors);
      }
    }
  }

  for (const block of nodes.filter((node) => node.attrs.has("data-ve-learning-block"))) {
    const id = block.attrs.get("data-ve-learning-block");
    if (!manifestBlocks.has(id)) errors.push(`DOM learning block missing from manifest: ${id}`);
  }
  for (const prompt of nodes.filter((node) => node.attrs.has("data-ve-learning-prompt"))) {
    const id = prompt.attrs.get("data-ve-learning-prompt");
    if (!manifestPrompts.has(id)) errors.push(`DOM learning prompt missing from manifest: ${id}`);
  }

  validateMedium(manifest, nodes, html, errors);
  return errors;
}

function htmlFiles(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => htmlFiles(resolve(path, entry.name)))
    .filter((file) => file.toLowerCase().endsWith(".html"));
}

function main(args) {
  if (args.length === 0) {
    console.error("Usage: node plugins/visual-explainer/scripts/validate-learning-fixtures.mjs <file-or-directory> [...]");
    return 2;
  }
  const files = [];
  const inputErrors = [];
  for (const input of args) {
    try {
      files.push(...htmlFiles(resolve(input)));
    } catch (error) {
      inputErrors.push(`${input}: ${error.message}`);
    }
  }
  if (files.length === 0) inputErrors.push("no HTML files found");

  let invalid = inputErrors.length;
  for (const error of inputErrors) console.error(`INVALID ${error}`);
  for (const file of files) {
    try {
      const errors = validateDocument(file);
      const label = relative(root, file) || file;
      if (errors.length) {
        invalid += 1;
        console.error(`INVALID ${label}`);
        for (const error of errors) console.error(`  - ${error}`);
      } else {
        console.log(`VALID ${label}`);
      }
    } catch (error) {
      invalid += 1;
      console.error(`INVALID ${file}`);
      console.error(`  - ${error.message}`);
    }
  }
  if (invalid) return 1;
  console.log(`Valid learning contract: ${files.length} file(s).`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
