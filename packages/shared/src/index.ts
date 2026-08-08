/** Public surface of the shared package. Host, client and tests all import this. */

export * from './math/rng.ts';
export * from './math/vec2.ts';

export * from './config/units.ts';
export * from './config/match.ts';
export * from './config/modes.ts';
export * from './config/battleMods.ts';
export * from './config/map.ts';
export * from './config/maps.ts';
export * from './config/arenaData.ts';

export * from './sim/entities.ts';
export * from './sim/auras.ts';
export * from './sim/summons.ts';
export * from './sim/mapgen.ts';
export * from './sim/formation.ts';
export * from './sim/combat.ts';
export * from './sim/fusion.ts';
export * from './sim/spawning.ts';
export * from './sim/world.ts';
export * from './sim/bots.ts';

export * from './protocol/messages.ts';
export * from './net/room.ts';
