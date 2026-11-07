/**
 * The API's dependency seam into the dispatcher.
 *
 * Before this module, api.mjs imported ~40 symbols directly from dispatch.mjs,
 * which made the surface layer depend on the scheduler/role/brief internals and
 * dragged the whole dispatcher into API tests. This port names the capability
 * the API is allowed to use. It is a re-export today; the next step is to replace
 * the individual functions with a narrow interface (brief/lead/roster/workspace)
 * behind the same names.
 */
export {
  MERGER_NAME,
  REVIEW_MAX_ROUNDS,
  ROLE_SAMPLE_TASK,
  briefFor,
  briefPartsFor,
  hostCheckEvidence,
  interruptAssignee,
  interruptMemberNamed,
  isTransientEnvironmentCode,
  leadInventory,
  leadInventoryText,
  memberProjectOf,
  cleanupInvestigationCheckouts,
  probeWorktree,
  projectSlotKey,
  projectTeamState,
  roleShortName,
  roleSlotOf,
  resolveLead,
  liveLeads,
  resolveAnyLead,
  agentSessionOf,
  reviewBriefFor,
  reworkBriefFor,
  roleBriefFor,
  roleBriefPartsFor,
  roleContextPreview,
  roleKindOf,
  roleTemplateValuesFor,
  runHostCheck,
  teamBootstrapStep,
  sessionOwnsProject,
  sessionWorkspaceOf,
  recordPhaseActivity,
  recordStageSlot,
  stageSlotOf,
  servicesFor,
  testFailureBriefFor,
  testerBriefFor,
  workerPool,
} from './dispatch.mjs'
