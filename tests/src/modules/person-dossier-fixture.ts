import {
  PersonDossierStore,
  synthesizeSections,
} from "../../../apps/server/src/person-profile/dossier-store.js";

/** Give unrelated dossier tests a valid published account for their claims. */
export function publishCanonicalDossier(
  dossiers: PersonDossierStore,
  profileId: string,
  revision: number,
  content: Omit<Parameters<PersonDossierStore["publish"]>[2], "sections">,
) {
  return dossiers.publish(profileId, revision, {
    ...content,
    sections: synthesizeSections(content.claims),
  });
}
