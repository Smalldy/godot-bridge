# Requirement Packets

> A Requirement Packet is the durable source of truth between "we aligned in chat" and "we split implementation cards". No UI/interaction card without one.

## When required

Any card that changes user-visible interaction, copy, defaults, or state policy must reference a packet. Pure refactors/API-only cards can skip it.

## Location and versioning

```text
docs/refactor/specs/<topic>.md
```

Header:

```md
> Status: v1 (YYYY-MM-DD)
> Supersedes: v0 / none
```

## Required sections

1. Product decisions already aligned
2. Scenarios / event catalog
3. Common panel structure (if any)
4. Per-event copy: title, body, options, descriptions, default, timeout
5. Defaults table
6. Acceptance test requirements
7. Change control

## Card contract

Every implementation card starts with:

```text
Spec: docs/refactor/specs/<topic>.md
Scenarios: <section ids this card owns>
```

The card holds only:

- the subset of scenarios it implements
- writeFiles/dependsOn/verify
- acceptance/probes
- open questions

The card must not duplicate long copy. It may quote short labels for tests.

## Definition of Ready

Before creating cards:

- [ ] packet exists and is reviewed
- [ ] every scenario has copy/default/timeout
- [ ] high-risk actions have explicit confirmation
- [ ] acceptance includes copy-key/snapshot assertions
- [ ] dependencies are logical, not just file overlap
- [ ] card split has one invariant per card

## Change control

- Copy change: edit packet, bump version, update i18n/tests in the same change.
- Card change: update packet reference, not a stale copy.
- A card that discovers an unstated decision must stop and update the packet first.

## Example

[`decision-requests.md`](decision-requests.md) is the v1 reference implementation of this format.
