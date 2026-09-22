import { load } from "cheerio";
import { linkedInActivityDate, linkedInProfileIdentity } from "./linkedin-articles.js";

/* Selector set adapted from aadisriram/nodejs-linkedin-scraper at c0e2688
 * (src/parse/{top-card,experience,education,sections}.ts).
 * The MIT License (MIT), Copyright (c) 2015 Aaditya Sriram.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE. */

export function linkedInGuestProfile(
  html: string,
  url: string,
): {
  text: string;
  redactedTitles: number;
} {
  if (!linkedInProfileIdentity(url)) return { text: "", redactedTitles: 0 };
  const $ = load(html);
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const field = ($root: ReturnType<typeof $>, selector: string) =>
    clean($root.find(selector).first().text());
  const lines: string[] = [];
  const ogTitle = $("meta[property='og:title']").attr("content") ?? "";
  const name =
    clean($(".top-card-layout__title, h1").first().text()) || clean(ogTitle.split(" - ")[0] ?? "");
  if (name) lines.push(`Public profile name: ${name}`);
  const headline =
    clean($(".top-card-layout__headline").first().text()) ||
    clean(
      ogTitle
        .split(" - ")
        .slice(1)
        .join(" - ")
        .replace(/\s*\|\s*LinkedIn\s*$/i, ""),
    );
  if (headline) lines.push(`Headline: ${headline}`);
  const location = clean(
    $(".profile-info-subheader > span, .top-card__subline-item").first().text(),
  );
  if (location) lines.push(`Location: ${location}`);
  const summary = field(
    $("[data-section='summary']"),
    ".core-section-container__content p, .core-section-container__content",
  );
  if (summary && !/^about$/i.test(summary)) lines.push(`Summary: ${summary}`);
  let redactedTitles = 0;
  $("section[data-section='experience'] li.experience-item, li.experience-item").each(
    (_, element) => {
      const item = $(element);
      const titleNode = item.find(".experience-item__title, h3").first();
      const title = clean(titleNode.text());
      if (titleNode.is(".blur, .blurred") || /^\*+$/.test(title.replace(/\s/g, ""))) {
        redactedTitles++;
        return;
      }
      const company = field(item, ".experience-item__subtitle, h4");
      const dates = field(item, ".date-range");
      const place = field(
        item,
        ".experience-item__meta-item .location, span.location, .experience-item__location",
      );
      if (title || company)
        lines.push(`Experience: ${[title, company, dates, place].filter(Boolean).join(" | ")}`);
    },
  );
  $("li.education__list-item").each((_, element) => {
    const item = $(element);
    const schoolNode = item.find("h3").first().length
      ? item.find("h3").first()
      : item.find("a[href*='/school/']").first();
    const school = clean(schoolNode.text());
    if (schoolNode.is(".blur, .blurred") || /^\*+$/.test(school.replace(/\s/g, ""))) return;
    const degree = field(item, "h4");
    const dates = field(item, ".date-range");
    if (school) lines.push(`Education: ${[school, degree, dates].filter(Boolean).join(" | ")}`);
  });
  const seenPosts = new Set<string>();
  $("[data-section='posts'] a[href*='/posts/']").each((_, element) => {
    if (seenPosts.size >= 10) return;
    const link = $(element);
    const title =
      clean(link.closest(".base-card").find(".see-more-text").first().text()) || clean(link.text());
    const href = link.attr("href");
    if (!title || !href || !name) return;
    try {
      const target = new URL(href, url);
      if (!/(^|\.)linkedin\.com$/i.test(target.hostname) || !target.pathname.startsWith("/posts/"))
        return;
      target.search = "";
      target.hash = "";
      if (seenPosts.has(target.href)) return;
      seenPosts.add(target.href);
      const date = linkedInActivityDate(target.href);
      lines.push(
        `Post listed by ${name}\nText: ${title}${date ? `\nDate (decoded from activity ID): ${date}` : ""}\nURL: ${target.href}`,
      );
    } catch {
      return;
    }
  });
  return { text: lines.join("\n"), redactedTitles };
}
