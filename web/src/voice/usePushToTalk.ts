// Push-to-talk input: holds the mic open while the chosen key or mouse button is down.
// In the desktop app (0.3.0+) a global hook sees the key even while a game has focus;
// otherwise it works while Voxa has focus.

import { useEffect } from "react";
import { desktop } from "../desktop.ts";
import { useAudioSettings } from "./useAudioSettings.ts";
import type { VoiceClient } from "./VoiceClient.ts";
import type { PttBinding } from "./audioSettings.ts";

/** Typing a letter in a text box isn't talking; Ctrl, F-keys, mouse buttons still are. */
function typingIn(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  const editable = !!t && (t.isContentEditable || t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox"));
  return editable && e.key.length === 1;
}

/** Browser back/forward on mouse 4/5 would leave the page: those buttons are push-to-talk here. */
function isNavButton(button: number) {
  return button === 3 || button === 4;
}

function listenInPage(binding: PttBinding, onChange: (down: boolean) => void) {
  const key = (down: boolean) => (e: KeyboardEvent) => {
    if (binding.type !== "key" || e.code !== binding.code || e.repeat) return;
    if (down && typingIn(e)) return;
    onChange(down);
  };
  const mouse = (down: boolean) => (e: MouseEvent) => {
    if (binding.type !== "mouse" || e.button !== binding.button) return;
    if (isNavButton(e.button)) e.preventDefault();
    onChange(down);
  };
  const keydown = key(true);
  const keyup = key(false);
  const mousedown = mouse(true);
  const mouseup = mouse(false);
  const blur = () => onChange(false);
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("keyup", keyup, true);
  window.addEventListener("mousedown", mousedown, true);
  window.addEventListener("mouseup", mouseup, true);
  window.addEventListener("blur", blur);
  return () => {
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("keyup", keyup, true);
    window.removeEventListener("mousedown", mousedown, true);
    window.removeEventListener("mouseup", mouseup, true);
    window.removeEventListener("blur", blur);
  };
}

export function usePushToTalk(voice: VoiceClient | null) {
  const { inputMode, pttBinding } = useAudioSettings();
  const bindingKey = JSON.stringify(pttBinding);

  useEffect(() => {
    if (!voice || inputMode !== "ptt") return;
    const binding = JSON.parse(bindingKey) as PttBinding;
    const onChange = (down: boolean) => voice.setPushToTalk(down);
    let stop = () => {};
    let done = false;
    const pageOnly = () => {
      if (!done) stop = listenInPage(binding, onChange);
    };
    if (desktop?.ptt) {
      const { type } = binding;
      desktop.ptt
        .set(type === "key" ? { type, code: binding.code } : binding)
        .then((global) => {
          if (done) return;
          if (!global) return pageOnly();
          const off = desktop!.ptt!.onState(onChange);
          // Mouse 4/5 would still navigate the page while Voxa has focus.
          const nav = (e: MouseEvent) => isNavButton(e.button) && e.preventDefault();
          window.addEventListener("mouseup", nav, true);
          stop = () => {
            off();
            window.removeEventListener("mouseup", nav, true);
          };
        })
        .catch(pageOnly);
    } else {
      pageOnly();
    }
    return () => {
      done = true;
      stop();
      desktop?.ptt?.set(null).catch(() => {});
      voice.setPushToTalk(false);
    };
  }, [voice, inputMode, bindingKey]);
}
