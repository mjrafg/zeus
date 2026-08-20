/**
 * The harness speaks the runner's vocabulary.
 *
 * The types live in src/selfaudit because the runner ships with the product,
 * while these probes are repository-local. Re-exporting keeps one definition.
 */
export * from '../../src/selfaudit/types';
