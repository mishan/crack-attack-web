/**
 * combo.ts
 *
 * Forward declaration for the combo-tracking type. The real `ComboTabulator`
 * (chain/combo accounting → garbage generation) is ported in Phase 1.5. Until
 * then, Block, Garbage, and Grid reference combos as opaque handles so the data
 * model can be built and tested without the combo machinery.
 */

/**
 * Opaque placeholder for the Phase 1.5 `ComboTabulator`. Kept as an interface
 * (not `unknown`) so references are explicit and easy to find later. The real
 * type will add involvement counting and combo state.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ComboTabulator {}
