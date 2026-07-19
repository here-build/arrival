// arrival-env-capability-approval — human-in-the-loop approval gate pack.
export {
  APPROVAL_FORM,
  ApprovalRejected,
  defineApprovalRosetta,
  FunctionRunApprovalReject,
  FunctionRunApprovalRequest,
  FunctionRunApprovalResult,
  type OnApprovalRequest,
  type ResolveApproval,
  runApproval,
} from "./approval.js";
export {
  arrivalSuperDefineCapability,
  arrivalSuperDefineCapability as arrivalApprovalCapability,
} from "./capability.js";
