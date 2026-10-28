import { describe, expect, it } from "vitest";
import { splitLinks } from "../../shared/links.ts";

const links = (s: string) => splitLinks(s).flatMap((p) => (p.type === "link" ? [[p.text, p.href]] : []));

describe("splitLinks", () => {
  it("keeps plain text as a single part", () => {
    expect(splitLinks("oi, tudo bem?")).toEqual([{ type: "text", text: "oi, tudo bem?" }]);
  });

  it("finds http(s) and www links in the middle of text", () => {
    expect(splitLinks("olha https://youtube.com/watch?v=abc&t=10 que top")).toEqual([
      { type: "text", text: "olha " },
      { type: "link", text: "https://youtube.com/watch?v=abc&t=10", href: "https://youtube.com/watch?v=abc&t=10" },
      { type: "text", text: " que top" },
    ]);
    expect(links("entra em www.exemplo.com.br/pagina")).toEqual([["www.exemplo.com.br/pagina", "https://www.exemplo.com.br/pagina"]]);
  });

  it("leaves sentence punctuation and unbalanced brackets out of the link", () => {
    expect(links("veja https://a.com/x.")).toEqual([["https://a.com/x", "https://a.com/x"]]);
    expect(links("(link: https://a.com/y)!")).toEqual([["https://a.com/y", "https://a.com/y"]]);
    expect(links("https://pt.wikipedia.org/wiki/Counter-Strike_(série)")[0]?.[0]).toBe("https://pt.wikipedia.org/wiki/Counter-Strike_(série)");
  });

  it("finds several links", () => {
    expect(links("https://a.com e http://b.org/c")).toEqual([
      ["https://a.com", "https://a.com/"],
      ["http://b.org/c", "http://b.org/c"],
    ]);
  });

  it("never links other schemes or bare hosts", () => {
    expect(links("javascript:alert(1) data:text/html,x https://intranet")).toEqual([]);
  });
});
