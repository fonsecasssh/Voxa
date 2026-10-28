// GIF search for the chat's GIF picker, through GIPHY. The API key stays on the server
// (GIPHY_API_KEY); the browser only gets the results. Without a key the picker hides its
// GIF tab.

export interface Gif {
  id: string;
  title: string;
  /** Small animated preview for the picker grid. */
  preview: string;
  /** What gets sent in chat (a GIF on GIPHY's media servers). */
  url: string;
  width: number;
  height: number;
}

export interface GifProvider {
  search(query: string, offset: number): Promise<Gif[]>;
  trending(offset: number): Promise<Gif[]>;
}

const PAGE = 24;

interface GiphyImage {
  url?: string;
  webp?: string;
  width?: string;
  height?: string;
}
interface GiphyItem {
  id: string;
  title?: string;
  images: Record<string, GiphyImage | undefined>;
}

export function createGiphyProvider(apiKey: string, fetchImpl: typeof fetch = fetch): GifProvider {
  const call = async (path: string, params: Record<string, string>): Promise<Gif[]> => {
    const q = new URLSearchParams({ api_key: apiKey, limit: String(PAGE), rating: "pg-13", lang: "pt", ...params });
    const res = await fetchImpl(`https://api.giphy.com/v1/gifs/${path}?${q}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`GIPHY ${res.status}`);
    const body = (await res.json()) as { data: GiphyItem[] };
    return body.data.flatMap((g) => {
      const send = g.images.downsized ?? g.images.original;
      const small = g.images.fixed_width_small ?? g.images.fixed_width ?? send;
      if (!send?.url || !small) return [];
      return [
        {
          id: g.id,
          title: g.title ?? "",
          preview: small.webp ?? small.url ?? send.url,
          url: send.url.split("?")[0],
          width: Number(send.width) || 0,
          height: Number(send.height) || 0,
        },
      ];
    });
  };
  return {
    search: (query, offset) => call("search", { q: query, offset: String(offset) }),
    trending: (offset) => call("trending", { offset: String(offset) }),
  };
}
