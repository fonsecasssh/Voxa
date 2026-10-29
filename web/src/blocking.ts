// Who you blocked, for components deep in the tree (member card, friends list).

import { createContext, useContext } from "react";

export const BlockedContext = createContext<Set<string>>(new Set());
export const useBlocked = () => useContext(BlockedContext);
