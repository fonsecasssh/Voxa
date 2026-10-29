// On phones the app shows one thing at a time, like Discord's mobile app: the servers and
// channels, or the conversation. The ☰ button in each header goes back to the list.

import { createContext, useContext } from "react";
import { Icon } from "./Icon.tsx";

export const MobileNavContext = createContext<() => void>(() => {});

/** Only visible on small screens (see styles.css). */
export function MobileNavButton() {
  const openNav = useContext(MobileNavContext);
  return (
    <button type="button" className="mobile-nav-btn" title="Servidores e canais" aria-label="Servidores e canais" onClick={openNav}>
      <Icon name="menu" size={22} />
    </button>
  );
}
