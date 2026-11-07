/**
 * The API's dependency seam into the dispatcher.
 *
 * One explicit object is the only thing the surface layer receives. Its fields
 * are grouped by capability so a reader can see which part of the dispatcher a
 * caller is reaching into:
 *
 *   brief      render a task/role/test brief
 *   lead       resolve Leads and the caller's roster/registry
 *   roster     role names, slots and constants
 *   workspace  project/worktree/team/session facts
 *   task       stage slots, phase activity, host checks
 *   dispatch   worker pool and interrupts
 */
import * as dispatch from './dispatch.mjs'

export const dispatchPort = {
  brief: {
    briefFor: dispatch.briefFor,
    briefPartsFor: dispatch.briefPartsFor,
    reviewBriefFor: dispatch.reviewBriefFor,
    reworkBriefFor: dispatch.reworkBriefFor,
    roleBriefFor: dispatch.roleBriefFor,
    roleBriefPartsFor: dispatch.roleBriefPartsFor,
    roleContextPreview: dispatch.roleContextPreview,
    roleTemplateValuesFor: dispatch.roleTemplateValuesFor,
    testFailureBriefFor: dispatch.testFailureBriefFor,
    testerBriefFor: dispatch.testerBriefFor,
  },
  lead: {
    resolveLead: dispatch.resolveLead,
    liveLeads: dispatch.liveLeads,
    resolveAnyLead: dispatch.resolveAnyLead,
    agentSessionOf: dispatch.agentSessionOf,
    leadInventory: dispatch.leadInventory,
    leadInventoryText: dispatch.leadInventoryText,
    servicesFor: dispatch.servicesFor,
  },
  roster: {
    MERGER_NAME: dispatch.MERGER_NAME,
    ROLE_SAMPLE_TASK: dispatch.ROLE_SAMPLE_TASK,
    roleShortName: dispatch.roleShortName,
    roleSlotOf: dispatch.roleSlotOf,
    roleKindOf: dispatch.roleKindOf,
  },
  workspace: {
    isTransientEnvironmentCode: dispatch.isTransientEnvironmentCode,
    memberProjectOf: dispatch.memberProjectOf,
    cleanupInvestigationCheckouts: dispatch.cleanupInvestigationCheckouts,
    probeWorktree: dispatch.probeWorktree,
    projectSlotKey: dispatch.projectSlotKey,
    projectTeamState: dispatch.projectTeamState,
    teamBootstrapStep: dispatch.teamBootstrapStep,
    sessionOwnsProject: dispatch.sessionOwnsProject,
    sessionWorkspaceOf: dispatch.sessionWorkspaceOf,
  },
  task: {
    REVIEW_MAX_ROUNDS: dispatch.REVIEW_MAX_ROUNDS,
    hostCheckEvidence: dispatch.hostCheckEvidence,
    runHostCheck: dispatch.runHostCheck,
    recordPhaseActivity: dispatch.recordPhaseActivity,
    recordStageSlot: dispatch.recordStageSlot,
    stageSlotOf: dispatch.stageSlotOf,
  },
  dispatch: {
    interruptAssignee: dispatch.interruptAssignee,
    interruptMemberNamed: dispatch.interruptMemberNamed,
    workerPool: dispatch.workerPool,
  },
}
