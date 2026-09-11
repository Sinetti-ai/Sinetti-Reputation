/**
 * The read side of the deal identity anchor.
 *
 * `SinettiEscrowV04` carries `buyerIdentityRef` / `sellerIdentityRef` /
 * `verifierIdentityRef` / `arbitratorIdentityRef` on every deal, signed into
 * seller acceptance and emitted in `DealOpened`. An identity service resolves
 * subjects to an `identity_ref` and an assurance level. Nothing joined
 * the two, so the slots are zero on every deal opened so far.
 *
 * The derivation is tested from `docs/standards/identity-anchor.vectors.json`.
 * Any other implementation should test against the same vectors, because two
 * copies of a hash derivation drift silently: nothing throws, verification just
 * starts answering "not this identity" forever.
 */
import { keccak256, toUtf8Bytes } from "ethers";

export const ANCHOR_DOMAIN = "sinetti-identity-anchor:v1";

/** Ordered weakest to strongest. */
export const ASSURANCE_LEVELS = ["none", "claimed", "proven", "proven-role"] as const;
export type AssuranceLevel = typeof ASSURANCE_LEVELS[number];

/**
 * A role with no recorded identity — not a role recorded as unproven.
 *
 * The escrow initialises these slots to zero, so the overwhelmingly common
 * value means "nobody wrote an identity here". Reporting that as assurance
 * `none` would turn silence into a finding, and a card that cannot distinguish
 * the two will always choose the more confident-sounding one.
 */
export const ZERO_ANCHOR = `0x${"00".repeat(64 / 2)}`;

export function isUnset(anchor: string | null | undefined): boolean {
  return !anchor || anchor.toLowerCase() === ZERO_ANCHOR;
}

export function identityAnchor(assurance: AssuranceLevel, identityRef: string): string {
  if (!ASSURANCE_LEVELS.includes(assurance)) throw new Error(`unknown assurance level: ${assurance}`);
  if (!identityRef) throw new Error("identityRef must not be empty");
  // identityRef verbatim: it is already canonical from the identity service, and
  // re-normalising here would create a second notion of canonical that disagrees
  // with the first on exactly the inputs nobody tests.
  return keccak256(toUtf8Bytes(`${ANCHOR_DOMAIN}:${assurance}:${identityRef}`));
}

/**
 * Which assurance level, if any, this anchor commits `identityRef` at.
 *
 * An anchor cannot be opened, only matched against a candidate. A caller who
 * already believes the counterparty is `identityRef` learns whether the deal
 * agrees and at what level; a caller with no candidate learns nothing. That is
 * the intended property, not a gap — and it is why the anchor must never be
 * described as confidential: the LEI register is public and enumerable, so
 * anyone willing to hash 2.5 million candidates can invert a `lei:` anchor.
 */
export function verifyAnchor(anchor: string, identityRef: string): AssuranceLevel | null {
  if (isUnset(anchor)) return null;
  const normalised = anchor.toLowerCase();
  for (const level of ASSURANCE_LEVELS) {
    if (identityAnchor(level, identityRef).toLowerCase() === normalised) return level;
  }
  return null;
}
