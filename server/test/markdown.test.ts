import { describe, expect, it } from "vitest";
import { findMentions, parseMarkdown, type MdNode } from "../../shared/markdown.ts";

/** A compact text form of the tree, to keep the expectations readable. */
function show(nodes: MdNode[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return n.v;
        case "code":
          return `<code>${n.v}</code>`;
        case "codeblock":
          return `<pre${n.lang ? ` ${n.lang}` : ""}>${n.v}</pre>`;
        case "link":
          return `<a ${n.href}>${n.text}</a>`;
        case "mention":
          return `<@${n.name}>`;
        default:
          return `<${n.t}>${show(n.c)}</${n.t}>`;
      }
    })
    .join("");
}
const md = (s: string) => show(parseMarkdown(s));

describe("parseMarkdown", () => {
  it("formats bold, italic, underline, strike, spoiler and code", () => {
    expect(md("**forte** *ital* _ital_ __sub__ ~~ris~~ ||segredo|| `x = 1`")).toBe(
      "<b>forte</b> <i>ital</i> <i>ital</i> <u>sub</u> <s>ris</s> <spoiler>segredo</spoiler> <code>x = 1</code>",
    );
    expect(md("**negrito com *itálico* dentro**")).toBe("<b>negrito com <i>itálico</i> dentro</b>");
  });

  it("leaves lone symbols, snake_case and math alone", () => {
    expect(md("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(md("minha_variavel_legal")).toBe("minha_variavel_legal");
    expect(md("só um * e um _")).toBe("só um * e um _");
  });

  it("keeps links whole even with _ or * inside, and formats around them", () => {
    expect(md("veja https://exemplo.com/a_b_c e **https://x.com/y**")).toBe(
      "veja <a https://exemplo.com/a_b_c>https://exemplo.com/a_b_c</a> e <b><a https://x.com/y>https://x.com/y</a></b>",
    );
  });

  it("does nothing inside code", () => {
    expect(md("```js\nconst a = **b** @ana\n```")).toBe("<pre js>const a = **b** @ana</pre>");
    expect(md("`**não**`")).toBe("<code>**não**</code>");
  });

  it("turns '> ' lines into quotes", () => {
    expect(md("> citado\n> de novo\nresposta")).toBe("<quote>citado\nde novo</quote>resposta");
  });

  it("finds mentions but not e-mails", () => {
    expect(md("oi @ana_b e @everyone, fale com x@email.com")).toBe("oi <@ana_b> e <@everyone>, fale com x@email.com");
  });
});

describe("findMentions", () => {
  it("lists usernames once, flags @everyone, ignores code", () => {
    expect(findMentions("@Ana @ana @beto. `@carla` ```@dani```")).toEqual({ usernames: ["ana", "beto"], everyone: false });
    expect(findMentions("bora @everyone")).toEqual({ usernames: [], everyone: true });
  });
});
