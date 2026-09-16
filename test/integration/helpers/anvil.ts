/**
 * Re-exports the production Anvil-fork spawner (`src/chain/anvil.ts`) — moved there
 * in the Phase 7 session since the paper executor and daily exit drill need the exact
 * same spawn/wait/stop logic in real (non-test) code, and having two copies would
 * just be a bug waiting to happen. Kept as a re-export, not deleted, so every existing
 * fork test's import path stays unchanged.
 */
export { startAnvilFork, type AnvilFork } from '../../../src/chain/anvil.js';
