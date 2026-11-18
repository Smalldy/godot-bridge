/**
 * The API's dependency seam into the dispatcher.
 *
 * One explicit object is the only thing the surface layer receives. Its fields
 * are grouped by capability so a reader can see which part of the dispatcher a
 * caller is reaching into:
 *
 *   brief      render a task/role/test brief
 *   lead       session identity helpers
 *   roster     the role-profile sample used by previews
 *   workspace  project/worktree/session facts
 *   task       stage slots, phase activity, host checks
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
    agentSessionOf: dispatch.agentSessionOf,
    sessionLastActiveAt: dispatch.sessionLastActiveAt,
  },
  roster: {
    ROLE_SAMPLE_TASK: dispatch.ROLE_SAMPLE_TASK,
  },
  workspace: {
    isTransientEnvironmentCode: dispatch.isTransientEnvironmentCode,
    cleanupInvestigationCheckouts: dispatch.cleanupInvestigationCheckouts,
    probeWorktree: dispatch.probeWorktree,
    sessionOwnsProject: dispatch.sessionOwnsProject,
    sessionWorkspaceOf: dispatch.sessionWorkspaceOf,
  },
  task: {
    REVIEW_MAX_ROUNDS: dispatch.REVIEW_MAX_ROUNDS,
    hostCheckEvidence: dispatch.hostCheckEvidence,
    runHostCheck: dispatch.runHostCheck,
    verifyFingerprintFor: dispatch.verifyFingerprintFor,
    recordPhaseActivity: dispatch.recordPhaseActivity,
    recordStageSlot: dispatch.recordStageSlot,
    stageSlotOf: dispatch.stageSlotOf,
  },
}
