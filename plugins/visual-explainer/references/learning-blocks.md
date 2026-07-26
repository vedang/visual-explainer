# Learning blocks

Inline learning blocks test whether reading produced a usable mental model. They are **not** Learn/SRS cards: keep them in flow, then let later ingestion read semantic HTML and create separate atomic cards.

## Required contract

Every visual explainer has visible retrieval practice. Put one mixed block with **1–3 prompts** after each major mental model; do not turn page into quiz wall. Start from `../templates/learning-blocks.html`; validate manifest structure with `../schemas/ve-learning-source.schema.json`.

From installed or copied skill directory, run shipped validator relative to skill root:

```sh
node ./scripts/validate-learning-fixtures.mjs path/to/explainer.html
```

The CLI is structural/static validation, not proof of usable interaction. Manual browser keyboard, screen-reader/visible-feedback, narrow-screen, and print-expanded-answer checks remain mandatory before delivery.

### Write prompts

1. Read whole source before writing prompt. Test relation, boundary, sequence, hierarchy, tradeoff, or verified inference—not label trivia.
2. Make one target per prompt, objectively gradable, grounded in preceding material. Do not visually emphasize answer before retrieval.
3. **Pause & recall:** free recall, then concise reveal. Good for terms, relations, ordered steps, or diagram flow.
4. **Apply the model:** one scenario prompt per block, with realistic adjacent distractors. Reveal correct answer and why tempting alternative fails.
5. Do not copy inline MCQ into SRS deck. Later cards use short atomic recall, source evidence, and reverse/multi-angle forms only when retrieval direction changes.

## Semantic interaction patterns

### Pause & recall

- Block uses `data-ve-learning-block`, `data-ve-learning-type="recall"`, `data-ve-learning-section`, and `data-ve-learning-source-locator`.
- Each prompt has `data-ve-learning-prompt`; answer has unique `id`, `data-ve-learning-answer`, and starts `hidden`.
- Reveal control is `<button type="button">` with `aria-expanded="false"` and `aria-controls` targeting answer. Script toggles both hidden state and expanded state.
- Answer is `role="region"` and its `aria-labelledby` resolves to visible question text. Give textual explanation, not success color alone.

### Apply the model

- Use `<form>` with exactly one `<fieldset data-ve-learning-prompt>` and meaningful `<legend>` question. Schema-v1 permits exactly **one Apply prompt per block**.
- Choices use native radio inputs inside labels, share one non-empty `name`, and use unique non-empty values. `data-correct-value` maps to one choice.
- Submit is semantic button with `aria-controls` targeting hidden answer. Feedback target has `data-ve-learning-feedback`, `role="status"`, and `aria-live="polite"`.
- On no selection, keep answer hidden, explain choice is needed, focus first radio, then return. After either selected wrong or selected correct response, reveal reasoning. It may show ephemeral correct/try-again text, but never save progress or claim mastery.

## Metadata and manifest

Give every source section an ID and `data-ve-learning-section="same-id"`. Manifest describes complete source outline: `learningBlocks` is required on every section, but may be `[]` when section has no embedded check. Artifact still needs at least one learning block total.

Give each block and prompt unique values. `data-ve-learning-source-locator` points to originating section/model and must resolve to selector of a manifest-listed source section. Deck check slides may point to preceding model slide.

Schema-v1 supports exactly this selector grammar; do not use classes, tag selectors, descendants, or selector combinations:

```text
#section-id
[data-ve-learning-block="block-id"]
[data-ve-learning-prompt="prompt-id"]
```

Embed one non-executable manifest:

```html
<script type="application/json" id="ve-learning-source">
{
  "schemaVersion": 1,
  "medium": "page",
  "source": { "id": "stable-source-id", "title": "Visible title" },
  "sections": [{
    "id": "model-section",
    "title": "Model section",
    "selector": "#model-section",
    "learningBlocks": [{
      "id": "model-recall",
      "type": "recall",
      "selector": "[data-ve-learning-block=\"model-recall\"]",
      "prompts": [{
        "id": "model-prompt",
        "selector": "[data-ve-learning-prompt=\"model-prompt\"]"
      }]
    }]
  }]
}
</script>
```

Schema-v1 manifest has only structural identity: `schemaVersion`, medium, source IDs/title/optional URLs, ordered sections, block IDs/types/selectors, and prompt IDs/selectors. It must never duplicate question, answer, choices, or reasoning text. Objects are closed (`additionalProperties: false`); add fields only in future schema version.

## Versioned local component assets

Every artifact has exactly one inline `<style data-ve-learning-style="1">` and one inline `<script data-ve-learning-runtime="1">`. Marked style includes print-expanded hidden answers, narrow-screen rules, and reduced-motion handling. Marked runtime is local, has no `src`, no dynamic import, and no network or persistence API. Expose `globalThis.veLearning.evaluateApplication(selected, correct)` so grading policy remains testable without DOM.

Learning components are local-only: inside block markup and marked style/runtime, use no automatic requests except `data:` or `blob:` single-resource values. `srcset` is forbidden in schema-v1 learning components. This includes resource attributes such as `src`, `poster`, `action`, and `formaction`. Normal navigational citations may use `<a href="https://…">`.

Existing page-level CDN/library choices remain governed by their routed template/reference (for example `libraries.md`); they are outside learning-runtime validation unless placed inside learning component scope.

## Accessibility, print, responsive

- Use headings, buttons, forms, fieldsets, legends, labels, and visible text feedback. Keyboard behavior comes from native controls; preserve focus and readable contrast.
- Pair `aria-expanded` and `aria-controls`; make feedback polite live text. Never communicate correctness through color alone.
- No login, durable progress, analytics, or mastery claims. State lasts current page only and resets on reload.
- Add `@media print` that displays `[data-ve-learning-answer][hidden]` and disables interaction-only controls. Add narrow-screen layout rules; never require horizontal scroll to answer. Respect `prefers-reduced-motion: reduce`.
- Use namespaced component styles so learning blocks inherit page visual direction rather than force one card aesthetic.

## Medium placement

| Medium | Treatment |
|---|---|
| Prose page | Mixed recall/apply block after major model or conceptual section. |
| Diagram | Ask reader to infer flow, invariant, bottleneck, or consequence—not recite node label. Include `diagram-shell`. |
| Table | Compact synthesis/apply prompt tests comparison or tradeoff. Include semantic `<table>`. |
| Review/audit/diff | Scenario/synthesis prompt tests consequence, severity, priority, or smallest effective fix. Include `data-review-finding`. |
| Slide deck | Section-ending `slide--learning` check slide contains block, fits `100dvh`, and retains deck navigation. |

## Final check

Confirm every artifact contains visible retrieval; each block has 1–3 source-grounded prompts (one for Apply); source-outline sections, manifest, and DOM selectors agree; both answer paths work by keyboard; answer/reasoning remains visible in print; mobile layout works; marked runtime/style stay local; then run mandatory browser interaction and print checks.
