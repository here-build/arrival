// The tsgo (TypeScript 7 wasm) scheme-LS worker entry — the types-first
// artifact: importing this inside a (Shared)Worker hosts the FULL tsgo
// scheme service on its ports, speaking the same ls-protocol as the js-ts
// worker. The wasm asset URL arrives from the app through the connect
// options (`tsgoWasmUrl`) — this file stays bundler-agnostic.
import { installTsgoSchemeLsWorker } from "@here.build/arrival-type-lens/tsgo";

installTsgoSchemeLsWorker();
