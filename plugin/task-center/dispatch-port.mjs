/**
 * The API's dependency seam into the dispatcher.
 *
 * One explicit object is the only thing the surface layer receives. The fields
 * are still flat today (the dispatcher is large); grouping them into
 * brief/lead/roster/workspace capabilities is the next step, not a reason to
 * let api.mjs import dispatch.mjs directly.
 */
import * as dispatch from './dispatch.mjs'

export const dispatchPort = {
  MERGER_NAME: dispatch.MERGER_NAME,
  REVIEW_MAX_ROUNDS: dispatch.REVIEW_MAX_ROUNDS,
  ROLE_SAMPLE_TASK: dispatch.ROLE_SAMPLE_TASK,
  briefFor: dispatch.briefFor,
  briefPartsFor: dispatch.briefPartsFor,
  hostCheckEvidence: dispatch.hostCheckEvidence,
  interruptAssignee: dispatch.interruptAssignee,
  interruptMemberNamed: dispatch.interruptMemberNamed,
  isTransientEnvironmentCode: dispatch.isTransientEnvironmentCode,
  leadInventory: dispatch.leadInventory,
  leadInventoryText: dispatch.leadInventoryText,
  memberProjectOf: dispatch.memberProjectOf,
  cleanupInvestigationCheckouts: dispatch.cleanupInvestigationCheckouts,
  probeWorktree: dispatch.probeWorktree,
  projectSlotKey: dispatch.projectSlotKey,
  projectTeamState: dispatch.projectTeamState,
  roleShortName: dispatch.roleShortName,
  roleSlotOf: dispatch.roleSlotOf,
  resolveLead: dispatch.resolveLead,
  liveLeads: dispatch.liveLeads,
  resolveAnyLead: dispatch.resolveAnyLead,
  agentSessionOf: dispatch.agentSessionOf,
  reviewBriefFor: dispatch.reviewBriefFor,
  reworkBriefFor: dispatch.reworkBriefFor,
  roleBriefFor: dispatch.roleBriefFor,
  roleBriefPartsFor: dispatch.roleBriefPartsFor,
  roleContextPreview: dispatch.roleContextPreview,
  roleKindOf: dispatch.roleKindOf,
  roleTemplateValuesFor: dispatch.roleTemplateValuesFor,
  runHostCheck: dispatch.runHostCheck,
  teamBootstrapStep: dispatch.teamBootstrapStep,
  sessionOwnsProject: dispatch.sessionOwnsProject,
  sessionWorkspaceOf: dispatch.sessionWorkspaceOf,
  recordPhaseActivity: dispatch.recordPhaseActivity,
  recordStageSlot: dispatch.recordStageSlot,
  stageSlotOf: dispatch.stageSlotOf,
  servicesFor: dispatch.servicesFor,
  testFailureBriefFor: dispatch.testFailureBriefFor,
  testerBriefFor: dispatch.testerBriefFor,
  workerPool: dispatch.workerPool,
}
