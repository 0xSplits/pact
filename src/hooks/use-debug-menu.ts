// React binding for the vanilla debug menu: mounts it once and exposes the
// selected state ("live" outside localhost, where the menu never mounts).
import { useEffect, useRef, useState } from "react";

import { initDebugMenu } from "#lib/ui/debug-menu.ts";
import type { DebugMenuOptions } from "#lib/ui/debug-menu.ts";

export function useDebugMenu(states: DebugMenuOptions["states"]): string {
  const [debugState, setDebugState] = useState("live");
  const debugRef = useRef("live");
  // Mount-once: the menu is built from the first render's states; callers
  // pass fresh inline arrays, so depending on `states` would remount it.
  const statesRef = useRef(states);
  useEffect(() => {
    initDebugMenu({
      states: statesRef.current,
      getState: () => debugRef.current,
      setState: (state) => {
        debugRef.current = state;
        setDebugState(state);
      },
    });
  }, []);
  return debugState;
}
