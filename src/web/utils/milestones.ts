/**
 * Re-export milestone utilities from core for backward compatibility
 * All business logic lives in src/core/milestones.ts
 */
export {
	buildMilestoneAliasMap,
	buildMilestoneBuckets,
	buildMilestoneSummary,
	canonicalizeMilestoneValue,
	collectArchivedMilestoneKeys,
	collectMilestoneIds,
	getMilestoneLabel,
	isDoneStatus,
	milestoneKey,
	normalizeMilestoneName,
	resolveMilestoneInput,
	validateMilestoneName,
} from "../../core/milestones.ts";

// Re-export types from core types
export type { MilestoneBucket, MilestoneSummary } from "../../types/index.ts";
