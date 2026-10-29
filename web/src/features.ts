// What this Voxa server has turned on (from /api/me), e.g. GIF search needs a GIPHY key.

export interface Features {
  gifs: boolean;
  /** E-mail (confirming an address, password recovery) is set up on the server. */
  email: boolean;
  /** Push notifications to devices where Voxa is closed. */
  push: boolean;
}

let current: Features = { gifs: false, email: false, push: false };

export const getFeatures = () => current;

export function setFeatures(f: Partial<Features> | undefined) {
  current = { ...current, ...f };
}

/** A message that is only a GIF link from GIPHY (what the GIF picker sends) shows as the GIF itself. */
export const GIPHY_MEDIA = /^https:\/\/media\d?\.giphy\.com\/media\/[A-Za-z0-9_/.-]+\.(gif|webp)$/;
