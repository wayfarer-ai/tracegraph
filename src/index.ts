export { loadAtifTrace } from "./trace/atif.js";
export { loadStreamJsonTrace } from "./trace/stream-json.js";
export { loadOtlpTraces, looksLikeOtlp } from "./trace/otlp.js";
export { canonicalTool, type Trace, type ToolEvent } from "./trace/types.js";
export {
  extractFeatures,
  bindingName,
  type Features,
  type FeatureValue,
} from "./synth/features.js";
export {
  induceGuardTree,
  toGuardExpr,
  evalGuard,
  predict,
  type GuardTree,
  type LabeledRow,
} from "./synth/inducer.js";
export { assembleSpec, type AssembleOptions } from "./synth/assemble.js";
export {
  synthesize,
  detectActionTool,
  didAction,
  type SynthesizeOptions,
  type SynthesisResult,
} from "./synth/index.js";
export {
  guardToString,
  clauseToString,
  type TraceGraphSpec,
  type SpecStep,
  type CallStep,
  type GateStep,
  type GuardExpr,
  type GuardClause,
  type InvariantRule,
} from "./spec/types.js";
export { specToYaml, writeSpec, loadSpec, SpecParseError } from "./spec/io.js";
export {
  checkTrace,
  checkTraces,
  type CheckReport,
  type TraceCheckResult,
  type Finding,
  type FindingLevel,
} from "./check/index.js";
export { loadRules, RulesParseError } from "./check/rules.js";
export { diffSpecs, renderDiff, decisionAgreement, type SpecDiff } from "./diff/index.js";
export { SpecGate, type GateDecision, type GateMode } from "./gate/core.js";
export { GateProxy, type GateProxyOptions } from "./gate/proxy.js";
export { clusterByVocabulary, describeClusters } from "./synth/cluster.js";
export { FeatureAccumulator } from "./synth/features.js";
