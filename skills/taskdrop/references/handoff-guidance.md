# Handoff destination guidance

Read only the section relevant to the current Handoff. These are selection
rules and examples, not a required Markdown template.

## Choose content for the destination

Start with what the receiving AI must do next, then preserve the evidence and
context needed to do it safely.

- For implementation, emphasize the requested behavior, accepted design,
  constraints, affected artifacts, current state, verification expectations,
  and the next executable step.
- For debugging, emphasize the observed failure, reproduction, evidence,
  hypotheses already tested, rejected paths worth avoiding, and the next
  diagnostic action.
- For design, emphasize the problem, forces and constraints, alternatives,
  decisions already made, unresolved tradeoffs, and the decision needed next.
- For research, preserve the research question, scope, source requirements,
  important evidence, confidence or uncertainty, and the intended use of the
  result.

Use headings that fit the material. Do not add empty sections or reshape every
task into a generic conversation summary.

## Data processing

Identify which of these the receiver needs:

1. Source data at useful fidelity, including its structure and provenance.
2. Processing context: methods, transformations, field meanings, assumptions,
   and known data-quality problems.
3. Results: conclusions, output artifacts, unresolved questions, and next
   processing steps.

When the request is ambiguous and these choices produce materially different
Handoffs, ask one specific question. For example:

> Should the next AI receive (A) the source rows plus all transformations,
> recommended because it must continue cleaning the data; (B) field meanings
> and processing rules without every row; or (C) conclusions and next steps
> only?

Do not ask this when the user already requested full data, processing context,
or results only.

## Deep Research to implementation

Distinguish three useful forms:

1. **Complete report** — preserve the report, its structure, important source
   links, qualifications, and implementation context.
2. **Implementation summary with key evidence** — preserve decisions,
   engineering implications, critical evidence, constraints, and source links.
   Recommend this when the receiving AI will implement and does not need every
   research detail.
3. **Implementation-only brief** — preserve actionable requirements and next
   steps with minimal research background.

If the user already asks to keep the complete report, do not ask again and do
not compress it into a few conclusions. If the preference is missing and the
choice matters, offer the three forms and recommend the implementation summary
for an engineering destination with the reason above.

## “As complete as possible”

Preserve original material and structure that helps the receiver reason,
verify, or continue. Remove duplicated conversation, repeated status messages,
and obsolete detail with no downstream value. Preserve a failed or rejected
approach only when its evidence or rationale prevents the receiver from
repeating it.

The latest explicit user instruction wins over older preferences and these
defaults. Credential removal always wins over completeness or verbatim copying.

## Material that cannot be included

Before relying on a path, link, private system, or attachment, consider whether
the receiving AI can access it. If not, include the necessary content when it
is available and safe. Otherwise, name the missing material and explain why it
was not included.

If the complete Markdown may exceed TaskDrop's 256 KiB size limit, do not
silently truncate it. Prefer accessible artifact references where they
preserve enough context. If they do not, ask one concrete question about the
best alternative, such as a focused subset versus multiple Handoffs, and
recommend the option that best supports the stated destination.

## Anti-patterns

- Never repeat a preference already stated by the user as a confirmation
  question.
- Never ask a generic preservation question detached from the current work.
- Never replace a requested complete report with a short implementation
  summary.
- Never paste a small update onto old Markdown and call it a full Revision.
- Never report only “Handoff loaded” or Revision metadata after a successful
  read; summarize the actual work that was loaded.
- Never claim a failed read or conflicted append succeeded.
