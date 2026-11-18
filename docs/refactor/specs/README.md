# Requirement Packets

> A Requirement Packet is the durable source of truth between "we aligned in chat" and "we split implementation cards".
> It is a general requirements baseline, not a UI copy template.

## When required

Use a packet when work is:

- split across multiple cards
- introducing a new cross-card contract/schema/state model
- ambiguous enough that card writers would otherwise guess
- likely to change during implementation

A single small card can stay self-contained in `spec/acceptance`; do not add a packet just to satisfy a template.

## Location and versioning

```text
docs/refactor/specs/<topic>.md
```

Header:

```md
> Status: v1 (YYYY-MM-DD)
> Supersedes: v0 / none
```

## Minimal required sections

1. **Goal and success** — what outcome is correct
2. **Scope / non-goals** — what is included and explicitly excluded
3. **Decisions and constraints** — already aligned, non-negotiable choices
4. **Scenarios** — stable IDs (`S1`, `S2`, ...) with acceptance criteria
5. **Open questions** — unresolved items that block card creation
6. **Change control** — how amendments are versioned

Optional sections, only when relevant:

- interfaces / API / data model
- state machine / events
- UI structure and copy
- defaults / timeouts / limits
- migration / rollback
- security / high-risk confirmation

Do not add empty sections.

## Scenario IDs

Every acceptance claim maps to a scenario:

```text
S1 create a card
S2 reject creation
S3 timeout continuation
```

Cards reference the scenarios they own:

```text
Spec: docs/refactor/specs/<topic>.md
Scenarios: S1, S2
```

Tests should name the scenario ID so coverage is traceable.

## Card contract

A card contains only:

- packet reference + scenario IDs
- its own writeFiles/dependsOn/verify
- acceptance/probes
- open questions not already resolved

Long copy, schemas, event tables stay in the packet or a linked annex.

## Definition of Ready

Before creating cards:

- [ ] goal and non-goals are explicit
- [ ] every scenario has acceptance
- [ ] decisions are dated and versioned
- [ ] open questions are closed or assigned
- [ ] dependencies are logical, not just file overlap
- [ ] card split has one invariant per card

## Change control

- Change requirement: edit packet, bump version, update affected cards/tests.
- Do not patch requirements only in chat or in a card spec.
- A card that discovers an unstated decision stops and updates the packet first.

## Example

[`decision-requests.md`](decision-requests.md) is a **UI-specific instance** of this format. Its copy table is an optional annex, not part of the general standard.
