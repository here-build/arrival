// inference-env.ts — STAGE C CUT 3b: the retired `user_env`-child inference-plane env is now a
// resolver-capable ROOT frame carrying the SAME self-hosted `BASE_ROSTER` vocabulary every bare
// `exec()` shares (env/vocabulary.ts's memoized `buildVocabulary`), instead of a live child of the
// retired `user_env`/`global_env` realm singletons.
//
// This is the "live inheritable base" internal callers `mintFrame(inferenceEnv, name)` a child
// off, bind test-only rosettas onto, and evaluate through `execStateOverFrame`/`execOverFrame`/
// `execExprOverFrame` (eval/generator-exec.ts's internal, non-`ExecOptions` live-frame seam — the
// retired public glass option's narrow replacement for a caller that already holds a real frame
// rather than a declarative capability set). NOT barrel-exported (the identity boundary holds
// internally, same posture as before this cut).
//
// POPULATION IS LAZY, mirroring the retired realm bootstrap's own "empty at mint, filled before
// first genuine use" contract: `mintFrame(inferenceEnv, …)` at test setup is always safe (a frame
// mint is a cheap `__parent__` assignment, not a snapshot read) because nothing walks the parent
// chain until an actual eval call, and every eval entry point that might touch this frame awaits
// `ensureInferenceEnvPopulated` first (generator-exec.ts's `*OverFrame` family).
import { mintResolvingFrame, type ResolvingAmbient } from "./AmbientRuntime.js";

export const inferenceEnv: ResolvingAmbient = mintResolvingFrame("inference");
