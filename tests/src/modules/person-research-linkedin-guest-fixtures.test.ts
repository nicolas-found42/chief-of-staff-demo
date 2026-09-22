import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import { readPersonSource } from "../../../apps/server/src/person-profile/research-readers.js";

/* Five fictional guest-page shapes modelled on the public DOM in
 * aadisriram/nodejs-linkedin-scraper's five captured fixtures (c0e2688).
 * The captures themselves contain real members' content and are not copied. */
const url = "https://www.linkedin.com/in/maya-okafor";
const cases = [
  {
    name: "top card and summary",
    html: `<h1 class="top-card-layout__title">Maya Okafor</h1><div class="top-card-layout__headline">Sensor Lead</div>
      <section data-section="summary"><div class="core-section-container__content"><p>Builds coastal sensors.</p></div></section>`,
    expected: [
      "Public profile name: Maya Okafor",
      "Headline: Sensor Lead",
      "Summary: Builds coastal sensors.",
    ],
  },
  {
    name: "metadata name and heading fallback",
    html: `<meta property="og:title" content="Maya Okafor - Sensor Lead | LinkedIn"><section data-section="experience">
      <li class="experience-item"><h3>Sensor Lead</h3><h4>Coastal Observatory</h4><span class="date-range">2020 - Present</span></li></section>`,
    expected: [
      "Public profile name: Maya Okafor",
      "Headline: Sensor Lead",
      "Experience: Sensor Lead | Coastal Observatory | 2020 - Present",
    ],
  },
  {
    name: "school image before its heading",
    html: `<h1>Maya Okafor</h1><section data-section="educationsDetails"><ul class="education__list">
      <li class="education__list-item"><a href="/school/freetown"><img alt="School logo"></a>
      <h3>Freetown University</h3><h4>MSc, Oceanography</h4><span class="date-range">2016 - 2018</span></li></ul></section>`,
    expected: ["Education: Freetown University | MSc, Oceanography | 2016 - 2018"],
  },
  {
    name: "redacted experience title beside a visible one",
    html: `<h1>Maya Okafor</h1><section data-section="experience"><ul>
      <li class="experience-item"><span class="experience-item__title blur">********</span><span class="experience-item__subtitle">Hidden Institute</span></li>
      <li class="experience-item"><span class="experience-item__title">Researcher</span><span class="experience-item__subtitle">Coastal Observatory</span></li>
      </ul></section>`,
    expected: ["Experience: Researcher | Coastal Observatory"],
    absent: ["********", "Experience: Hidden Institute"],
    limitation: true,
  },
  {
    name: "a post card with a repeated link",
    html: `<h1>Maya Okafor</h1><section data-section="posts"><div class="profile-activity-card"><div class="base-card">
      <a href="/posts/maya-okafor_sensor-data-activity-7487189920416108544-x"><span class="sr-only">Maya shared this</span></a>
      <div class="see-more-text">A better way to share sensor data.</div>
      <a href="/posts/maya-okafor_sensor-data-activity-7487189920416108544-x">public_profile__posts</a>
      </div></div></section>`,
    expected: [
      "Post listed by Maya Okafor",
      "Text: A better way to share sensor data.",
      "Date (decoded from activity ID): 2026-07-26T16:59:42.289Z",
      "URL: https://www.linkedin.com/posts/maya-okafor_sensor-data-activity-7487189920416108544-x",
    ],
    postCount: 1,
  },
] as const;

test.each(cases)("a fictional LinkedIn guest fixture retains $name", async (fixture) => {
  const recorder = new ResearchAttemptRecorder(
    "guest-fixture",
    () => new Date("2026-09-22T12:00:00Z"),
  );
  const result = await readPersonSource(
    url,
    "",
    fromPartial({
      recorder,
      timeoutMs: 1000,
      fetch: async () => ({
        url,
        status: 200,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: `<html><head><title>Public profile</title></head><body>${fixture.html}</body></html>`,
      }),
    }),
  );
  expect(result.access).toBe("retrieved");
  for (const line of fixture.expected) expect(result.text).toContain(line);
  if ("absent" in fixture)
    for (const line of fixture.absent) expect(result.text).not.toContain(line);
  if ("limitation" in fixture) expect(result.provenanceNote).toContain("redacted");
  if ("postCount" in fixture)
    expect(result.text.match(/^Post listed by /gm)).toHaveLength(fixture.postCount);
});
