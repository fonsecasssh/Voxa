// Previews of the links in a message: a card with the site, title, description and
// picture; YouTube videos play right there when clicked (from youtube-nocookie.com).

import { useState } from "react";
import type { LinkEmbed } from "../api.ts";

function YouTube({ e }: { e: LinkEmbed }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="embed-media youtube">
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${e.youtubeId}?autoplay=1`}
          title={e.title ?? "YouTube"}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <button type="button" className="embed-play" aria-label={`Assistir ${e.title ?? "vídeo"}`} onClick={() => setPlaying(true)}>
          <img src={e.image!} alt="" loading="lazy" />
          <span className="embed-play-icon" aria-hidden="true">
            ▶
          </span>
        </button>
      )}
    </div>
  );
}

export function LinkEmbeds({ embeds }: { embeds: LinkEmbed[] }) {
  if (!embeds.length) return null;
  return (
    <div className="embeds">
      {embeds.map((e) =>
        e.kind === "image" ? (
          <a key={e.url} className="embed-image" href={e.url} target="_blank" rel="noopener noreferrer nofollow ugc">
            <img src={e.image!} alt="" loading="lazy" />
          </a>
        ) : (
          <div key={e.url} className="embed" style={{ borderLeftColor: e.color ?? undefined }}>
            {e.siteName && <span className="embed-site">{e.siteName}</span>}
            {e.title && (
              <a className="embed-title" href={e.url} target="_blank" rel="noopener noreferrer nofollow ugc">
                {e.title}
              </a>
            )}
            {e.description && <p className="embed-desc">{e.description}</p>}
            {e.kind === "youtube" ? (
              <YouTube e={e} />
            ) : (
              e.image && (
                <a className="embed-media" href={e.url} target="_blank" rel="noopener noreferrer nofollow ugc" tabIndex={-1}>
                  <img src={e.image} alt="" loading="lazy" />
                </a>
              )
            )}
          </div>
        ),
      )}
    </div>
  );
}
