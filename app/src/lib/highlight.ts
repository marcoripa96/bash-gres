import { codeToHtml } from "shiki";

export async function highlight(code: string, lang: string = "typescript") {
  return codeToHtml(code, {
    lang,
    theme: "vitesse-dark",
  });
}
