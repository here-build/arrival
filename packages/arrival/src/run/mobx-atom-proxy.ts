/**
 * MobX-backed {@link AtomProxy} (Phase 5 R1).
 *
 * Internal only — not a public FRP surface. Hosts that want MobX install this
 * behind {@link ProxyPathAtomBus}; product law never asserts MobX API.
 *
 * Optional peer: `mobx` must be resolvable at the call site (arrival lists it as
 * an optional peerDependency; tests pull it via devDependency).
 */

import { createAtom } from "mobx";
import type { AtomProxy } from "./atom-proxy.js";

export function createMobxAtomProxy(): AtomProxy {
  return {
    atom(key: string) {
      const a = createAtom(`arrival:path:${key}`);
      return {
        reportObserved: () => {
          a.reportObserved();
        },
        reportChanged: () => {
          a.reportChanged();
        },
      };
    },
  };
}
